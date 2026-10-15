# H-08：创建任务、审批、状态机、任务事件记录

**任务 ID：** H-08
**执行日期：** 2026-10-15
**机器：** Windows 11 (MINGW64) / Node v26.7.0 / Fastify 5.12.7 / SQLite（`node:sqlite`，WAL）
**证据等级：** **L**（单电脑真实进程 + 真实 HTTP + 真实 SQLite）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 创建任务 | **PASS** — 建为 `PENDING_APPROVAL`，**不执行任何工作** |
| 审批 | **PASS** — 仅任务所有者本人可批/拒，记录完整授权范围 |
| 状态机 | **PASS** — 12 状态迁移表在事务内强制，终态不可再动 |
| 任务事件记录 | **PASS** — 群可见事件流，**不含**私有路径/工具细节 |
| **不能跳过本人审批** | **PASS** — 请求方、群管理员、伪造设备、并发重放、越权跳转全部被拒 |

## 新增文件

| 文件 | 作用 |
|---|---|
| `server/src/modules/tasks/store.js` | 状态机、任务创建、审批、取消、过期、事件流 |
| `server/src/api/tasks.js` | 6 条路由：创建、决策、取消、单任务读、群任务列表、待审批队列 |
| `server/tests/h08-tasks.test.js` | 29 个测试 |

## 状态机（这是本模块的核心）

```
PENDING_APPROVAL → APPROVED | REJECTED | EXPIRED | CANCELLED
APPROVED         → QUEUED | CANCELLING | CANCELLED | FAILED | EXPIRED
QUEUED           → RUNNING | CANCELLING | CANCELLED | FAILED | EXPIRED
RUNNING          → REVIEW_REQUIRED | COMPLETED | CANCELLING | FAILED
REVIEW_REQUIRED  → COMPLETED | SHARED | CANCELLING | FAILED
CANCELLING       → CANCELLED | FAILED
COMPLETED / SHARED / REJECTED / EXPIRED / CANCELLED / FAILED → （空，终态）
```

**三条由表结构本身保证的性质**（测试 `the transition table has no edge that reaches RUNNING without passing through approval` 固定）：

1. **只有 `QUEUED` 能进入 `RUNNING`。** `APPROVED → RUNNING` **不在表里**——中间强制经过 `QUEUED`，因此存在一个"已批准但尚未启动"的可观察状态。这个空隙是刻意保留的：它让"批了但没跑"和"已经在跑"可以被区分开。
2. **只有 `PENDING_APPROVAL` 能进入 `APPROVED`。** 没有任何其他状态可以到达已批准。
3. **终态列表为空数组而不是缺失键。** 这样查表总有答案，不会因为忘记某个键而把"恢复已完成任务"变成合法操作。

## 关键安全决策与依据

### 1. 审批权只属于任务所有者本人
`decideTask` 在**进入状态机之前**先检查 `task.owner_user_id === approverUserId`。这不是"房间管理员"权、不是"请求方"权、也不是"所有者 Bot（Chief）"权。

**Chief 为什么无法代批：** 决策需要一枚 `approveAccessToken`，而 token 由 `authenticate` 校验**用户 + 设备**两者，设备必须存在且未吊销。Chief 是本机进程，不是用户，没有这样的凭据。测试 `a companion Bot has no path to decide` 用一枚"签名正确但设备不存在"的 token 验证这一点，得到 403 `DEVICE_REVOKED`，任务保持 `PENDING_APPROVAL`。

### 2. 审批记录完整授权范围
`approvals.scope_json` 记录所有者批准的**确切范围**，并在 Hub 侧补入身份事实（请求方、所有者、群、任务 id），避免本地执行器与 Hub 对身份的理解出现分歧：

```json
{
  "allowedTools": ["read", "write"],
  "workDir": "D:\\finance\\reports",
  "maxRuntimeSeconds": 900,
  "allowedRecipients": ["<A 的 userId>"],
  "requesterUserId": "...", "ownerUserId": "...", "roomId": "...", "taskId": "...",
  "assignmentMode": "existing_bot", "assignedBotId": "writer"
}
```

### 3. 撤销靠"提升授权版本"，而不是靠 Hub 去够到 B 的机器
`cancelTask` 在把任务置为 `CANCELLING`/`CANCELLED` 时同事务执行 `revocation_version = revocation_version + 1`。

**这是本设计最关键的一点：** Hub 无法向任意电脑发送 shell 命令，也不应该能。它只能**发布一个事实**（版本号变了），由 B 本地执行器在每一步前比对。真实验证第 10 步确认 `revocationVersion` 从 0 变 1。

### 4. 运行中的任务取消 → `CANCELLING` 而非直接 `CANCELLED`
本地进程可能正处在某一步中间。Hub 不能声称一个它无法验证的"已停止"。真实验证确认：取消一个 `RUNNING` 任务得到 `CANCELLING`，由本地执行器确认停止后自行推进到 `CANCELLED`。

### 5. 版本号（乐观锁）+ 唯一约束双重防重
- `expectedVersion` 不匹配 → 409 `VERSION_CONFLICT`（测试 `a decision with a stale expectedVersion is refused`）
- `approvals.task_id` 唯一 → 第二次决策撞约束，转成 409 `ALREADY_DECIDED`
- 6 个并发批准请求实测：**恰好 1 个成功、5 个 409、库中恰好 1 条 approval 记录**

### 6. 群可见事件流与审批范围分离
`task_events` 存的是**房间可见**的进度，`approvals.scope_json` 存的是**私下**的授权细节。测试 `the room-visible event payload never carries the approved scope's resource detail` 用含 `D:\finance\private` 的范围做审批，然后断言事件流的 JSON **不含** `private` 或 `finance`。真实验证第 13 步同样确认。

这条很重要：群成员能看到"任务被批准了、正在跑"，但看不到 B 允许了哪些本地目录和工具。

### 7. 非成员读任务返回与"不存在"相同
沿用 H-04 的规则。真实验证第 12 步确认真实 task 与伪造 id 的响应 JSON **完全一致**。

### 8. 命名一个请求方看不到的 Bot 被拒
请求方可以指定 `targetBotId`，但必须是他**有权看到**的已发布 Bot。真实与不存在的 Bot 返回相同的 403，因此这个接口不能被用来枚举 B 的私有 Bot 清单（测试用 `deepEqual` 固定）。

## 开发中被测试暴露并修复的**真实缺陷**

### 缺陷 1：`task.approval_requested` 事件类型不在白名单 → 创建任务返回 500

`EVENT_TYPES` 只列了 `message.created` / `invitation.created` / `member.changed`，而 `contracts/events.schema.json` 早已定义 `task.*` 与 `group_memory.changed`。首次调用创建任务路由时 `makeEvent` 抛 `UNKNOWN_EVENT_TYPE`，导致 **HTTP 500**。

**影响分析：** 这不是"少写了一个字符串"，而是**契约与实现的漂移**。契约是客户端的权威文档，实现却会让契约里承诺的事件在发布时崩掉请求。
**修复：** 补齐白名单到契约的超集，并在代码注释里写明"这个列表必须至少覆盖契约的 enum"。

### 缺陷 2：所有者可以指派一个**不在自己目录中**的 Bot

`isVisibleTo` 的第一行是 `if (ownerUserId === viewerUserId) return true`——在检查目录条目**是否存在**之前就返回了。因此 `assignedBotId: 'ghost-bot'`（从未发布）也能通过审批，`assignedBotId` 被写成 `ghost` 且任务变成 `APPROVED`。

**影响分析：** 任务带上一个解析不出来的 Bot id，会让本地执行器在派发阶段才发现无 Bot 可派——而那时所有者已经批准过，授权已被消耗。更糟的是，它表明"所有权隐含目录成员资格"这个错误假设，同一个函数还被 H-07 的目录可见性判断复用。
**修复：** 把存在性检查提到最前，所有权只影响**可见性**而不影响**存在性**：

```js
const entry = findEntry(db, { ownerUserId, botId })
if (entry === undefined) return false
if (ownerUserId === viewerUserId) return true
```

修后测试 `an approval must name its mode correctly` 通过，真实验证第 7 步返回 403 `BOT_NOT_IN_DIRECTORY`。

## 真实执行证据

### 测试

```sh
$ node --test tests/h08-tasks.test.js
 ℹ tests 29
 ℹ pass 29
 ℹ fail 0

$ node --test tests/*.test.js          # 全量
 ℹ tests 179
 ℹ pass 179
 ℹ fail 0
```

29 项覆盖：迁移表中"到 RUNNING 只能经 QUEUED"与"到 APPROVED 只能经 PENDING_APPROVAL"、终态无出边且每状态都有表项、创建即待审批且无 approval、双侧成员资格、自我任务被拒、**不可见 Bot 与不存在 Bot 响应一致**、描述校验、批准并记录范围、拒绝后不可再动、**请求方不能自批**、**群管理员不能代批**、**伪造设备 token 被拒且任务不变**、**6 个并发批准恰好 1 成功**、陈旧版本被拒、模式校验（含必须指定 botId）、**取消提升 revocationVersion**、三类主体可取消、终态不可取消、**RUNNING 取消得到 CANCELLING**、非成员读与不存在一致、被移除成员立即失去访问、群任务列表隔离、事件流有序、**事件流不含审批范围细节**、store 层拒绝非法跳转、store 层拒绝非所有者决策、过期语义、任务线形状仅 13 个字段、审计含创建与批准。

### 真实核心业务场景端到端

```
======== 核心业务场景：财务 A 请 财务 B 的机器人管家做报表 ========

--- 1. A 在工作群 @B 的 Chief 请求制作报表 ---
  [201] state=PENDING_APPROVAL
  → 只显示待审批，未启动任何 B 的模型/工具/文件

--- 2. B 的待审批队列 ---
  [200] B 看到 1 项: "请制作 Q4 季度报表，数据在 /reports/q4"

--- 3. A（请求方）尝试自己批准（应被拒） ---
  [403] NOT_TASK_OWNER: Only the task owner may decide it

--- 4. 群管理员尝试代批（应被拒） ---
  [403] NOT_TASK_OWNER: Only the task owner may decide it

--- 5. 任务仍未被批准 ---
  state=PENDING_APPROVAL（未被任何非 B 主体改变）

--- 6. B 本人批准，指定已有下属 Bot（且限定范围） ---
  [200] state=APPROVED mode=existing_bot bot=writer
  批准的授权范围: tools=["read","write"] 时限=900s 接收人=1人
  授权过期时间: 2026-10-15T17:43:08.453Z

--- 7. 指派不在 B 目录中的 Bot（应被拒） ---
  [403] BOT_NOT_IN_DIRECTORY

--- 8. 重复批准同一任务（应被拒） ---
  [409] VERSION_CONFLICT

--- 10. A 取消任务，确认撤权版本递增 ---
  [200] state=CANCELLED revocationVersion=1（0→1，本地执行器据此拒绝继续）

--- 11. 已完成/已取消任务不可再推进 ---
  [409] ALREADY_TERMINAL

--- 12. 非成员无法读任务 ---
  真实 task: [404] 伪造 id: [404]  两者响应一致: true

--- 13. 任务事件流（群可见，不含私有细节） ---
  事件: task.created → task.approved → task.cancelled
  事件流是否泄漏 workDir/路径: 否
```

## 未完成与风险

| 项 | 状态 |
|---|---|
| **真实的本地 Bot 执行** | **未做，且不可能由 Hub 完成**。Hub 只记录意图、同意与状态；实际执行在 B 的机器上，归 F-11/F-13 与 A-08。**本任务的全部结论仅限于"Hub 侧的授权与状态"，不能表述为"跨用户委派已可用"** |
| 一次性授权凭据 / nonce | **未实现**。`approvals` 表有 `grant_nonce_hash` 列但未使用，归 H-09 |
| 任务进度上报（`task.progress`） | 事件类型已列入白名单，但**无生产者**。本地执行器上报进度的路由未实现（`RUNNING` → `REVIEW_REQUIRED` 目前只能由原生 store 调用推进） |
| `task.shared` 与成果分享 | 未实现，归 H-11/A-09 |
| 审批过期清理的自动调度 | `expireStaleApprovals` 已实现并测试，但**没有定时任务调用它**；目前需要外部触发 |
| 任务与群记忆的关联 | 未做，归 H-10 |
| 双机真实委派 | 未做，归 Q-01（N 级证据） |
| 任务级限流 | 未实现（与已有欠账同源） |

**必须明确记录的一条边界：** 本轮证明的是"Hub 不会让工作在没有 B 本人批准的情况下启动"。它**没有**证明"B 的机器在批准后确实执行了、并且只按批准范围执行"——那需要 F-11（Task Session 身份）、F-13（工具 guard）与 A-07（Bridge 验签），且必须在两台真实电脑上验证。

## 下一步

H-09（授权凭据/nonce/一次性派发与撤销广播），依赖 H-08。它将填上"批准之后如何把授权安全地交给 B 的机器"这一环。
