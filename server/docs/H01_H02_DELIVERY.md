# H-01 / H-02：服务端基础工程与交付记录

**任务 ID：** H-01（Node/SQLite 初始化、配置校验、health endpoint）、H-02（DB migrations、事务、SQLite WAL、备份恢复）
**执行日期：** 2026-10-14
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / npm 11.19.0 / Fastify 5.12.7
**证据等级：** **L**（单电脑真实进程、真实 SQLite 文件、真实 HTTP 请求）。无 N 级（双机）结论。

---

## H-01：配置校验、数据库打开、健康检查

### 新增文件

| 文件 | 作用 |
|---|---|
| `server/package.json` | 包定义；`engines.node >= 24`；依赖 Fastify；`bin.hub` 指向运维 CLI |
| `server/src/index.js` | 唯一 Hub 进程入口；启动顺序：配置 → 数据库 → 迁移 → 监听 |
| `server/src/config/index.js` | 环境变量读取与严格校验，**一次性收集全部问题**，返回冻结对象 |
| `server/src/db/index.js` | SQLite 打开、WAL 建立与**回读验证**、就绪写探针、`hub_meta` |
| `server/src/server.js` | Fastify 实例、统一 JSON 错误、liveness/readiness 路由 |
| `server/src/api/index.js` | 路由插件注册表（后续模块挂载点） |
| `server/src/version.js` | 版本与协议版本 `wg.v1` |
| `server/tests/h01-bootstrap.test.js` | 12 个测试 |

### 关键设计决定与真实依据

1. **`HUB_PORT=0` 被接受**（范围 `0..65535`）。端口 0 让操作系统分配空闲端口，是被测环境下启动测试与端口冲突时的正当用法。原始范围 `1..65535` 会使该方案不可用。

2. **WAL 只在事务外设置，并回读验证。**
   实测：`PRAGMA journal_mode = WAL` 在事务内**不会静默生效却报告成功**——若目标模式不同，SQLite 直接报错 `cannot change into wal mode from within a transaction`；若模式相同则接受但不改变任何东西（见 `h02` 测试）。因此 `openDatabase` 在事务外设置，并读取 `PRAGMA journal_mode` 确认结果。
   若数据库所在文件系统不支持 WAL（部分网络挂载），启动即失败，而不是"以为开了 WAL 其实没有"。

3. **外键强制被验证而非假定。** `PRAGMA foreign_keys` 是每连接设置且事务内无效；打开后回读确认值为 1，否则拒绝启动。真实效果已被证实：H-02 演练中 `DELETE FROM users` 因外键约束而失败（`FOREIGN KEY constraint failed`）。

4. **签名密钥绝不进入配置对象。** `loadConfig` 返回冻结对象且经过 `JSON.stringify` 断言不含密钥；密钥只能通过 `readTokenSigningKey()` 取得。生产环境要求密钥存在且 ≥ 32 字符。

5. **readiness 在数据库不可写时返回 503（不是 500）**，让编排器重启而不是判定探针本身损坏。所有检查（写探针、启动时间、journal 模式）都在同一 guard 内完成。

### 真实执行证据

```
$ node src/index.js            # NODE_ENV=development HUB_PORT=18443
{"level":30,...,"msg":"Server listening at http://127.0.0.1:18443"}
{"level":30,"version":"0.1.0","protocol":"wg.v1","node":"26.7.0","dataDir":"...","tls":"off ...","msg":"Workgroup AI Hub is listening"}

$ curl /api/v1/health/live      → HTTP 200 {"status":"ok","service":"workgroup-ai-hub","version":"0.1.0","protocol":"wg.v1","uptimeSeconds":3}
$ curl /api/v1/health/ready     → HTTP 200 {"status":"ready","checks":{"database":{"checkedAt":"..."},"startedAt":"...","journalMode":"wal"}}
$ curl /api/v1/nope             → HTTP 404 {"error":{"code":"NOT_FOUND","message":"No Hub route for GET /api/v1/nope"}}
```
进程在 `SIGTERM` 后干净退出（`SHUTDOWN_CLEAN`）。

测试：**12 / 12 通过**（`node --test tests/*.test.js`，退出码 0）。

---

## H-02：迁移、事务、WAL、备份恢复

### 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/db/migrate.js` | 前向迁移执行器：每迁移一个事务，版本台账，pragma 清理 |
| `server/src/db/backup.js` | 基于 SQLite 在线备份 API 的快照、校验、恢复 |
| `server/src/cli/hub.js` | 运维命令：`migrate` / `backup` / `restore` / `verify` / `status` |
| `server/tests/h02-database.test.js` | 23 个测试 |

### 真实发现并修复的三个缺陷（开发过程中被测试暴露）

1. **迁移文件里的 `PRAGMA journal_mode = WAL` 与 `PRAGMA foreign_keys = ON` 靠不住。**
   原 `0001_schema.sql` 顶部两行 pragma 在事务内不起作用（见上文实测）。执行器现在**剥离这两行并在日志中报告**，同时 `openDatabase` 在事务外负责建立它们。
   这也是为什么没有直接改写 `0001_schema.sql`：它保持可读的原始形态，执行器负责正确性。

2. **备份快照原先带 `-wal` / `-shm` 附属文件，不是自包含的。**
   `backup()` 按源库的 journal 模式写出目标，所以快照目录里出现 3 个文件。
   运维现实是"把备份文件拷到另一台机器"——只拷 `.sqlite` 会**静默丢掉还留在 WAL 里的全部提交**。
   修复：备份后对快照执行 `wal_checkpoint(TRUNCATE)` 并切到 DELETE 模式，使每个快照是单一自包含文件。已在真实演练中确认备份目录只剩 `.sqlite` 与 `.manifest.json`。

3. **同一毫秒内的两次备份会互相覆盖。**
   `backup()` 拒绝覆盖已存在的文件，使第二次备份**抛出异常**。修复：文件名加入随机短后缀，并保留时间戳，已用测试固定该行为。

另有一处代码冗余被移除：原先的"迁移版本必须递增"检查**不可达**——4 位零填充使字典序与版本序一致。替换为真正可达且更重要的检查：**台账中存在本发行版不包含的迁移时拒绝运行**（防止用旧版 Hub 打开新版数据库并把 schema 弄成任何发行版都未发布过的样子）。

### 迁移执行器的正确性保证（均有测试）

- 每个迁移的 schema 语句与它的台账行**在同一事务内提交**，崩溃不会留下"已记录但未应用"。
- 迁移抛错时整条回滚且不记录台账（测试注入了一个中途失败的迁移，断言其建的表不存在、前一个迁移仍生效）。
- 重复迁移幂等：第二次运行 `applied=[]`、`skipped=['0001_schema.sql']`，台账逐字节不变。
- 台账出现本包不包含的迁移时拒绝运行，且不回滚、不应用任何东西。
- 迁移文件名必须形如 `0001_name.sql`；版本重复被拒绝。

### 备份 / 恢复的正确性保证（均有测试）

- 备份用 SQLite **在线备份 API**（`node:sqlite` 的 `backup`），不是文件拷贝。文件拷贝会读到撕裂状态：`-wal` 里的已提交页尚未并入主文件，两个文件在不同瞬间被拷贝会丢失或重复数据。
- 每个备份在写入后立即自查完整性；不通过的文件**改名隔离**（`.failed`）而不是留在备份目录里冒充可用备份。
- 校验包含 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、台账存在性与非空。
- **恢复拒绝在 Hub 仍运行时执行**：检测到其他连接持有写事务时明确报错 `Stop the Hub first.`。运行中的进程会继续向被替换的 inode 提交，运维却以为恢复已生效。
- 恢复前保留 `hub.sqlite.pre-restore-<时间戳>` 安全副本；WAL 附属文件**移动保存**而不是删除，便于事后排查。
- 恢复前先对候选文件做完整校验，不通过则直接拒绝且不动现有数据库。

### 真实执行证据（server-only 独立目录，不含任何 application 内容）

```
$ node src/cli/hub.js migrate
migration 0001_schema.sql: removed transaction-unsafe pragma(s): journal_mode, foreign_keys
migration 0001_schema.sql: applied
Applied 1 migration(s): 0001_schema.sql

$ node src/cli/hub.js migrate          # 二次运行
Schema is current: 1 migration(s) already applied.

$ node src/cli/hub.js status
version:   0.1.0
protocol:  wg.v1
node:      26.7.0
journal:   wal
migrations: 1 applied, current=true
write probe: ok at 2026-10-14T15:54:57.062Z

$ node src/cli/hub.js verify
...\hub.sqlite: ok
  migrations: 1
  tables: 17
```

**备份 → 故障注入 → 恢复 完整演练：**

```
# 写入真实数据
seeded: users=2 rooms=1 messages=1

# 备份
Wrote .../ops-2026-10-14T15-55-02-552Z-16f1f06f.sqlite
  bytes: 188416, pages: 46
备份目录内容：只有 .sqlite 与 .sqlite.manifest.json（无 WAL sidecar）✓

# 故障注入（按外键依赖顺序删除）
after damage: users= 0 messages= 0

# 校验备份文件本身
ops-...sqlite: ok / migrations: 1 / tables: 17 / backup manifest: 2026-10-14T15:55:02.552Z, 188416 bytes

# 恢复
Restored ...\hub.sqlite from ...\ops-...sqlite
  previous database kept at ...\hub.sqlite.pre-restore-2026-10-14T15-55-15-094Z
  migrations present in the restored file: 1

# 恢复后校验
restored users = 2
restored rooms = 1
restored message = "请制作季度报表"
```

**server-only 独立部署复验**（把 `server/` 单独复制到空目录，无 `application/`）：
`npm install`（48 包，3s）→ `migrate` → `status` → `backup` → `verify` → `node src/index.js` 监听 18445 → `health/ready` 返回 HTTP 200（`journalMode: wal`）→ SIGTERM 干净退出。

测试：**35 / 35 通过**（`h01` 12 + `h02` 23，退出码 0）。

---

## 未完成与需后续任务处理

| 项 | 状态 | 归属 |
|---|---|---|
| 干净 Linux 上的 server-only 部署 | 未做（本机为 Windows） | H-13 / Q-04 |
| systemd 单元、容器镜像 | 未做，仅 `deploy/DEPLOYMENT.md` 说明 | H-13 |
| 迁移的可逆/回滚策略 | 当前为前向迁移 + 恢复备份；未实现 down migration | H-02 延伸 / H-13 |
| 多 Hub 进程并发写保护 | 当前依赖 SQLite 锁与"启动即拒绝"，未做分布式协调 | 超出 V1 单实例设计 |
| HTTP 认证与限流 | 未做（当前只有 health 与 404 路由） | H-03 |
| WSS 实时通道 | 未做 | H-06 |
| 附件目录、审计保留策略的实际落地 | 目录常量已定义，逻辑未实现 | H-11 / H-12 |

## 下一步

H-03（用户注册/登录、设备身份、令牌吊销）是 H-04 及全部协作功能的前置，也是应用端 A-01 的前置。
