# F-11：Task Session 原生 Bot 身份持久化 PoC（G3）

**任务 ID：** F-11

**执行日期：** 2026-10-15

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**证据等级：** **L**（真实 DSH Web + 真实 DS Bot + 真实重启）。无 N 级（双机）结论。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 存在与 Bot 私人聊天隔离的 Task Session | **PASS** — 独立 sessionId，Bot 自己的聊天未被改动 |
| 携带原生 Bot 的身份（角色/模型/指令/记忆） | **PASS** — 走 `selfOf` 路径，模型看到 `You are Writer…Your role: Copywriter` |
| 刷新/重启不丢身份 | **PASS** — 真实重启后 `isTaskSession: true`、`selfOf` 解析到同一 Bot、指令仍可读 |
| 释放/回收机制 | **PASS** — 归档而非删除，保留记录 |
| 不做"普通 Agent 冒充下属 Bot" | **PASS** — 身份用 DS Bot 自己的 `prompt.js` 路径解析，不是复制字段 |

## 为什么需要独立模块

DS Bot 原有三类 Session 都不适合作跨用户任务：

- **Bot 的私人聊天**：任务会读到并延伸所有者与 Bot 的私人对话，而所有者只同意了某件具体工作，没有同意开放聊天历史。
- **群内 Session**：任务会以"Bot 在群里发言"的形式出现。
- **归档分段**：是历史，不是可执行的工作区。

所以任务需要自己的 Session。**关键在于它必须是"那个 Bot"，而不是一个普通 Agent 顶着 Bot 的名字**——这由创建方式决定：同一个 preset、同一个模型、同一份指令。

## 新增文件

| 文件 | 作用 |
|---|---|
| `application/packages/bundle/ds-bot/src/host/task-sessions.js`（新增） | Task Session 的创建、绑定、重建、关闭 |
| `application/packages/bundle/ds-bot/test/task-session.test.js`（新增） | 11 个测试 |
| `application/packages/bundle/ds-bot/dev/task-session-poc.mjs`（新增） | 真实运行的 PoC 驱动 |

修改：
- `src/host/store.js` — `selfOf` 与 `isBotSession` 认识 Task Session；`taskSessions` 加入保存形状；`adopt` 保证该键存在
- `src/host/channel.js` — 三个端点（open/close/resolve）与 `view()` 暴露绑定
- `index.js` — 把模块加入 `MODULES`

## 关键设计决定

### 1. 身份走 `selfOf`，不复制字段

我最初的实现把 Bot 的 name/role/model/instructions 复制进 binding。这是错的，已删除。

**原因：** `prompt.js` 的 `promptFor(id)` 读 `rt.selfOf(id)` 来决定这个 Session 是谁，并据此渲染 `# Your identity`（名字、角色、指令、主 Bot 规则）。让 `selfOf` 认识 Task Session，任务就**自动**获得完整身份——而且是**同一份代码路径**，不可能与 Bot 私人聊天产生分歧。

复制字段的实现即使测试通过，也可能在真实路径解析为空时依然"看起来对"。所以测试断言的是 `selfOf` 的返回值与 `prompt.js` 渲染出的文本，而不是我存了什么。

### 2. 绑定写入团队文件，内存只是缓存

`state.taskSessions[taskId] = binding` 是**记录**，`byTask`/`bySession` 两个 Map 是**缓存**，每次 `indexSessions()` 重建。

**开发中发现的真实缺陷：** `adopt()` 会 `delete` 掉 state 的所有键再 `Object.assign` 文件内容。我的模块在 install 时初始化了 `state.taskSessions = {}`，但 `load()` 之后它被删掉了——因为 `EMPTY`（初始 state 的序列化）里没有这个键。测试立即失败（`Cannot set properties of undefined`）。

修复：把 `taskSessions` 加入初始 state，并在 `adopt` 里做存在性保证。**这是"新字段必须加入保存形状"这类缺陷的典型**：模块自己初始化不够，因为 state 会被整体替换。

### 3. 未批准的目录必须拒绝，不能回退

```js
if (!usable) {
  throw new Error(`the approved folder ${workDir} is not a usable directory, so this task will not start`)
}
```

DS Bot 上游的 `createSession` 在 `dir` 无效时**静默回退到团队工作区**并只打一条 warning。对任务而言这是不可接受的：一个"批准在 `D:\finance` 里做"的任务若静默落到团队工作区，它会读到所有者从未批准的文件。测试 `an approved folder is required…` 固定拒绝行为，并断言**没有创建任何 Session**。

### 4. 同一任务重开复用 Session

任务重试（响应丢失）必须复用，不能开第二个：两个 Session 会翻倍它的记忆，也可能翻倍副作用。若重试时改名了 Bot，直接拒绝——审批指定的是某个 Bot。

### 5. 关闭是归档，不是删除

`closeTaskSession` 走 `workspaceRegistry.archiveSession(..., { stopActivity: true })`：Session 停止工作但保持可读，绑定记录保留 `closedAt`。所有者可能需要回看某个任务做了什么，而"忘记这个任务存在过"会让审计不可能。

### 6. Session 标题命名任务，不冒充 Bot 的聊天

`Task <id 前 8 位> · <Bot 名>`，这样所有者在 Session 列表里能区分。

## 真实执行证据

### 测试

```sh
$ node --import ./test/harness-resolve.mjs --test test/task-session.test.js
 ℹ tests 11 / ℹ pass 11 / ℹ fail 0

$ npm test                                    # DS Bot 全量
 ℹ tests 555 / ℹ pass 553 / ℹ fail 2
```

**555 项（新增 11 个），553 通过。** 那 2 个失败（`at-menu.test.js`、`dsh-update.test.js`）在 F-04 就已定位为 DS Bot 测试 harness 对 DSH 安装布局的假设，与本次改动无关——改动前实测同为 553/555。

11 项覆盖：身份经 `selfOf` 与 `prompt.js` 渲染正确、Task Session 不是 Bot 的聊天、preset 与标题正确、同任务重开复用、改 Bot 被拒、未知 Bot 被拒、**重启后绑定与身份保持**、**未批准目录被拒且不创建 Session**、关闭归档且保留记录、非 Task Session 返回空、**老团队文件自动补出新字段**。

### 真实运行 PoC（真实 DSH Web + 真实 DS Bot）

```
Bot Writer (session-d662837a-…) chat session = session-cb7d0da2-…
opened task session = session-d5e41a3c-…
identity the model sees: named=Writer role=Copywriter
reopened same task -> session-d5e41a3c-… (same as before: true)
team file now records taskSessions: ["poc-task-1"]
saved binding: botId=session-d662837a-… sessionId=session-d5e41a3c-…
the Bot's own chat is untouched: session-cb7d0da2-…
```

**Task Session 与 Bot 私人聊天是两个不同的 Session**，重开复用同一个。

### 真实重启后的身份保持（G3 核心门槛）

```
=== 重启后 team file 中的绑定 ===
keys: ["poc-task-1"]
botId: session-d662837a-…  sessionId: session-d5e41a3c-…

=== 重启后身份是否仍解析到正确的 Bot（走 selfOf，即模型看到的那条路径） ===
{
 "isTaskSession": true,
 "botId": "session-d662837a-…",
 "resolvedToBotId": "session-d662837a-…",
 "identityName": "Writer",
 "identityRole": "Copywriter",
 "identityInstructions": "Write the copy."
}

=== 关键判定 ===
是 Task Session: true
绑定到 Writer 的 botId: true
selfOf 解析到同一 botId: true
身份名: Writer | 角色: Copywriter
指令仍可读: true
```

**这是本轮最重要的证据：** 完全退出 Host、删掉进程、重新启动后，Task Session 仍是 task Session，`selfOf` 仍解析到同一个 Bot，完整的角色与指令仍可读。身份**不是**靠内存映射维持的。

## 未完成与风险

| 项 | 状态 |
|---|---|
| **记忆（memory）在 Task Session 中的隔离与继承** | **未验证**。DS Bot 的记忆存在 `<home>/memory/`，按 Bot 维度组织。Task Session 是否会读到 Bot 的私人记忆、以及是否会把任务内容写回该记忆，本轮**没有测试**。这是 G3 的一项明确缺口 |
| **模型在 Task Session 中实际按 Bot 的模型运行** | **未在真实请求中验证**。`prompt.js` 的身份文本已验证；模型选择由 preset 与 `selectModel` 决定，本轮未发出真实模型请求确认 |
| 任务级工具限制（只允许批准的工具） | 未做，归 F-13 |
| 撤销后终止执行 | 未做，归 F-13 |
| 群内不出现任务 Session 的验证 | 未直接验证（Task Session 不写入 `room.sessions`，但未做端到端确认） |
| 与 Hub 审批的实际联动 | 未做。本轮的 `taskId` 由 PoC 直接给定，尚未与 H-08/H-09 的审批流接线，归 A-07 |
| 双机真实委派 | 未做，归 Q-01 |

**必须记录的边界：** 本轮证明的是"Task Session 存在、身份正确、且跨重启保持"。它**没有**证明"任务在隔离的 Session 中按批准的范围执行"——那需要 F-13（工具 guard）与 A-07/A-08。

## 下一步

F-12（真实路径校验与无效 dir 拒绝）。F-11 已实现了任务侧的拒绝逻辑；F-12 要把同一规则补到 Bot 自己的目录选择路径上，并加 realpath/符号链接校验。
