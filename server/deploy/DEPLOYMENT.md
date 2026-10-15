# server/ 生产部署操作规范

**本文件描述的操作已在真实 Linux（Debian 13，systemd 作为 PID 1）与真实容器（`node:24-alpine`）上执行过**，
转录见 [`docs/evidence/h13/`](../docs/evidence/h13/)。文中每条命令都是本机实际运行过的；未验证的部分在文末
「未验证与已知限制」中逐条列出，不与已验证内容混在一起。

---

## 1. 部署拓扑（先确认边界）

```
Linux 服务器（常开）
└── Hub 单进程（本目录）
    ├── SQLite（WAL）+ 附件对象 + 审计 + 备份  → HUB_DATA_DIR
    └── HTTPS/WSS 监听

每台员工电脑（不由本目录部署）
└── application/ 客户端
    └── 本机 DSH Agent Runtime + DS Bot（模型密钥只在这里）
```

服务器上**只放 `server/`**：不含 DSH、DS Bot、Electron，也不含任何模型 API Key。

## 2. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| 运行时 | Node.js 24 或更新（`package.json` 的 `engines` 与启动检查都会拒绝更低版本） | `node --version` |
| 网络 | 内网可达地址或 DNS；时钟同步 | `timedatectl status`（看 `NTP synchronized: yes`） |
| 磁盘 | `HUB_DATA_DIR` 所在卷，仅服务账号可读写 | `df -h` |
| 证书 | 由反代终止 TLS，或 `HUB_TLS_CERT`/`HUB_TLS_KEY` 指向 PEM | — |
| 火墙 | 仅放通反代→Hub 端口；Hub **不应对公网直接暴露** | — |

## 3. 服务账号与目录

```bash
useradd --system --shell /usr/sbin/nologin --home-dir /opt/workgroup-ai workgroup-hub
install -d -o workgroup-hub -g workgroup-hub -m 0700 /var/lib/workgroup-ai
install -d -o root -g root -m 0750 /etc/workgroup-ai
install -d -o root -g root -m 0755 /opt/workgroup-ai
```

`/var/lib/workgroup-ai` 是**唯一**持久数据目录：SQLite 三件套、`artifacts/`、`backups/` 全在其中，
不要放在会被发布流程清空的路径下。

## 4. 安装代码与依赖

```bash
rsync -a --delete --exclude node_modules --exclude data server/ /opt/workgroup-ai/server/
cd /opt/workgroup-ai/server
npm ci --omit=dev --no-audit --no-fund
```

> 不要用 `cp -r server/ /opt/...` 后直接启动：那会带上开发机的 `node_modules`。
> 用 `npm ci` 从 lockfile 安装，版本才与验证过的一致。

**先自检，再启动。** 这一步会指出「拷漏了文件」「依赖只有整仓才解析得到」「旁边还留着 `application/`」
这类到启动时才炸的问题：

```bash
sudo -u workgroup-hub HUB_DATA_DIR=/var/lib/workgroup-ai node src/cli/hub.js deploy-check
```

实际输出（干净容器内）：

```
server-only deployment check
  ok    configuration valid for NODE_ENV=production
  ok    /var/lib/workgroup-ai is readable and writable
  ok    TLS is terminated upstream; the Hub itself listens in cleartext behind it
  ok    /opt/workgroup-ai/server contains the Hub sources and its migrations
  ok    34 source files import only declared packages and Node's own modules
  ok    2 declared dependencies
  ok    nothing outside server/ is required to run this copy
```

退出码非 0 表示**不要继续**。该命令只读，不会替你在机器上创建目录。

## 5. 配置与秘钥

```bash
install -m 0600 -o root -g root deploy/systemd/hub.env.example /etc/workgroup-ai/hub.env
$EDITOR /etc/workgroup-ai/hub.env
chmod 0600 /etc/workgroup-ai/hub.env      # 确认
```

`hub.env.example` 里每个变量都是 Hub 真正读取的（有测试断言这一点）。必须替换的占位符：

```bash
openssl rand -base64 48     # → HUB_TOKEN_SIGNING_KEY
openssl rand -base64 24     # → HUB_ADMIN_BOOTSTRAP_SECRET
```

要点：

- **`HUB_TOKEN_SIGNING_KEY` 一旦丢失，所有已签发令牌失效**；轮换见下。
- `HUB_ADMIN_BOOTSTRAP_SECRET` 是注册闸门（`HUB_REGISTRATION=admin_secret`，生产默认）。
  首次建号后应从环境文件移除并重启。
- 不要把 `.env`、数据库或私钥提交进版本库。

### 签名密钥轮换（用户无感）

```ini
# 新密钥就位，旧密钥仍可验签
HUB_TOKEN_SIGNING_KEY=<新密钥>
HUB_TOKEN_SIGNING_KEY_CURRENT_KID=k2
HUB_TOKEN_SIGNING_KEY_PREVIOUS=k1:<旧密钥>
```

```bash
systemctl restart workgroup-hub
node src/cli/hub.js status | grep -i signing    # 应显示 2 keys held for rotation
```

等待**一个 access token 生命周期**（默认 900 秒）后，删掉 `HUB_TOKEN_SIGNING_KEY_PREVIOUS` 并再次重启。

> `HUB_TOKEN_SIGNING_KEY_CURRENT_KID` 不能与 previous 里的 kid 重名——Hub 会**拒绝启动**并说明原因。
> 这是刻意的：同名会让新密钥静默覆盖旧密钥，所有存量令牌立刻失效，而这正是轮换要避免的故障。

## 6. 初始化数据库

```bash
sudo -u workgroup-hub env $(grep -v '^#' /etc/workgroup-ai/hub.env | xargs) \
  node src/cli/hub.js migrate
```

迁移**前向且幂等**：每个迁移在自己的事务里同时写 schema 与版本号，崩溃只会留下「已应用」或「未应用」，
不会半应用。重复执行输出 `Schema is current`。

**回滚策略是「恢复备份」而不是 down migration。** 升级前先备份（第 8 节），升级失败就恢复：

```bash
node src/cli/hub.js backup --label pre-upgrade-$(date +%Y%m%d)
node src/cli/hub.js status        # 记下 migrations 计数
```

> 若数据库里存在本发布包**没有**的迁移版本，Hub **拒绝启动**并点名是哪个迁移。这说明该数据库来自更新的
> 或不同的发布；强行跑剩下的迁移会造出任何版本都没发过的 schema。

## 7. 启动（systemd，选定路线）

```bash
install -m 0644 deploy/systemd/workgroup-hub.service \
                 deploy/systemd/workgroup-hub-backup.service \
                 deploy/systemd/workgroup-hub-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now workgroup-hub
```

单元装载的加固项（均实测生效——`ProtectSystem=strict` 下进程内写 `/usr` 返回 `Read-only file system`，
而数据目录仍可写）：

| 指令 | 作用 |
|---|---|
| `ProtectSystem=strict` | 整个文件系统只读，仅 `ReadWritePaths` 例外 |
| `ReadWritePaths=/var/lib/workgroup-ai` | **必须与 `HUB_DATA_DIR` 一致** |
| `NoNewPrivileges` / `RestrictSUIDSGID` | 提权与 setuid 提权一律禁止 |
| `ProtectHome` / `PrivateTmp` / `PrivateDevices` | 看不到家目录、独立临时目录、无设备节点 |
| `MemoryMax=1G` / `TasksMax=512` | 单请求失控不会拖垮整机 |
| `Restart=always` `RestartSec=5s` | 崩溃自动拉起（实测 `kill -9` 后新 PID 起来且健康） |

健康检查：

```bash
curl -fsS http://127.0.0.1:8443/api/v1/health/live    # 存活，不碰数据库
curl -fsS http://127.0.0.1:8443/api/v1/health/ready   # 就绪，真读一次数据库并报告 journalMode=wal
systemctl status workgroup-hub --no-pager
journalctl -u workgroup-hub -n 50 --no-pager
```

`health/ready` 返回 503 表示数据库不可写——**编排系统应据此重启，而不是当成探针故障**。

## 8. 备份（含附件字节）

H-12 曾登记两个缺口：附件字节不在备份里、没有自动调度。两者现已补齐。

### 手动

```bash
sudo -u workgroup-hub env $(grep -v '^#' /etc/workgroup-ai/hub.env | xargs) \
  node src/cli/hub.js backup --label manual
```

一次 `backup` 写出**一个完整可恢复单元**：

```
<label>-<时间戳>-<随机后缀>.sqlite               数据库快照（已 checkpoint 成单文件）
<label>-<时间戳>-<随机后缀>.sqlite.manifest.json  逐实体行数 + 迁移清单
<label>-<时间戳>-<随机后缀>-objects/             附件字节（内容寻址，文件名即 sha256）
```

`objects` 目录名由**快照路径**推导（`objectsDirectoryFor`），写入与恢复共用同一个函数——两边各自拼名字
正是「备份看起来完整、恢复后附件全不可读」的成因。

**先备份再验证，不要只看退出码：**

```bash
B=$(ls -t /var/lib/workgroup-ai/backups/*.sqlite | head -1)
node src/cli/hub.js backup-drill "$B"
# → entities: 16 tables, N rows
# → result:   every recorded count matches; the backup is complete
```

`backup-drill` 逐表比对清单里记录的行数，因此「文件能打开」不算通过。它只读，不碰生产库。

### 自动（每天 03:30，带最多 15 分钟随机延迟）

```bash
systemctl enable --now workgroup-hub-backup.timer
systemctl list-timers workgroup-hub-backup.timer --no-pager
journalctl -u workgroup-hub-backup.service -n 50 --no-pager
```

备份是独立的 oneshot 进程，**不依赖 Hub 在跑**：库停了也能备份，而这正是操作员想要副本的时刻。
`Persistent=true` 保证机器关机错过的备份在开机后补跑。保留份数由 `HUB_BACKUP_RETENTION_COUNT` 控制，
超出部分被**移入 `backups/superseded/`，不删除**——按「快照 + manifest + objects」整组移动，不会出现
留下数据库却丢掉附件的情况。

## 9. 恢复（灾难演练）

```bash
systemctl stop workgroup-hub
B=$(ls -t /var/lib/workgroup-ai/backups/*.sqlite | head -1)

# 操作员命令读的是进程环境，而 systemd 只给服务加载 EnvironmentFile。
# 交互式 shell 必须先自己 source，否则会以「缺少 HUB_TOKEN_SIGNING_KEY」失败：
set -a; . /etc/workgroup-ai/hub.env; set +a

node src/cli/hub.js restore "$B"
node src/cli/hub.js verify
systemctl start workgroup-hub
curl -fsS http://127.0.0.1:8443/api/v1/health/ready
```

`restore` 会依次：

1. 先 `verify` 候选文件，不是 Hub 数据库就拒绝；
2. **只在数据库已存在时**探测占用（旧实现对不存在的库做「探测」，凭空造出一个 0 字节文件，再把它当作
   「上一个数据库」保存——一份什么都没有的安全副本）；
3. 保留 `hub.sqlite.pre-restore-<时间戳>` 安全副本；
4. 把 `-wal`/`-shm` 挪开（不删），否则旧提交页会并进恢复后的库；
5. 恢复附件字节；
6. **把被替换文件的属主与权限应用到恢复后的文件**。

第 6 点是真机上发现并修掉的缺陷：以 root 执行恢复会在服务账号的目录里留下 `root:root 0644` 的库，
服务账号无法写入，Hub 起不来并陷入重启循环，日志只有一句 `attempt to write a readonly database`。
现在 `restore` 保留原属主，无法保留时**明确告知**要执行的 `chown`。

> 恢复后必须重启 Hub：`restore` 要求 Hub 已停止，恢复的是文件而不是运行中进程的内存状态。

## 10. 容器部署（选定路线的替代）

```bash
cd server
docker build -f deploy/container/Containerfile -t workgroup-ai-hub:0.1.0 .
docker volume create workgroup-hub-data
docker run -d --name workgroup-hub \
  -p 8443:8443 \
  -v workgroup-hub-data:/var/lib/workgroup-ai \
  --env-file /etc/workgroup-ai/hub.env \
  workgroup-ai-hub:0.1.0
```

镜像基于 `node:24-alpine`，`tini` 作为 PID 1 转发信号，以非 root 的 `node` 用户运行，`HEALTHCHECK`
打的是 **readiness**（读一次数据库）而非 liveness。除 `src`/`db`/`contracts`/`deploy`/`docs` 与两个依赖
文件外什么都不进镜像；`tests/`、`node_modules/`、`data/`、`.env` 由 `.dockerignore` 排除，且该文件必须
放在**构建上下文根目录**（`server/.dockerignore`）——放在 `deploy/container/` 下不会被 Docker 读取。

> **用命名卷，不要用宿主目录 bind mount。** 实测 `-v /some/host/dir:/var/lib/workgroup-ai` 会让宿主
> 目录的属主覆盖镜像里的 `chown`，Hub 以 `EACCES` 拒绝启动。若确实要用宿主目录，先
> `chown -R 1000:1000 /some/host/dir`（镜像内 `node` 用户的 uid）。

停止时 `docker stop` 发 SIGTERM，Hub 关闭 socket 与数据库后退出 0（实测 `ExitCode=0 OOMKilled=false`）。

## 11. 安全配置

| 项 | 默认 | 说明 |
|---|---|---|
| `HUB_REGISTRATION` | `admin_secret`（生产） | 需要 `HUB_ADMIN_BOOTSTRAP_SECRET` 才能建号 |
| `HUB_LOGIN_MAX_ATTEMPTS` | 10 | 同一 handle 或同一来源在窗口内的失败上限 |
| `HUB_LOGIN_WINDOW_SECONDS` | 300 | 计数窗口 |
| `HUB_LOGIN_LOCKOUT_SECONDS` | 300 | 超限后的锁定时长 |
| `HUB_MAX_CONNECTIONS` | 2000 | 整进程 WebSocket 上限；`0` 关闭 |
| `HUB_MAX_CONNECTIONS_PER_USER` | 8 | 单账号上限；`0` 关闭 |
| `HUB_TOKEN_SIGNING_KEY_PREVIOUS` | 未设置 | 轮换期间仍可验签的旧密钥 |

登录限速的实测行为（真实 HTTP，预算 10）：

```
401 401 401 401 401 401 401 401 401 401 429 429
```

- 超限返回 **429 + `Retry-After`**，且**正确的密码也会被拒**——否则限速只减速不阻止。
- handle 计数**大小写无关**（`Alice` 与 `alice` 共用一个预算）。
- 来源计数**不会**被某次成功登录清空：一个有效账号不该替攻击者刷新预算。
- 计数有容量上限，来源众多时按最旧优先淘汰，因此限速器本身不会被撑爆内存。
- ⚠️ **计数在进程内存中，Hub 重启即清零。** 这是本设计的真实属性（单进程单写者使进程内计数是完备的，
  而非近似），但它意味着重启可重置锁定状态。要跨重启保持，需把计数放进 SQLite，或改由反向代理限速。
- ⚠️ `request.ip` 只在 Hub **被直连**时可信（`trustProxy: false`，因为信任客户端可伪造的
  `X-Forwarded-For` 比不做更糟）。放在反代后面时请在反代层限速，或让反代透传真实对端地址。

## 12. 日常运维

```bash
node src/cli/hub.js status          # 配置、schema、数据路径、密钥数量与限速参数
node src/cli/hub.js verify          # 校验当前库（或指定文件）
node src/cli/hub.js audit-prune --dry-run    # 先预览，再决定
node src/cli/hub.js audit-runs      # 查看历史保留策略执行记录
```

- **审计保留默认「永久」。** 设置 `HUB_AUDIT_RETENTION_DAYS` 前务必先 `--dry-run`：窗口设短了不可撤销。
- 日志中**没有**令牌与密码；`status` 只报密钥数量，不报密钥内容。

## 13. 故障处置

| 现象 | 原因与处置 |
|---|---|
| 启动即 `HUB_DATA_DIR is not readable and writable` | 目录不存在或属主不对；`install -d -o workgroup-hub -g workgroup-hub /var/lib/workgroup-ai` |
| 启动即 `attempt to write a readonly database` | 库文件属主不是服务账号，多为以 root 恢复所致；现版本会自动保留属主，旧版本用 `chown` 修正 |
| 启动即列出各配置项 | 配置问题；`ConfigError` 一次列全，逐条修正 |
| `HUB_DATA_DIR does not exist and neither does <parent>` | `deploy-check` 无法创建该路径；先建好父目录 |
| 容器里 `EACCES` | 用了宿主目录 bind mount；改用命名卷或 `chown 1000:1000` |
| 恢复后 Hub 反复重启 | 查 `journalctl`；属主问题见上；`hub.sqlite.pre-restore-*` 是回退点 |
| Hub 宕机 | 工作群离线，**本机 DS Bot 与普通群继续工作**。恢复后客户端按 `roomSeq` 补拉，未审批的远程任务不会自动执行 |

---

## 运行 Node 版本的选择（实测结论）

**用 Node 24。** `package.json` 声明 `>=24.0.0`，Node 26 也满足，但实测在此机器上
`node:sqlite` 的 `backup()` 在 Node 26.7.0 下会**间歇性阻塞约 30 秒**（同一段代码、同一个目录，
Node 24.19.0 每次 15 ms 完成；Node 26 下整个测试文件 200 秒仍未跑完）。阻塞发生在
`backup()` 内部，与本项目代码无关，但会让计划备份与 `hub backup` 变得不可预测。

- 完整服务端测试：**Node 24.19.0 下 307/307 通过，用时 16.5 s**；Node 26.7.0 下同一套测试因该
  阻塞超过 900 s 无法跑完。
- 因此容器镜像与 systemd 单元都固定 Node 24（`Containerfile` 用 `node:24-alpine`，系统部署文档
  要求 24 LTS）。升级到 26 之前请先复现这个基准。

## 未验证与已知限制

以下内容**没有**在本机验证过，不要当成已交付能力：

1. **真实多机（两台不同电脑 + 独立 Hub）协作 E2E**：需要两台物理机，本机不具备。归 Q-01（预期 BLOCKED）
   与 Q-02。
2. **macOS 打包**：本机为 Windows，无法实测。归 Q-04。
3. **限速不跨重启**：见第 11 节。要长期生效需落库或改由反代限速。
4. **反代后的真实对端地址**：`trustProxy: false` 是刻意的取舍，但因此反代部署的「按来源限速」会退化成
   按反代 IP 限速。
5. **速率限制未覆盖非登录端点**：心跳、消息、webhook 等尚无独立配额。
6. **容器镜像仅在 Docker Desktop 的 WSL2 Linux 内核上测过**，未在独立 Linux 主机与 k8s 上部署。
7. **证书轮换与外部秘密管理（Vault/KMS）** 未接入；当前为环境文件 + 0600 权限。
8. **Hub 自身终止 TLS** 有代码路径，但未在真机实测握手；默认路线是反代终止。
9. **备份没有异地/离线副本**：`superseded/` 与本机同卷，同一块盘损坏会一起丢。
