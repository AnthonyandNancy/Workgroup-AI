# H-13 交付：独立系统部署 / 容器部署、安全配置

| 字段 | 内容 |
|---|---|
| 任务 ID | H-13 |
| 状态 | **PASS**（容器与 systemd 已在真实 Linux 上跑通完整演练；限速、密钥轮换、备份调度、附件字节备份、属主保持全部有实测证据。唯一未做的是「独立 Linux 主机 / k8s」——见风险节） |
| 涉及路径 | `server/deploy/`、`server/src/security/ratelimit.js`、`server/src/auth/tokens.js`、`server/src/config/index.js`、`server/src/db/backup.js`、`server/src/cli/hub.js`、`server/src/server.js`、`server/src/realtime/hub.js`、`server/src/api/identity.js`、`server/.dockerignore`、`server/tests/h13-deploy.test.js`、`server/docs/evidence/h13/` |
| 前置条件 | H-01…H-12 完成；Docker Desktop（WSL2 Linux 内核）；本机无独立 Linux 服务器与第二台物理机 |

## 达成条件与判定

| 达成条件 | 实测结果 | 证据 |
|---|---|---|
| 干净 Linux 上**仅 `server/`** 可安装、迁移、启动、健康检查 | 通过：`node:24-alpine` 镜像内 6 个迁移全部应用，两个健康端点 200 | `container-image.txt` |
| 部署物不含 DSH / DS Bot / Electron / 模型密钥 | 通过：镜像内无 `apps`/`packages`/`integrations`，`node_modules` 无 dsh/ds-bot/electron；Hub 进程环境无模型 API Key | `container-image.txt` |
| 容器内 `deploy-check` 自检通过 | 通过：34 个源文件、2 个依赖，无越界 | `drill-systemd.txt` 第 13 步 |
| 完整业务闭环（注册→登录→建群→发消息）在真实 HTTP 上可跑 | 通过 | `drill-systemd.txt` 第 3–6 步 |
| 备份 → 全量数据损毁 → 恢复 → 校验 → 服务可用 | 通过：`every recorded count matches`，恢复后群与消息可读 | `drill-systemd.txt` 第 8–12 步 |
| **附件字节**随备份保留并随恢复还原 | 通过：sha256 一致，恢复后可下载，字节与原件 `cmp` 完全相同 | `artifact-roundtrip.txt` |
| **总量损毁后以 root 恢复**服务仍能正常起来 | 通过：属主取自数据目录（uid 997），`NRestarts=0`，附件字节完全一致 | `total-loss-restore.txt` |
| 登录不可被全速爆破 | 通过：真实 HTTP 实测 `401 ×10 → 429`，正确密码在锁定期同样被拒 | `drill-systemd.txt` 第 7 步 |
| 服务加固真实生效（非仅声明） | 通过：`ProtectSystem=strict` 下写 `/usr`、`/etc` 均 `Read-only file system`，数据目录仍可写 | `sandbox-hardening.txt` |
| 崩溃自动恢复 | 通过：`kill -9` 后 systemd 拉起新 PID，健康检查 200 | `systemd-state.txt` |
| 计划备份可用 | 通过：timer 已装载，`workgroup-hub-backup.service` `ExecMainStatus=0` | `drill-systemd.txt` 第 8 步 |

## 修改摘要

### 1. 安全加固（补齐 H-03 / H-06 登记的缺口）

- **新增 `src/security/ratelimit.js`**：进程内失败计数器。两把钥匙两套预算（按 handle + 按来源），
  成功清除本 handle 的计数但不退还来源预算；容量有上限并按最旧淘汰，攻击者无法用它撑爆内存。
- **`src/api/identity.js`**：登录在**计算密码哈希之前**查限速，超限返回 `429` + `Retry-After`。
  失败写结构化日志而非审计表——未认证请求不应能让 Hub 往审计表里写数据。
- **`src/realtime/hub.js` + `route.js`**：WebSocket 增加单账号与整进程两个连接上限（`0` 关闭），
  拒绝时给出可区分的关闭码（4429），不会为腾位置而踢掉已有连接。
- **`src/auth/tokens.js`**：引入 `TokenKeyring`，支持旧密钥继续验签、新密钥签发。
  `HUB_TOKEN_SIGNING_KEY_CURRENT_KID` 与 previous 同名时**拒绝启动**——同名会让新密钥静默覆盖旧密钥，
  所有存量令牌立即失效，正是轮换要避免的故障。
- **`src/config/index.js`** 新增：`HUB_LOGIN_MAX_ATTEMPTS`、`HUB_LOGIN_WINDOW_SECONDS`、
  `HUB_LOGIN_LOCKOUT_SECONDS`、`HUB_MAX_CONNECTIONS`、`HUB_MAX_CONNECTIONS_PER_USER`、
  `HUB_TOKEN_SIGNING_KEY_CURRENT_KID`、`HUB_TOKEN_SIGNING_KEY_PREVIOUS`。

### 2. 部署产物

| 文件 | 说明 |
|---|---|
| `deploy/systemd/workgroup-hub.service` | 主服务；加固后**实测生效**（见证据） |
| `deploy/systemd/workgroup-hub-backup.service` + `.timer` | 每日 03:30 计划备份，`Persistent=true` 补跑 |
| `deploy/systemd/hub.env.example` | 与 `src/config/index.js` 的变量集合有测试断言 |
| `deploy/container/Containerfile` | `node:24-alpine` + tini，非 root 运行，HEALTHCHECK 打 readiness |
| `.dockerignore` | **必须在构建上下文根目录**；放在 `deploy/container/` 下 Docker 不会读取 |
| `deploy/DEPLOYMENT.md` | 重写：13 节可执行 runbook + 独立列出 9 条未验证限制 |

### 3. 备份/恢复（补齐 H-12 登记的两个缺口）

- **附件字节入备份**：`copyArtifactObjects` / `restoreArtifactObjects`。
- **计划备份**：systemd timer。
- **保留策略**：`pruneBackups` 按「快照 + manifest + objects」整组移入 `superseded/`，不删除。
- **`objectsDirectoryFor` 统一命名**：写入与恢复共用一个函数推导目录名。原先两边各自拼名字，
  结果 `backup` 写 `label-stamp-objects`、`restore` 找 `<snapshot>-objects`，除了巧合永远对不上——
  一个「备份看起来完整、恢复后附件全不可读」的静默缺陷。
- **恢复保留属主**（真机发现，见下）。
- **恢复安全副本不再造假**：旧实现会对不存在的库做「占用探测」，而打开不存在的 SQLite 文件会**创建**它，
  于是凭空产出 0 字节的 `pre-restore` 文件，再当作「上一个数据库」保存。

## 真实命令与实测输出

```bash
# 容器镜像构建 + 运行（真实 Linux 内核）
docker build -f deploy/container/Containerfile -t workgroup-ai-hub:h13 .
docker run -d --env-file /etc/workgroup-ai/hub.env -v wg-h13-data:/var/lib/workgroup-ai workgroup-ai-hub:h13
# → Up 7 seconds (healthy)，6 个迁移全部 applied，health/ready = 200 journalMode=wal

# systemd 作为 PID 1 的完整演练（Debian 13）
docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw wg-h13-systemd
docker exec wg-h13-sd sh /root/drill.sh          # 13 步，EXIT=0
docker exec wg-h13-sd sh /root/root-restore.sh   # 以 root 恢复，EXIT=0
docker exec wg-h13-sd sh /root/total-loss.sh     # 总量损毁 + root 恢复，EXIT=0
docker exec wg-h13-sd sh /root/artifact-drill.sh # 附件字节往返

# 测试
cd server && node --test tests/*.test.js
# → tests 306, pass 306, fail 0（其中 h13-deploy.test.js 40 项）
```

关键实测片段：

```
== 7. the throttle refuses a password spray (12 attempts, budget 10)
401 401 401 401 401 401 401 401 401 401 429 429

== 9. the backup is drilled against every entity count it recorded
entities: 16 tables, 10 rows
result:   every recorded count matches; the backup is complete

== 11. restore from the scheduled backup
ownership: uid 997, gid 997, mode 644 (taken from the data directory)
  there was no previous database file to keep a safety copy of

== 总量损毁演练（数据库、侧车、附件、全部备份一并销毁后仅从一份备份恢复）
evidence,value
survives,yes
ATTACHMENT BYTES SURVIVED TOTAL LOSS IDENTICALLY
NRestarts=0  ExecMainStatus=0  health/ready=200 journalMode=wal

== 12. the restored database serves the same collaboration data
{"rooms":[{"id":"44645bb7-...","name":"H-13 drill room","myRole":"owner"}]}
{"messages":[{"roomSeq":1,"clientMessageId":"drill-message-0001","body":"hello from the drill"}]}
```

## 只有真机才会暴露、因此在本轮被修掉的缺陷

这些都是 Windows 单机测试**看不见**的，全部由「在真实 Linux 上跑一遍」发现：

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 恢复后文件属主变成执行者（常为 root） | 服务账号无法写入，Hub 起不来并**无限重启**，日志只有 `attempt to write a readonly database` | `restoreBackup` 保留被替换文件的 uid/gid/mode；**无被替换文件时取数据目录的属主**（总量损毁正是恢复存在的场景，第一版修复漏了它，是靠重跑真机演练发现的），无法保留时明确给出 `chown` 命令 |
| 2 | 探测「数据库是否被占用」时对不存在的库 `new DatabaseSync(path)` | 凭空创建 0 字节库，再当作「上一个数据库」保存——**一份什么都没有的安全副本** | 仅在库已存在时探测；`safetyCopy` 为 `undefined` 时如实说明 |
| 3 | 运行中的 Hub 占着 `-wal`，Windows 拒绝 rename | 恢复报出与真实原因无关的 `EBUSY`，且可能已改了一半 | 侧车移动失败时**回滚已移动的文件**并给出「先停 Hub」的明确拒绝 |
| 4 | `deploy-check` 在数据目录尚不存在时判定配置非法 | 首次部署的正确行为被报成失败；`loadConfig` 直接抛错，检查根本没跑到自己的逻辑 | 新增 `allowMissingDataDir` 策略：接受缺失目录，但仍校验最近已存在祖先可创建可写 |
| 5 | `deploy-check` 未检查同级 `application/` | **恰恰漏掉了它要验证的那条标准**（别把整仓拷到服务器） | 把 `application` 加入同级标记；`apps`/`packages` 在 `application/` **内部**，单列它们检测不到 |
| 6 | `.dockerignore` 放在 `deploy/container/` | Docker 不读取，`tests/`、`node_modules`、`.env` 会进镜像 | 移到构建上下文根目录 `server/.dockerignore` |
| 7 | 文档没说要先 source `hub.env` | 操作员跑 `restore`/`deploy-check` 会以「缺少 HUB_TOKEN_SIGNING_KEY」失败，且看不出是 shell 的问题 | `DEPLOYMENT.md` 第 9 节写明 `set -a; . /etc/workgroup-ai/hub.env; set +a`；`deploy-check` 检测到该文件存在而环境未加载时直接打印这条命令（作为 `hint`，与 `ok`/`FAIL` 区分，避免失败被看成通过） |
| 8 | 限速器超出上限 1 个键；锁定期结束仍按旧失败计数 | 前者内存无界；后者使「锁定 N 秒」永不到期 | 扩容前先回收；锁定期满即丢弃旧计数重新开始 |
| 9 | 备份对象目录名与恢复查找名不一致 | 备份验证通过、恢复成功、附件全部不可读 | 统一由快照路径推导（`objectsDirectoryFor`），写入与读取共用 |
| 10 | 容器 bind mount 宿主目录覆盖镜像 `chown` | `EACCES` 启动失败 | 文档明确用命名卷，或 `chown 1000:1000` |

## 未解决风险

| 项 | 状态 | 归属 |
|---|---|---|
| **真实多机 E2E**（两台电脑 + 独立 Hub） | 未做，本机不具备 | Q-01（预期 BLOCKED） |
| **macOS 打包** | 未做，本机为 Windows | Q-04 |
| 独立 Linux 主机 / k8s 部署 | 未做；仅在 Docker Desktop 的 WSL2 内核上验证 | Q-04 |
| 限速**不跨重启** | 已知属性，进程内计数；文档已写明 | 后续 / 反代限速 |
| 反代后真实对端地址 | `trustProxy: false` 是刻意取舍，反代部署按来源限速会退化为按反代 IP | 运维配置 |
| 非登录端点无限速 | 心跳、消息、webhook 无独立配额 | 后续 |
| 备份无异地副本 | `superseded/` 与主库同卷 | 运维策略 |
| Hub 自身 TLS 握手 | 有代码路径，未真机实测；默认反代终止 | 后续 |

## 下一步

H-13 是 server 端最后一个任务。A-01…A-10（application 与 Hub 联动）与 Q 系列（验收）按
`TASK_BOARD.md` 依赖顺序继续；Q-01 与 Q-04 的 macOS 部分按用户要求以 BLOCKED 记录所需条件。
