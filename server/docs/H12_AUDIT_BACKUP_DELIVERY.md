# H-12：审计、备份、恢复、保留策略

**任务 ID：** H-12
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（真实进程 + 真实 HTTP + 真实文件系统 + 真实破坏恢复）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 审计 | **PASS** — 可按人/对象/结果/类型/时间窗查询，始终有上限 |
| 备份 | **PASS** — manifest 记录**逐实体行数**，不只是文件大小 |
| 恢复 | **PASS** — 破坏全部实体后恢复，**逐实体计数完全一致** |
| **恢复真实群和状态** | **PASS** — 恢复后登录、群、消息、群记忆、任务状态、审批、附件、审计全部可用 |
| 保留策略 | **PASS** — 默认永久保留；dry-run 先看；执行留痕；**不动实体数据** |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/db/migrations/0006_audit_retention.sql` | 审计查询索引 + `retention_runs` 表 |
| `server/src/modules/audit/store.js` | 审计查询、计数、保留清理 |
| `server/src/api/audit.js` | 4 条路由 |
| `server/tests/h12-audit-retention.test.js` | 15 个测试 |

修改：`src/db/backup.js`（manifest 带实体计数 + `compareEntityCounts`）、`src/cli/hub.js`（`backup-drill` / `audit-prune` / `audit-runs`）、`src/config/index.js`（保留策略配置）、`.env.example`。

## 关键设计决定

### 1. "恢复成功"必须可验证，而不是"restore 命令跑完了"

原 manifest 只记文件大小与迁移清单。**打开成功 + schema 是当前的**并不能证明群的消息、审批、记忆回来了。现在 manifest 带 `entityCounts`：16 张表的行数快照。

`hub backup-drill <file>` 与 manifest 逐实体比对，任一不符即**退出码 1** 并指名差异表。

### 2. 计数读不出来时报"不可用"，不报 0

`entityCounts` 对每张表单独 try/catch，失败值写成 `unavailable: …`。

**为什么：** `0` 行与"表不存在"是完全不同的发现。旧版备份缺一张表时，报 0 会让 drill 通过；报字符串会立刻暴露。

### 3. 审计读取天然有界，且默认只看自己
`listAuditEvents` 的 limit 被 clamp 到 500（请求 100 万也只返回 500，请求 0 也给 1）。

**H12 的路由权限是本轮最需要解释的一条：** 审计覆盖所有人的行为，所以**群成员资格不授予它**。V1 没有独立的运维角色，因此：

- 调用者默认只看到**自己**的事件；
- 显式传 `actorUserId` 查别人 → **403 `NOT_YOUR_TRAIL`**，理由是"本 Hub 无运维角色，查询参数不能变成一种授权"；
- 按对象查询时，只允许**该对象所在群的成员**，非成员得到**空页而非报错**（不确认对象存在）。

**这是刻意比"完整管理 API"更窄的**。引入运维角色是带自身审计含义的产品决定，不在本轮擅自发明。

### 4. 保留策略默认"永久保留"
审计是 Hub **执行过的决定的记录**（审批、拒绝、撤销）。因此 `HUB_AUDIT_RETENTION_DAYS` 默认 `null`，运维必须**显式选择**一个窗口。

未配置窗口时 `hub audit-prune` **拒绝执行并给出提示**，而不是猜一个数字——一个猜错的窗口会不可逆地删掉审计。

### 5. 保留策略的执行留痕
`retention_runs` 记录每次运行的 scope / cutoff / 删除数 / 保留数 / 时间，与删除在**同一事务**内写入，所以计数与效果不可能不一致。"这个事件为什么没了"有答案。

### 6. 保留只清理轨迹，不碰实体
真实验证：执行保留策略后 `users`/`rooms`/`messages`/`tasks`/`approvals`/`group_memories`/`artifacts` 行数**全部不变**。

## 开发中被暴露的缺陷

**`require` 在 ESM CLI 中不可用**：`cmdBackupDrill` 里写了 `require('node:sqlite')`，在 ESM 中抛 `ReferenceError`。

**这个缺陷的发现过程值得记录**：我第一次运行 `backup-drill` 时看到 `DRILL_EXIT=0` —— 因为退出码来自管道里的 `head` 而非 node。**这与第 2 轮那个"构建失败被 tail 吞掉"是同一类错误。** 之后显式检查退出码才看到真实报错。

## 真实执行证据

### 测试

```sh
$ node --test tests/h12-audit-retention.test.js
 ℹ tests 15 / ℹ pass 15 / ℹ fail 0

$ node --test tests/*.test.js
 ℹ tests 266 / ℹ pass 266 / ℹ fail 0
```

15 项覆盖：备份含全部实体、**恢复后逐实体计数一致且行内容真实**、恢复后 API 结果与原件一致、**drill 会报缺失表而非当作空实体**、`entityCounts` 对缺失表报不可用、审计按对象/结果/时间窗查询且有界、HTTP 审计按调用者范围、**查他人轨迹 403**、非成员看对象轨迹得空页、单事件可见性、未认证不可读、**保留默认关闭**、**dry-run 不删不留痕**、执行只删早于 cutoff 并留痕、**保留不动实体数据**、cutoff 校验。

### 真实破坏-恢复演练

```
1. 初始化并按场景填充真实数据
   6 迁移应用；2 用户 / 1 群 / 1 消息 / 1 群记忆 / 1 任务 / 1 审批 / 1 凭据 / 1 附件

2. 备份
   bytes: 282624, pages: 69

3. backup-drill
   entities: 16 tables, 33 rows
   result:   every recorded count matches; the backup is complete

4. 故障注入（清空全部实体表）
   users: 0  rooms: 0  messages: 0  tasks: 0
   approvals: 0  group_memories: 0  artifacts: 0  audit_events: 0

5. 恢复
   previous database kept at hub.sqlite.pre-restore-…
   migrations present in the restored file: 1, 2, 3, 4, 5, 6

6. 恢复后逐实体比对
   entities: 16 tables, 33 rows
   result:   every recorded count matches; the backup is complete

7. 通过 HTTP 验证恢复的数据真的可用
   登录: 200 财务 A
   群: 财务协作群
   消息: 请制作季度报表
   群记忆: 季度报表以开票日为准
   任务: 制作报表(APPROVED)
   附件: report.csv 9B
   审计: 200 8 条；类型含 room.created, message.created, task.created, memory.created, artifact.uploaded
   审计类型目录: 12 种
   保留策略: 永久保留（未配置窗口）

8. 未配置窗口时 audit-prune 拒绝执行 ✓
9. dry-run 报告 0 条待删、14 条保留，不删除 ✓
10. 实际执行留痕 ✓
11. 保留策略后实体数据全部不变（users 2 / rooms 1 / messages 1 / tasks 1 / approvals 1 / memory 1 / artifacts 1）✓
```

**第 1-7 步是 H-12 的核心证据**：真实的破坏、真实的恢复、逐实体比对通过、恢复后 API 真的能读出原来的数据。

### 一次误判的记录

演练第 7 步首次运行时登录返回 500。排查后确认**是我启动 Hub 时忘了设 `HUB_TOKEN_SIGNING_KEY`**，服务端日志明确写着 `HUB_TOKEN_SIGNING_KEY is not configured`。带上密钥重跑即 200。

**这是正确的安全行为**（无签名密钥时拒绝签发令牌），不是产品缺陷。如实记录以免被误读为"恢复后登录有问题"。

## 未完成与风险

| 项 | 状态 |
|---|---|
| **备份的自动调度** | **未实现**。`hub backup` 是手动命令，没有定时任务。生产需要 cron/systemd timer，归 H-13 |
| **备份保留数量的实际执行** | 配置项 `HUB_BACKUP_RETENTION_COUNT` 已存在，但**没有任何代码用它清理旧备份**。这是一个已登记的功能缺口 |
| **附件字节不在数据库备份内** | **重要**：`backup` 只备份 SQLite 文件。附件存在 `HUB_DATA_DIR/artifacts/`，**恢复数据库后附件的字节文件不在备份里**。若磁盘丢失，`artifacts` 表会指向不存在的文件（下载时报 `ARTIFACT_BYTES_MISSING`）。备份方案必须覆盖文件系统，归 H-13 |
| 审计的写入上限/磁盘增长 | 审计表无容量上限，只有时间保留策略 |
| 运维角色 | 未实现。当前无人能"查看所有人的审计"，这是刻意的设计选择，已记录 |
| 异地/离线备份 | 未实现 |
| 恢复演练的自动化 | `backup-drill` 是手动命令；未接入定时验证 |
| 干净 Linux 上的同样演练 | 未做，归 H-13 |
| 双机环境下的备份一致性 | 未做（单 Hub 实例下无并发写入问题），归 Q-03 |

## 下一步

H-13（独立系统部署/容器部署、安全配置）。它需要覆盖本轮登记的两个缺口：**备份调度**与**附件字节的备份**。
