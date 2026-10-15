# H-09：授权凭据 / nonce / 一次性派发与撤销广播

**任务 ID：** H-09
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 授权凭据 | **PASS** — 一次性 nonce，仅存 SHA-256，签发时返还一次 |
| nonce | **PASS** — 256 位随机，数据库不可还原 |
| 一次性派发 | **PASS** — 消费与状态迁移同事务；8 并发消费恰好 1 次成功 |
| 撤销广播 | **PASS** — 取消提升版本 + 显式标记 + WSS 推送 |
| **重放拒绝** | **PASS** — 二次出示得 `GRANT_ALREADY_USED`，并记入审计 |
| **过期拒绝** | **PASS** — 过期得 `GRANT_EXPIRED`；签发时夹取到审批到期时间 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/db/migrations/0004_dispatch_grants.sql` | `dispatch_grants` 表与索引 |
| `server/src/modules/tasks/grants.js` | 签发、消费、撤销、审计 |
| `server/src/api/grants.js` | 3 条路由：签发、消费、查看/撤销 |
| `server/tests/h09-grants.test.js` | 23 个测试 |

## 凭据的四条安全性质（每条独立检查）

一次派发要真正安全，四个条件必须**同时**成立。因此实现里是四个独立检查、四类独立错误码，测试也逐个覆盖——一个笼统的"凭据无效"测试会在三条规则全坏的情况下依然通过。

### 1. 一次性（`GRANT_ALREADY_USED`）
`consumeGrant` 在**同一事务**里校验并写入 `consumed_at`。8 个并发消费请求实测：**恰好 1 个成功、7 个 409**，库中只有一条 `consumed_at` 非空。

第二次出示被记为 `grant.replay_refused` 审计事件（`outcome: 'refused'`）。**这是刻意的：** 一次重放意味着凭据被转发（捕获攻击）或客户端在重试一个它从未收到响应的请求。两种情况运维都需要看见。

### 2. 绑定到任务、所有者、设备与 Bot（`UNKNOWN_GRANT`）
- **任务**：`grant.task_id !== taskId` 直接拒绝。为不让探测者确认 nonce 真实性，**"nonce 不存在"与"nonce 属于别的任务"返回完全相同的响应**（测试用 `deepEqual` 固定）。
- **设备**：`grant.device_id !== deviceId` 同样归入 `UNKNOWN_GRANT`。真实验证确认：machine-1 签发的**未消费**凭据由 machine-2 出示 → 404 `UNKNOWN_GRANT`，而 machine-1 自己出示 → 200。
- **所有者**：只有 `owner_user_id` 本人可以签发（真实验证中 A 是请求方，签发被拒 403 `NOT_TASK_OWNER`）。

### 3. 双重时限（`APPROVAL_EXPIRED` / `GRANT_EXPIRED`）
凭据自带 `expires_at`，但**签发时夹取到审批的到期时间**：

```js
const ownExpiry = new Date(now + ttl)
const expiresAt = approval.expires_at < ownExpiry ? approval.expires_at : ownExpiry.toISOString()
```

因此"点头同意"这件事的时限无法被一个签发得稍晚的凭据绕过。测试用两种方式验证：把审批改到 30 秒后 + 申请 1 小时凭据 → 凭据到期时间**恰好等于**审批到期时间；反过来（审批 24 小时 + 申请 120 秒）→ 凭据自己的较短窗口生效。另有一个用例验证已过期的审批**不能**签发任何凭据（410 且库中零行）。

### 4. 可撤销，且撤销是"机器可核对的事实"（`GRANT_REVOKED`）
**这是整个设计里最关键的一点：** Hub 无法向任意电脑发送命令，也不应该能。它只能**发布事实**：

1. `cancelTask` 把 `revocation_version` +1（H-08 已实现）；
2. `revokeGrantsForTask` 显式把未消费凭据标记 `revoked_at`；
3. WSS 推送 `task.cancelled`。

本地执行器持凭据时存下它签发时的 `revocation_version`，每次调用前比对。版本不一致 → 拒绝继续。真实验证：

```
A 取消任务: [200] state=CANCELLED revocationVersion=1
取消后出示凭据: [409] GRANT_REVOKED: This dispatch grant was revoked
```

**为什么不直接用审批的 scope 做校验：** 凭据签发时把 `scope_json` **复制**到自己的行上。这样验证不需要 join `approvals`，且审批范围之后若被改动，**不会静默放宽一个已经发出去的凭据**。

## 其他决策

- **消费与状态迁移同事务。** `consumeGrant` 在校验通过后把任务从 `APPROVED` 推到 `QUEUED` 并写入 `task.dispatched` 事件。因此"已派发"是一个事实而非两次可能不一致的写入。测试 `consuming moves the task to QUEUED` 同时断言**签发本身不启动任何东西**。
- **从 `QUEUED` 可以再次签发**（崩溃的执行器需要重试），但已消费的凭据保持已消费——测试 `a consumed grant cannot be renewed` 固定这一点。
- **仅所有者可查看凭据列表**，且列表**不含可用 nonce**（测试断言响应正文不含 `wggrant_`）。群里其他人无权知道所有者机器上签发过什么。
- **撤销可由所有者或群管理员发起**：管理员可以制止一件对群有影响的派发，但不能凭空签发。

## 开发中被测试暴露的一个真实缺陷（测试自身）

`a grant minted near the end of an approval cannot outlive it` 最初依赖真实时钟：签发一个 2 秒窗口的审批再立刻申请 1 小时凭据。**3 次运行中有 1 次失败**——在并发测试负载下，2 秒窗口可能在断言前就过期。

**修复：** 改为用数据库时间改审批到期时间（把审批改到 30 秒后），使断言不依赖真实时钟竞速。拆成两个用例：一个验夹取规则，一个验"已过期的审批不能签发"。改后 3 次运行均 23/23 稳定通过。

**这是一次有价值的修复：** 依赖毫秒级时序的测试会在 CI 上随机失败，而失败原因与被测行为无关，长期会训练团队忽略红灯。

## 真实执行证据

### 测试

```sh
$ node --test tests/h09-grants.test.js        # 连跑 3 次
 ℹ tests 23 / ℹ pass 23 / ℹ fail 0      （三次一致）

$ node --test tests/*.test.js                 # 全量
 ℹ tests 202
 ℹ pass 202
 ℹ fail 0
```

23 项覆盖：nonce 哈希确定性与不可逆、签发只存哈希且复制范围、未批准任务不能签发、仅所有者可签发、已拒绝任务不能签发、**夹取到审批到期（两个方向）**、**已过期审批不能签发**、**消费恰好一次 + 重放拒绝**、消费迁移状态并产生 `task.dispatched`、**未知 nonce 与错误任务响应一致**、**设备绑定**、**过期拒绝**、**取消使已签发凭据失效**、取消显式标记 revoked、所有者/管理员可撤销而陌生人不可、仅所有者可查看且不含 nonce、非成员查看与不存在一致、store 层拒绝越权签发、**8 并发消费恰好 1 成功**、已消费凭据不可续期、**审计含 minted/consumed/replay_refused**、凭据线形状仅 8 字段。

### 真实端到端：授权 → 派发全链路

```
任务已批准（B 本人操作）

=== 1. B 的本地 Runtime 申请一次性授权凭据 ===
  [201] nonce=wggrant_xeqkC3mVAe2_… expiresAt=2026-10-14T17:53:01.411Z

=== 2. 本地 Runtime 出示凭据以启动任务 ===
  [200] botId=writer
  批准的范围: {"allowedTools":["read","write"],"workDir":"D:/finance/q4","maxRuntimeSeconds":600,
              "requesterUserId":"29031aa9…","ownerUserId":"58238143…","roomId":"37fddb55…",
              "taskId":"37822591…","assignmentMode":"existing_bot","assignedBotId":"writer"}

=== 3. 重放同一凭据（应被拒） ===
  [409] GRANT_ALREADY_USED: This dispatch grant was already used

=== 5. 授权凭据全生命周期（所有者视图） ===
  id=cf3df2c9… issuedAt=17:48:01 consumedAt=17:48:01 revokedAt=null
  （列表中不含可用 nonce: true）

=== 6. 新任务：取消后凭据立即失效 ===
  凭据已签发 expiresAt=17:53:01
  A 取消任务: [200] state=CANCELLED revocationVersion=1
  取消后出示凭据: [409] GRANT_REVOKED: This dispatch grant was revoked
```

### 真实跨设备凭据绑定

```
=== 跨设备出示**未消费**的凭据（应被拒）===
  凭据由 machine-1 签发: wggrant_Hibon83S…
  machine-2 出示: [404] UNKNOWN_GRANT
  → 凭据绑定签发设备，无法跨机使用
  machine-1（正确设备）出示: [200]（凭据仍可用）
```

## 未完成与风险

| 项 | 状态 |
|---|---|
| **真实的本地执行** | **未做，也不由 Hub 负责**。凭据消费只是"记录派发"，实际执行与范围强制在 B 的机器上（F-11/F-13/A-07/A-08）。**本任务不能表述为"跨用户派发已可用"** |
| 凭据的签名 | 当前凭据是**不透明随机串 + 数据库查询**，没有加密签名。B 的机器无法离线验证凭据真伪，必须在线的 Hub 才能校验。若产品需要离线/断网派发，需增加签名（归 A-07 评估） |
| 过期凭据的清理 | 无定时任务清理 `dispatch_grants` 旧行。表会随使用增长，归 H-12 保留策略 |
| 撤销推送到 B 的机器 | WSS 推送 `task.cancelled` 已实现（H-06 通道），但**本地 Bridge 的撤销广播处理未实现**，归 A-07 |
| 凭据与真实 Bot 身份的绑定 | `bot_id` 只是字符串。Hub 无法验证该 id 在 B 的机器上确实对应一个原生 Bot，归 F-11 |
| 双机真实派发 | 未做，归 Q-01（N 级证据） |

**必须明确记录的边界：** 本轮证明的是"Hub 会拒绝重放、拒绝过期、拒绝跨设备、并在取消后让凭据失效"。它**没有**证明"B 的机器确实按批准的 scope 执行了"——那需要 F-11（Task Session 身份）、F-13（工具 guard）、A-07（Bridge 验签）与两台真实电脑。

## 下一步

H-10（群记忆 ACL/来源/检索/纠错/删除），依赖 H-05。
