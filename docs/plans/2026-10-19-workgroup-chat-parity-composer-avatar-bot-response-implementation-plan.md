# Implementation Plan

**Feature:** 工作群与原群聊能力对齐（群头像 / 输入框 / 自己的 Bot 可接任务 / Bot 回复进入会话）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作群的功能与原群聊一致：群头像使用原群聊式集群头像，输入框可正常输入且占满整行/支持多行，`@` 自己的 Bot 能生成任务并由本人审批执行，Bot 的结果以会话气泡形式出现而不是只留任务卡。

**Architecture:** 客户端改工作群复制件（`workgroup-ui/`、`workgroup-sidebar.js`、`workgroup-pane.js`、`workgroup-style.js`）；服务端移除 `SELF_TASK`，并为 Bot 输出新增 `messages.sender_bot_id`、owner-only `POST /tasks/{id}/result`、`share` 后写房间消息。所有 Bot 任务仍走 `PENDING_APPROVAL → APPROVED → 执行 → share`，授权与审计不变。

**Tech Stack:** Node.js 24、React 18 `h()`、DSH/Cordis slots、Vitest + jsdom、Node test runner、esbuild 客户端打包（`scripts/build-client.mjs` / `build-lib.mjs`）。

## Global Constraints

- 需求基线：以当前仓库原群聊代码为唯一基线；工作群是复制件，**原群聊代码、样式、行为与测试保持不变**。
- 用户已确认：工作群要有原群聊的基本能力，**自己的 Bot 也必须能接任务**。`SELF_TASK` 拒绝只是 Hub 曾为“跨用户委派”设下的限制，与工作群复刻原群聊的目标冲突，本计划移除该限制（见 Step 4）。
- 不改 DSH Agent Loop，不新增第二条执行路径；任何 Bot（含自己的）任务仍经 `PENDING_APPROVAL → APPROVED → 执行 → REVIEW_REQUIRED → share`，授权、TTL、吊销与审计全部保留。
- **本次允许修改 `server/`**：为了让 Bot 的回复进入会话（原群聊的基本行为），需要新增 `messages.sender_bot_id`、owner-only 结果上报与 `share` 后写消息。协议变更必须同步 `server/contracts/openapi.yaml` 与服务端用例。
- 所有用户可见文案必须经 `t()`，并在 `application/packages/bundle/ds-bot/src/client/i18n.js` 增加中文条目。
- 修改 `src/client` 后必须重新生成 `application/packages/bundle/ds-bot/client.js`（`node scripts/build-client.mjs`）。
- 不新增第三条样式体系：所有新增规则使用既有 `--bt-*` token 与既有类名约定。
- 不做顺手重构；`workgroup-style.js` 只删除“在合并后确实无人渲染”的规则，不重命名仍被使用的类。
- 工作区已有未提交改动；执行时只触碰本计划列出的文件，不回滚既有改动。
- 未获用户明确指示，不提交、不推送。
- 已知基线：`packages/bundle/ds-bot/test/workgroup-css.test.js` 断言的是旧表 `WORKGROUP_CSS`，本计划会显式调整它，属于“测试随行为变更”，不是范围扩大。
- Hub 契约一致性：移除 `SELF_TASK` 后必须同步 `server/tests/h08-tasks.test.js`、`server/tests/e-mention-attachment.test.js` 与 `server/contracts/openapi.yaml` 的任务接口说明，否则契约与测试会与实现不符。
- 头像限制（用户已确认接受）：当前没有用户登录/注册，跨用户没有真实头像，Hub `RoomBot` 也不携带 avatar/shape/color；因此**样式与原群聊一致、色彩按 `botId` 稳定派生**，不承诺跨用户还原真实角色。

---

## 1. Goal

### 1.0 大前提（用户明确要求）

**工作群的功能必须与原群聊一致。** 与 Bot 对话是最基本的功能，不能因为“工作群 = 跨用户协作”就把它降级为“只能生成任务卡”。任何与原群聊不一致的地方都算缺陷，而不是“设计差异”。

因此本次修改的目标不是“修三个 UI bug”，而是**按原群聊基线逐项对齐工作群的会话能力**，并把三条已确认的具体缺陷作为其中的必答项。

### 1.0.1 原群聊 vs 工作群 能力核实（源码级）

| 能力 | 原群聊实现 | 工作群现状 | 结论 |
| --- | --- | --- | --- |
| 用户发消息 | shell composer → 本地 Session | 自有 `WorkgroupComposer` → Hub `POST /messages` | 有，但输入框布局坏了（缺陷 2） |
| **Bot 回复出现在会话里** | `host/groups.js` `postToRoom()` 把 Bot 回合写进群 Session，`cells.js` `GroupMessage` → `Bubbles` 渲染成 `bt-group-msg` 气泡 | **没有**。Hub `messages.sender_user_id` 是 `NOT NULL REFERENCES users(id)`，Bot 无法作为消息发送者；任务结果只在 `task_events` 与任务卡里 | **结构性缺失** |
| 差遣自己的 Bot | `mentionsIn()` 直接选成员回答，无“跨用户”限制 | `createTask` 对 `requesterUserId === ownerUserId` 抛 `SELF_TASK` | **被 Hub 拒绝** |
| @ 他人 Bot | 不适用（单机） | 生成 `PENDING_APPROVAL`，owner 审批后执行，`share` 后可见 | 有，但结果不进会话 |
| 群头像 | `RoomAvatar` 集群 | 侧栏三点图标 / 头部默认 mark | 缺陷 1 |
| 群公告 | `room.notice` | 有（`workgroup-ui/details.js`） | 已对齐 |
| 引用/附件/定时 | composer `+` 菜单 | 有（引用/附件/定时），引用他人会话被禁用 | 已对齐（差异有正当理由） |
| 群记忆 | `memory` | 有 | 已对齐 |
| 停止成员工作 | `StopMemberWork` | 有 `data-wg-stop-bot` | 已对齐 |

**核实结论：** 三条已确认缺陷里，第 1、2 条是 UI 缺陷，第 3 条（“Bot 无响应”）的根因比“缺即时反馈”更深——**Bot 的输出在设计上就没有进入会话消息流的通道**，且自己的 Bot 被 `SELF_TASK` 直接拒绝。要让“跟 Bot 聊天”成立，必须同时解决“能被差遣”和“回复能被看见”。

### 1.1 本次修改目标

1. **自己的 Bot 可以接任务**：移除 `SELF_TASK`，让 `@` 自己的 Bot 与原群聊一样生成任务并由本人审批执行。
2. **Bot 的回复进入会话**：Bot 任务完成后，其结果以**消息**形式写入工作群会话（发送者显示为该 Bot），沿用原群聊的 `bt-group-msg` 气泡样式，而不是只留一张任务卡。
3. **群头像与原群聊一致**：侧栏行、头部胶囊、详情成员堆叠使用与原群聊相同的集群几何。
4. **输入框可输入、宽度正常、支持多行**。

### 1.2 不包含

- 不把工作群改成本地 Session 群聊：工作群仍是 Hub 房间，跨用户语义保留。
- 不实现“无审批直接执行他人 Bot”：他人 Bot 仍需其所有者审批，这是安全边界，也与原群聊“单机、Bot 属于自己”等价。
- 不新增用户登录/注册，不新增跨用户真实头像。
- 不重做消息气泡结构、不重做设置/详情（上一轮已完成）。
- 不引入第二条执行路径：Bot 输出仍经 `task → approval → dispatch → result`。

### 1.3 成功标准

1. 在工作群里 `@` 自己的 Bot 并发送：消息成功，生成任务，本人审批后 Bot 执行完毕，**其结果作为一条会话消息出现**（带 Bot 名称与角色头像），而不只是任务卡。
2. `@` 他人 Bot：任务由其所有者审批，执行完成并 `share` 后，结果同样作为会话消息出现。
3. 侧栏行、头部、详情三处头像均为原群聊式集群头像。
4. 输入框可输入、占满整行、自动增高、中文输入法不误发。
5. 相关单测/服务端用例/构建/lint/typecheck 结果如实记录，无新增失败。

## 2. Current Understanding

### 2.1 当前实现方式

**原群聊（基线，只读参考）**

- 会话行 `sidebar.js` `RoomRow` → `mark.js` `RoomAvatar({ room, roster, size: 36 })`，`room.members` 是本地 Bot id 列表，经 `roster.byId` 解析后画成圆形角色集群。
- 头部 `header.js` `HeaderPill` → `RoomAvatar({ room, roster, size: 24 })`。
- 详情 `details-drawer.js` `MemberPile` → `BotMark` 44px 圆盘 + `+N`。
- 输入区**不由 DS Bot 渲染**：是 shell 的 `ui-conversation`（`InputBar.tsx` 的 `data-composer-card`、`ComposerContentEditable.tsx` 的 `data-composer-input`），DS Bot 只用 `styles.js` 的 `[data-composer-card] …!important` 规则重塑外观。

**工作群（复制件，本次要改）**

- 路由：`workgroup-pane.js` `WorkgroupSurface`，4s 轮询 `workgroups.openRoom(roomId)` + `taskEvents` + `workgroupSchedules`。
- 装配：`workgroup.js` → `workgroup-ui/index.js` `WorkgroupConversation`。
- 消息：`workgroup-ui/thread.js`（`WorkgroupThread` / `HumanFace`）。
- 输入：`workgroup-ui/composer.js` `WorkgroupComposer`，手写 `textarea.bt-wg-input`，外层 `div.bt-wg-compose-card[data-composer-card]`。
- 头像：`workgroup-sidebar.js` `WorkgroupRow` 画 `WorkgroupGlyph`（三点矢量图）；`workgroup-ui/index.js` 头部 `RoomAvatar` 传入空 `roster: { byId: {}, bots: [] }` 必然退化为单个默认 mark；`MemberPile` 用 `HumanFace` 与 `BotMark({ look: { shape: 'circle', color: 'blue' } })` 占位。
- 样式：**两份并存**——`client/workgroup-style.js`（`WORKGROUP_CSS`，旧）与 `workgroup-ui/styles.js`（`WORKGROUP_UI_CSS`，新），都在 `client/index.js:986-987` 以 `installCompiledStyles` 安装，且**共用 `.bt-wg-*` 类名**。
- Bot 响应：`composer.js` 收集 `mentions` → `workgroup-pane.js` `onSend` → Host `hub-send` → Hub `POST /rooms/:id/messages` → `proposeTasksForMentions` 建 `PENDING_APPROVAL` 任务 → `activity.js` `TaskCard` 审批 → `task-dispatch.js` 执行 → 结果需 owner `share`。

### 2.2 涉及模块

| 模块 | 角色 |
| --- | --- |
| `packages/bundle/ds-bot/src/client/workgroup-style.js` | 旧工作群样式表 `WORKGROUP_CSS` |
| `packages/bundle/ds-bot/src/client/workgroup-ui/styles.js` | 新工作群样式表 `WORKGROUP_UI_CSS` |
| `packages/bundle/ds-bot/src/client/index.js` | 样式安装顺序、`overlayFace` 注入 |
| `packages/bundle/ds-bot/src/client/workgroup-ui/composer.js` | 输入区组件 |
| `packages/bundle/ds-bot/src/client/workgroup-ui/index.js` | 装配、头部头像、`MemberPile` |
| `packages/bundle/ds-bot/src/client/workgroup-ui/thread.js` | 时间线与消息头像 |
| `packages/bundle/ds-bot/src/client/workgroup-sidebar.js` | 侧栏行（含 `WorkgroupRow`） |
| `packages/bundle/ds-bot/src/client/workgroup-pane.js` | 房间读取、发送与事件订阅 |
| `packages/bundle/ds-bot/src/client/mark.js` | `RoomAvatar` / `BotMark`（复用，不改） |
| `packages/bundle/ds-bot/src/client/characters.js` | `lookOf` / `defaultShape` / `colorOf`（复用，不改） |
| `integrations/workgroup/client/index.mjs` | `openRoom` 返回 `{ room, members, bots, messages, tasks, head }`；`reduceWorkgroup` 归约 `task.*` |
| `server/src/api/messages.js` | `proposedTasks` 返回（不改，仅消费）；`SELF_TASK` 经 `taskFailure` 映射，Step 4 移除该映射 |
| `server/src/api/tasks.js` | 结果发布路由：Step 5 新增“把结果写成房间消息” |
| `server/src/modules/messages/store.js` | Step 5 需要支持 Bot 作为消息发送者 |
| `server/db/migrations/` | Step 5 新增迁移：`messages` 支持 `sender_bot_id` |

### 2.3 数据流 / 调用链

```
发送：
WorkgroupComposer.send()
  → onSend(text, reply, { mentions, attachments, clientMessageId })
  → WorkgroupSurface.onSend → view.current({ send, replyToMessageId, mentions, attachments })
  → workgroups.sendMessage(roomId, ...)      [client/workgroup-hub.js invoke('hub-send')]
  → Host hub-send                             [src/host/workgroup-hub.js]
  → workgroup.sendMessage                     [integrations/workgroup/client/index.mjs]
  → POST /api/v1/rooms/:roomId/messages       [server/src/api/messages.js]
  → sendMessage + proposeTasksForMentions
  → 响应 { message, duplicate, proposedTasks? }   —— 当前客户端丢弃 proposedTasks
  → WorkgroupSurface 随后 await load()         —— 4s 轮询之外的一次主动重读

实时：
Host bridge → remote 'workgroup/event' → workgroupHub.applyEvent
  → reduceWorkgroup(state, event)            —— 已支持 task.approval_requested/approved/progress/shared
  → roomSource(roomId).set(next)
  → useWorkgroupRoom(roomId)                  —— overlayFace.keyedHooks.workgroupRoom 已注册
  → WorkgroupPane.roomSnapshot → WorkgroupSurface.state
```

### 2.4 已确认影响范围

- 侧栏行：`workgroup-sidebar.js` `WorkgroupRow` 的 `bt-row-ava` 分支。
- 头部与详情：`workgroup-ui/index.js` 的 `RoomAvatar` 调用与 `MemberPile`。
- 输入区：`workgroup-ui/styles.js` 的 `.bt-wg-compose*` / `.bt-wg-input` / `.bt-wg-send` 规则，与 `workgroup-style.js` 中同名规则。
- 样式冲突：两份表同时安装，后者覆盖前者；`styles.js` 的 `[data-composer-card] …!important` 亦会压过工作群自身规则。
- Bot 响应：`composer.js` 的 `send()` 失败分支只显示 `error.message`；`workgroup-pane.js` 的 `onSend` 丢弃响应体，仅 `await load()`。

### 2.5 需求 / 代码不一致

1. **跨用户 Bot 头像**：Hub `RoomBot` 契约无 avatar/shape/color（`server/contracts/openapi.yaml`、`server/db/migrations/0003_bot_directory.sql`、`0014_workgroup_parity.sql`），且当前产品没有用户登录/注册，跨用户不存在真实头像。结论：跨用户 Bot 的“真实外观”在协议上不存在。**用户已确认接受**：样式与原群聊一致，颜色按 `botId` 稳定派生；不扩展 Hub 协议。
2. **“Bot 无响应”并非 Bot 真不工作**：现有链路要求“他人 Bot → 所有者审批 → 执行 → owner 主动 `share`”，任一步未完成，群内都不会出现 Bot 发言。截图二（`@Chief` 后无任何卡片）暴露的是**客户端缺少“已生成待审批任务”的即时可见性**，而非执行缺失。本计划修可见性，并对自己的 Bot 补齐可执行性（见第 3 条），不改他人任务的审批模型。
3. **`SELF_TASK` 与工作群目标冲突（用户已指出并确认）**：Hub 在 `createTask` 中对 `requesterUserId === ownerUserId` 直接抛 `SELF_TASK`（`server/src/modules/tasks/store.js:194-195`），导致“@ 自己的 Bot”整条消息以 409 被拒。但工作群要复刻原群聊的基本能力，**原群聊里用户可以随时差遣自己的 Bot**，因此该限制必须移除：自己的 Bot 任务应由本人审批执行，而不是被拒绝。
   - 该规则原本是“跨用户委派”的语义保护（任务=请求他人），加在通用 `createTask` 上导致误伤。
   - 移除后安全边界不变：`decideTask` 仍要求 `task.owner_user_id === approverUserId`（`store.js:301`），自己的任务即“本人审批本人执行”，与在原群聊里直接对自己的 Bot 下指令等价；授权、TTL、吊销、审计照旧。
4. **Bot 输出没有进入会话的通道（最重要）**：Hub 的 `messages` 表 `sender_user_id TEXT NOT NULL REFERENCES users(id)`（`server/db/migrations/0001_schema.sql:51-52`），Bot 不是 `users` 行，因此**无法以 Bot 身份写一条消息**。任务结果只存在 `tasks`/`task_events`，`progressUpdate()` 明确不发布结果内容（`integrations/workgroup/bot-adapter/flows.mjs:243-246`），`share` 路由也不写消息（`server/src/api/tasks.js` 全文无 `INSERT INTO messages`）。而原群聊的 Bot 回复是**会话气泡**（`host/groups.js` `postToRoom()` → `cells.js` `Bubbles`）。结论：要让“跟 Bot 聊天”成立，必须新增“Bot 结果 → 房间消息”的通道，这是本次需求的核心结构改动，不是 UI 修补。
   - 需同步的既有断言：`server/tests/h08-tasks.test.js:157-165`、`server/tests/e-mention-attachment.test.js:191-207`、`server/src/api/tasks.js:33,56` 的映射与注释、`server/contracts/openapi.yaml` 的任务接口说明。

---

## 3. Implementation Steps

**执行顺序与依赖：** Step 1 → 2 → 3 是客户端独立修补，可先完成并自验；Step 4 解除 `SELF_TASK` 是 Step 5 的语义前提（自己的 Bot 必须先能建任务）；Step 5 引入服务端迁移与新路由，是本次最大的一块；Step 6 在全部代码完成后统一跑测试与重建产物。


### Step 1

#### Target

- 文件：`packages/bundle/ds-bot/src/client/workgroup-style.js`、`packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`、`packages/bundle/ds-bot/src/client/index.js`
- 模块：工作群样式安装与规则归属
- 函数 / Component / Service：`WORKGROUP_CSS`、`WORKGROUP_UI_CSS`、`installShell()`（`client/index.js:976-990`）

#### Current Behavior

`client/index.js:986-987` 同时安装两份表：

```js
installCompiledStyles(WORKGROUP_CSS, 'workgroups'),
installCompiledStyles(WORKGROUP_UI_CSS, 'workgroup-ui'),
```

两份表定义同名规则且值不同：

```css
/* workgroup-style.js（旧） */
.bt-wg-input{flex:1;min-height:40px;max-height:160px;resize:none;box-sizing:border-box;border-radius:12px;border:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-ink);font:inherit;line-height:20px;padding:10px 12px}
.bt-wg-compose{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 16px 16px;border-top:.5px solid var(--bt-line-weak)}

/* workgroup-ui/styles.js（新） */
.bt-wg-compose{position:relative;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 16px 14px;border-top:.5px solid var(--bt-line-weak)}
.bt-wg-compose-card .bt-wg-input{flex:1;min-height:32px;max-height:160px;...;padding:6px 4px}
```

旧表还有 `.bt-wg-message{...}`、`.bt-wg-member{...}`、`.bt-wg-attach{...}` 等已无渲染方的规则（新结构改用 `bt-group-msg` / `bt-umsg` / `bt-wg-members`）。

已核实的渲染方：`bt-wg-pane`（`workgroup-pane.js`）、`bt-wg-empty`（`thread.js` / `workgroup-pane.js`）、`bt-wg-name`（`workgroup-pane.js`）、`bt-wg-offline`（`workgroup-pane.js`）、`bt-wg-members`（`workgroup.js` `WorkgroupMembers`）、`bt-wg-tasks`（`activity.js`）、`bt-wg-quote` / `bt-wg-replying` / `bt-wg-message-failed` / `bt-wg-input` / `bt-wg-send` / `bt-wg-mentions` / `bt-wg-pending`（新 `workgroup-ui/`）。

#### Change

1. 把新 `workgroup-ui/` 结构仍在使用的旧表规则迁入 `workgroup-ui/styles.js`：`.bt-wg-pane`（仅 `box-sizing`，保留 `workgroup-css.test.js` 的“不重述 position”约束）、`.bt-wg-empty`、`.bt-wg-name`、`.bt-wg-offline .bt-wg-empty`、`.bt-wg-offline .bt-wg-name`、`.bt-wg-members` 系列、`.bt-wg-member*` 系列、`.bt-wg-tasks`、`.bt-wg-quote*`、`.bt-wg-replying*`、`.bt-wg-message-failed`、`.bt-wg-mentions` / `.bt-wg-mention*`、`.bt-wg-pending*`、`.bt-wg-attach-input`（保持新 composer 的隐藏 input 规则）。
2. 删除旧表中无人渲染的规则：`.bt-wg-message`、`.bt-wg-message-who`、`.bt-wg-message-body`、`.bt-wg-message-own`、`.bt-wg-reply`、`.bt-wg-attach`（非 input）、`.bt-wg-settings`、`.bt-wg-identity*`、`.bt-wg-gear`、`.bt-wg-notice`、`.bt-wg-unread`、`.bt-wg-approval*`、`.bt-wg-review`、`.bt-wg-approve` / `.bt-wg-reject`（后两者被新 `activity.js` 使用，**保留并迁入**）。
3. `workgroup-style.js` 收敛为只保留 `WORKGROUP_CSS` 中“工作群页脚/离线态”仍被 `workgroup-pane.js` 渲染的少量规则；若迁移后为空，则删除该文件与 `client/index.js` 的导入与安装行。
4. `client/index.js` 只安装一份工作群样式表；若删除文件，同时去掉 `import { WORKGROUP_CSS } from './workgroup-style.js'`（`index.js:40`）与 `installCompiledStyles(WORKGROUP_CSS, 'workgroups')`（`index.js:986`）。
5. 保持 `installCompiledStyles` 的 tag 唯一，避免同一 tag 重复注入。

#### Reason

同名类两份表并存导致“谁后装谁生效”，是输入框塌陷与几何不一致的根因；不先收敛，Step 2 的宽度/高度修复会被旧规则或 `!important` 覆盖。

#### Risk

- 迁移遗漏会留下无样式元素（`bt-wg-members`、`bt-wg-tasks` 等正文区）。
- `workgroup-css.test.js` 直接 `import { WORKGROUP_CSS }` 并断言 `.bt-wg-pane{`、`.bt-wg-member-online/offline`、`.bt-wg-offline` 计数、无自有颜色；删除文件会让测试失败，必须在 Step 5 同步调整。
- 旧表若仍被其它未发现的调用方引用，删除会运行时报错；已核实只有 `client/index.js` 与 `test/workgroup-css.test.js` 引用（见 2.2）。

#### Verification

```bash
# 迁移完整性：新表中必须存在所有仍被渲染的 .bt-wg-* 类
for c in bt-wg-pane bt-wg-empty bt-wg-name bt-wg-offline bt-wg-members bt-wg-member bt-wg-tasks \
         bt-wg-quote bt-wg-replying bt-wg-message-failed bt-wg-mentions bt-wg-mention \
         bt-wg-pending bt-wg-input bt-wg-send bt-wg-compose bt-wg-compose-card \
         bt-wg-approve bt-wg-reject bt-human-face; do
  grep -q "\.$c" packages/bundle/ds-bot/src/client/workgroup-ui/styles.js || echo "MISSING $c"
done
# 旧文件引用清零（若已删除）
grep -rn "workgroup-style" packages/bundle/ds-bot/src packages/bundle/ds-bot/test || echo "no references"
```

预期：无 `MISSING` 输出；`workgroup-style.js` 删除后无残留引用（测试文件在 Step 5 调整前会命中，属预期）。

---

### Step 2

#### Target

- 文件：`packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`、`packages/bundle/ds-bot/src/client/workgroup-ui/composer.js`
- 模块：工作群输入区布局与交互
- 函数 / Component：`WorkgroupComposer`、`.bt-wg-compose` / `.bt-wg-compose-card` / `.bt-wg-input` / `.bt-wg-send`

#### Current Behavior

- `.bt-wg-compose-card` 只有 `display:flex; align-items:flex-end; padding:5px 6px`，无 `width:100%`；父级 `.bt-wg-compose` 为 `flex-direction:column`，卡片按内容宽度收缩。
- `.bt-wg-input` 只在 `.bt-wg-compose-card .bt-wg-input` 下得到 `flex:1`，并被旧表 `.bt-wg-input{flex:1;min-height:40px;border:…;padding:10px 12px}` 干扰（同名不同值）。
- `composer.js` 的 textarea 固定 `rows: 1`，无自动增高：

```js
h('textarea', {
  className: 'bt-wg-input',
  'data-wg-input': 'message',
  value: draft,
  rows: 1,
  onChange: event => { setDraft(event.target.value); trackMention(event.target.value) },
  onKeyDown: (event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
  },
})
```

- `disabled` 由 Hub 状态推导：`disabled: hubState !== undefined && hubState !== 'live' && hubState !== 'unknown'`（`workgroup-ui/index.js:286`）。

#### Change

1. `styles.js` 中把输入卡片改为占满容器：

```css
.bt-wg-compose-card{display:flex;align-items:flex-end;gap:4px;width:100%;box-sizing:border-box;padding:5px 6px;border-radius:20px;border:.5px solid var(--bt-line-2);background:var(--bt-card);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.bt-wg-compose-card .bt-wg-input{flex:1 1 auto;min-width:0;width:100%;min-height:32px;max-height:160px;resize:none;box-sizing:border-box;border:0;outline:none;background:transparent;color:var(--bt-ink);font:inherit;line-height:20px;padding:6px 4px;overflow-y:auto}
```

2. `composer.js` 增加一个 ref 与自动增高效果，保留 `rows: 1` 作为初始高度来源：

```js
const input = useRef(null)

// The box grows with the draft up to the stylesheet's max-height, then scrolls. Measuring after
// every change is what keeps a pasted paragraph from staying a single line.
useEffect(() => {
  const node = input.current
  if (node === null) return
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, 160)}px`
}, [draft])
```

并在 textarea 上挂 `ref: input`；`room?.id` 切换时（已有的重置 effect）同时把高度复位：

```js
useEffect(() => {
  pendingSend.current = undefined
  setDraft('')
  setPicked([])
  setAttachments([])
  setMentionQuery(undefined)
  setFailed(false)
  setNote(undefined)
  if (input.current !== null) input.current.style.height = 'auto'
}, [room?.id])
```

3. 保留 `Enter` 发送 / `Shift+Enter` 换行与 `isComposing` 判断不变（已有逻辑，不重写）。

#### Reason

输入框“很短且无法输入”的直接原因是卡片不占宽、textarea 不 `flex:1`、且无自动增高；修好布局后多行输入才符合原群聊行为。

#### Risk

- 自动增高与 `max-height:160px` 冲突时可能出现双滚动条；实现中高度用 `Math.min(scrollHeight, 160)`，超过即由 `overflow-y:auto` 接管。
- `useEffect` 依赖 `draft`，若未来引入受控回填（如草稿恢复）需确认高度同步；当前没有该路径。
- `disabled` 语义不变，避免把“Hub 离线”误改成可输入。

#### Verification

```bash
node --test packages/bundle/ds-bot/test/i18n.test.js
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```

手工/截图：输入 1 行、5 行、20 行文本，确认高度从 32px 增至 160px 后内部滚动；`Shift+Enter` 换行不发送；中文输入法组词按 Enter 不发送。

---

### Step 3

#### Target

- 文件：`packages/bundle/ds-bot/src/client/workgroup-ui/model.js`、`packages/bundle/ds-bot/src/client/workgroup-ui/thread.js`、`packages/bundle/ds-bot/src/client/workgroup-ui/index.js`、`packages/bundle/ds-bot/src/client/workgroup-sidebar.js`、`packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
- 模块：工作群群头像（侧栏行 / 头部胶囊 / 详情成员堆叠）
- 函数 / Component：`seatBots`、`avatarFaces`、`WorkgroupAvatar`、`WorkgroupRow`、`MemberPile`

#### Current Behavior

侧栏 `workgroup-sidebar.js`：

```js
h('span', { className: 'bt-row-ava bt-wg-row-ava' },
  h(WorkgroupGlyph, { size: 20 }),
  h('span', { className: 'bt-wg-hub-dot', 'data-hub': hubState, 'aria-hidden': true })),
```

头部（`workgroup-ui/index.js`）传入空 roster，`RoomAvatar` 必然走 `people.length === 0` 分支退化为 `BotMark`：

```js
h(RoomAvatar, {
  room: { ...room, members: (members ?? []).map(member => member.userId) },
  roster: { byId: {}, bots: [] }, size: 24,
})
```

`MemberPile` 用占位 look：

```js
node: h(BotMark, { look: { shape: 'circle', color: 'blue' }, size: 44, live: false }),
```

#### Change

已核实的三条约束决定了实现方式，不能按“直接调 `RoomAvatar`”动手：

1. `RoomAvatar`（`mark.js:133-164`）先做 `room.members.map(id => roster.byId[id]).filter(Boolean)`，**未知 id 会被丢弃**；`people.length === 0` 时退化为 `h(BotMark, { size })`。所以传空 `roster` 或传用户 id 都不会得到集群。
2. `RoomAvatar` 的每个座位只渲染 `BotMark`，不渲染人形；`bt-cluster-you` 只是“没有 Bot 的座位”占位。
3. `BotMark` 的外观由 `lookOf(bot)` 决定（`mark.js:50`），`lookOf` 只读 `bot.avatar` / `bot.id` / `bot.color`（`characters.js:68-75`）。传 `look` 字段无效。

因此**为工作群复制一份集群头像**（符合“复制后独立演进”原则，且不改原群聊 `mark.js`）：

1. 在 `workgroup-ui/model.js` 增加两个纯函数（无 React、无 DOM）：

```js
/**
 * The Bots a workgroup avatar may seat, keyed for `roster.byId`.
 *
 * The Hub publishes a Bot's name and presence, not its character: `RoomBot` has no avatar, shape,
 * or colour. A Bot this machine owns is therefore taken from the local roster so it looks exactly
 * as it does in the original group chat; anyone else's Bot gets the stable look `lookOf({ id })`
 * derives from its `botId`, which is the same on every render and every reload.
 *
 * @param {{ ownerUserId: string, botId: string, displayName?: string }[]} bots the room's Bots
 * @param {{ byId?: Record<string, object> }} [local] this machine's own roster
 * @returns {{ seats: object[], roster: { byId: Record<string, object>, bots: object[] } }}
 */
export function seatBots(bots, local) {
  const seats = (bots ?? []).map((bot) => {
    const known = local?.byId?.[bot.botId]
    const id = `wg:${bot.ownerUserId}:${bot.botId}`
    // `lookOf` reads `avatar`, `id` and `color`; copying only those keeps the local Bot's real
    // character without republishing the rest of a private roster entry into a shared room.
    const seat = known === undefined
      ? { id: bot.botId, name: bot.displayName ?? bot.botId }
      : { id: known.id ?? bot.botId, name: known.name ?? bot.displayName ?? bot.botId, avatar: known.avatar, color: known.color }
    return { key: id, seat, name: bot.displayName ?? bot.botId }
  })
  return {
    seats,
    roster: { byId: Object.fromEntries(seats.map(entry => [entry.key, entry.seat])), bots: seats.map(entry => entry.seat) },
  }
}

/**
 * The faces a workgroup avatar shows: people first, then the room's Bots, capped at `max`.
 *
 * Kept as data rather than markup so the sidebar row, the header pill, and the details pile can
 * slice the same list the same way, and so the rule is testable without a DOM.
 *
 * @returns {{ faces: object[], more: number }} the seats to draw, and how many did not fit
 */
export function avatarFaces(members, bots, max = 4) {
  const people = (members ?? []).map(member => ({ kind: 'person', userId: member.userId, name: member.displayName ?? member.userId }))
  const machines = (bots ?? []).map(bot => ({ kind: 'bot', ownerUserId: bot.ownerUserId, botId: bot.botId, name: bot.displayName ?? bot.botId }))
  const all = [...people, ...machines]
  const faces = all.length > max ? all.slice(0, max - 1) : all
  return { faces, more: all.length - faces.length }
}
```

2. 在 `workgroup-ui/thread.js`（已导出 `HumanFace`）旁新增工作群自己的集群头像，复用 `BotMark` 与既有 `bt-cluster*` / `bt-stack*` 全局类：

```js
/** The group's face: people as initial discs, Bots as their characters, up to four seats. */
export function WorkgroupAvatar({ members, bots, local, size = 36 }) {
  const { roster } = seatBots(bots, local)
  const { faces, more } = avatarFaces(members, bots, 4)
  const botOf = face => roster.byId[`wg:${face.ownerUserId}:${face.botId}`]
  const faceOf = (face, seatSize) => (face.kind === 'person'
    ? h(HumanFace, { name: face.name, size: seatSize })
    : h(BotMark, { bot: botOf(face), size: seatSize }))
  const keyOf = (face, index) => (face?.kind === 'person' ? `p:${face.userId}` : face?.kind === 'bot' ? `b:${face.ownerUserId}:${face.botId}` : `s:${index}`)
  // Inline sizes line up rather than cluster, exactly as the original room avatar does below 20px.
  if (size <= 20 && faces.length > 1) {
    return h('span', { className: 'bt-stack', style: { '--bt-stack-size': `${size}px` } },
      faces.slice(0, 3).map((face, index) => h('span', { key: keyOf(face, index), className: 'bt-stack-face' }, faceOf(face, size))),
      faces.length > 3 ? h('span', { className: 'bt-stack-more' }, `+${faces.length - 3}`) : null)
  }
  const seats = clusterSeats(Math.min(faces.length, 4), size)
  return h('span', { className: 'bt-cluster', style: { width: size, height: size } },
    seats.map(([x, y, s], index) => (index === 3 && more > 0
      ? h('span', { key: 'more', className: 'bt-cluster-more', style: { position: 'absolute', left: x, top: y, width: s, height: s, fontSize: Math.max(8, Math.round(s * 0.36)) } }, `+${more}`)
      : h('span', { key: keyOf(faces[index], index), style: { position: 'absolute', left: x, top: y, width: s, height: s } }, faceOf(faces[index], s)))))
}
```

`clusterSeats` 从 `mark.js` 复制（该函数未导出）。每个座位用自己的尺寸 `s` 渲染 `faceOf`，外层 `size` 只用于容器与行内图标；`more` 只在 `clusterSeats` 的第 4 个座位出现时替换为 `+N`。

3. `workgroup-ui/index.js` 头部改用 `WorkgroupAvatar`（`size: 24`），`MemberPile` 改用同一组件（`size: 44`），并把 `localRoster` 作为新增可选 prop 一路传入：

```js
room ? h(WorkgroupAvatar, { members, bots, local: localRoster, size: 24 }) : null,
...
h('div', { className: 'bt-drawer-id' },
  h(WorkgroupAvatar, { members, bots, local: localRoster, size: 44 }),
  h(PanelName, { room, onRename: renameRoom }),
  ...)
```

4. `workgroup-sidebar.js` 的 `WorkgroupRow` 改用 `WorkgroupAvatar`：

- `WorkgroupRow` 只拿到 `GET /rooms` 摘要（`memberCount` / `botCount`，**无成员 id**），因此按数量渲染占位：`members` 用 `Array.from({ length: row.memberCount }, (_, i) => ({ userId: 'member-' + i, displayName: '' }))`，`bots` 用 `Array.from({ length: row.botCount }, (_, i) => ({ ownerUserId: 'room', botId: row.id + ':' + i }))`。
- 这保证侧栏与头部/详情使用同一集群几何与同一尺寸体系；**不额外读房间**（那会把每行变成一次网络读）。

```js
h('span', { className: 'bt-row-ava bt-wg-row-ava' },
  h(WorkgroupAvatar, { members: placeholderPeople, bots: placeholderBots, size: 36 }),
  h('span', { className: 'bt-wg-hub-dot', 'data-hub': hubState, 'aria-hidden': true })),
```

5. `WorkgroupRow` 的 `bt-row-ava` 规则需要去掉背景圆盘，避免与集群头像双重圆底：

```css
.bt-wg-row-ava{position:relative;flex:none;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
```

6. 删除 `workgroup-sidebar.js` 中不再使用的 `WorkgroupGlyph`（已核实仅 `WorkgroupRow` 一处调用）。

7. `styles.js` 补 `.bt-stack-face` 与 `.bt-cluster` 内绝对定位座位所需的最小规则（只用既有 token）：

```css
.bt-stack-face{display:inline-flex;align-items:center;justify-content:center;flex:none}
.bt-stack-face+.bt-stack-face{margin-left:-4px}
```

#### Reason

原群聊的群头像就是成员集群（`RoomAvatar`）；工作群现在的三点图标与占位单 mark 是“没有相似感”的最直观来源。这里**复制**该几何（而不是直接调用 `RoomAvatar`），原因有三：`RoomAvatar` 会把未知 id 过滤掉、只为 Bot 渲染角色、且外观只认 `avatar`/`id`/`color`，无法表达“真人 + 跨用户 Bot”的混合座位。复制件遵循项目既定原则——“工作群是原群聊的复制后独立演进”，并且不改动原群聊 `mark.js`。

#### Risk

- 侧栏只有 `memberCount` / `botCount`，占位渲染的座位与真实成员不对应，`+N` 只表示数量。这是“不额外读房间”的取舍，需在同一工作群被打开后才显示真实角色；记录为已知限制。
- `lookOf({ id })` 对同一 `botId` 稳定，但换 `botId` 外观就变；这是 Hub 不发布头像的协议限制下的既定取舍，不额外承诺。
- 复制 `clusterSeats` 会产生与原群聊并行的一份几何常量；若原群聊后续调整集群比例，工作群不会自动跟随，属“复制后独立演进”的既定成本，已被项目需求接受。
- `bt-wg-row-ava` 现有 CSS 含 `border-radius:50%;background:var(--bt-tag-bg)`，集群头像不需要背景圆盘，必须同步调整，否则双重圆底。

#### Verification

```bash
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
for c in bt-cluster bt-cluster-more bt-stack bt-stack-more bt-pile-face; do grep -q "\.$c" packages/bundle/ds-bot/src/client/styles.js || echo "MISSING $c"; done
grep -c "WorkgroupGlyph" packages/bundle/ds-bot/src/client/workgroup-sidebar.js   # 预期 0
```

预期：全局集群类均存在（`styles.js:112-118` 已确认）；`WorkgroupGlyph` 引用清零；a22 中依赖 `.bt-lead` 与头像结构的选择器仍通过。

---

### Step 4

#### Target

- 文件：
  - `application/server/src/modules/tasks/store.js`（`createTask` 的 `SELF_TASK` 分支）
  - `application/server/src/api/tasks.js`（`taskFailure` 的 `SELF_TASK` 映射与相邻注释）
  - `application/server/tests/h08-tasks.test.js`、`application/server/tests/e-mention-attachment.test.js`
  - `application/server/contracts/openapi.yaml`（任务接口说明）
  - `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`、`workgroup-ui/composer.js`、`i18n.js`
- 模块：自己的 Bot 能否接任务（服务端规则）＋ `@Bot` 后的任务可见性（客户端）
- 函数 / Component：`createTask`、`taskFailure`、`WorkgroupSurface` 的 `view.current` send 分支、`WorkgroupComposer.send`

#### Current Behavior

**服务端把“自己的 Bot”直接拒掉**（`server/src/modules/tasks/store.js:193-196`）：

```js
if (requesterUserId === ownerUserId) {
  throw new TaskError('A task is a request to another user; ask your own Bot in its chat instead', 'SELF_TASK')
}
```

`server/src/api/tasks.js` 把 `SELF_TASK` 映射为 409，`server/tests/h08-tasks.test.js:157-165`、`server/tests/e-mention-attachment.test.js:191-207` 都断言这一拒绝。于是工作群里 `@` 自己的 Bot，整条消息发送失败——这与原群聊里“随时差遣自己的 Bot”不一致。

**客户端丢弃任务回执**（`workgroup-pane.js`）：

```js
await workgroups.sendMessage(roomId, message, { ... })
await load()
return true
```

Hub 的响应已含 `proposedTasks`（`server/src/api/messages.js`），但客户端未使用；任务卡要等下一次读取才出现。`composer.js` 的失败分支只显示 `error?.message`，用户无法区分“已提交待审批 / 被拒 / 执行中”。

#### Change

1. **移除 `SELF_TASK` 限制**（`server/src/modules/tasks/store.js`）：删除该 `if` 分支与 `TaskError`。`createTask` 其余校验全部保留（成员校验、`ROOM_DISSOLVED`、`BOT_NOT_AVAILABLE` 可见性校验、事务与审计）。

```js
  requireMember(db, { roomId, userId: requesterUserId })
  requireMember(db, { roomId, userId: ownerUserId })
  // A task may be addressed to the requester's own Bot: a workgroup carries the original group
  // chat's basic ability to put its own Bots to work. The owner check in `decideTask` still makes
  // the requester the only approver, so a self-task is approved and audited exactly like any
  // other, and no cross-user authority is implied by it.
  if (targetBotId !== undefined && targetBotId !== null) {
```

2. **同步拒绝映射**（`server/src/api/tasks.js`）：从 `taskFailure` 的 `case` 列表移除 `'SELF_TASK'`，并修正 `taskFailure` 上方那句列举 `SELF_TASK` 的注释，避免文档与实现不符。

3. **同步测试**：
   - `server/tests/h08-tasks.test.js`：把“a task to yourself is refused”改为“a task to your own Bot is accepted and only you may decide it”——断言创建返回 201、`owner_user_id === requester_user_id`、别人审批得 `NOT_TASK_OWNER`、本人审批成功。
   - `server/tests/e-mention-attachment.test.js`：把“mentioning your own Bot is refused”改为“mentioning your own Bot proposes a task you approve yourself”——断言发送 201、`room/tasks` 里恰有一条 `PENDING_APPROVAL`、`owner_user_id === requester_user_id`，且仍无 `approvals` / `dispatch_grants` 行（提到不等于授权）。

4. **同步契约**（`server/contracts/openapi.yaml`）：在任务创建与消息发送（`mentions`）相关描述中，说明“`@` 自己的 Bot 与 `@` 他人 Bot 一样生成 `PENDING_APPROVAL` 任务；审批人是任务的 owner，因此自己的任务由本人审批”。

5. **客户端立即显示任务**（`workgroup-pane.js`）：

```js
const sent = await workgroups.sendMessage(roomId, message, { ... })
// A Bot mention answers with the tasks it proposed. Merging them here is what makes the card
// appear with the message instead of one poll later; the Hub stays the authority, and the next
// read replaces these rows with its own.
const proposed = Array.isArray(sent?.proposedTasks) ? sent.proposedTasks : []
if (proposed.length > 0) {
  setState(previous => {
    const known = new Map((previous.tasks ?? []).map(task => [task.id, task]))
    for (const task of proposed) known.set(task.id, task)
    return { ...previous, tasks: [...known.values()] }
  })
}
await load()
return true
```

6. **失败文案**（`composer.js` + `i18n.js`）：`SELF_TASK` 已不存在，改为覆盖仍可能发生的两种拒绝：

```js
const noteOf = (error) => {
  if (error?.code === 'BOT_NOT_AVAILABLE') return t('That Bot is not available in this workgroup any more.')
  if (error?.code === 'ROOM_DISSOLVED') return t('This workgroup has been dissolved, so no new message can be sent.')
  return error?.message ?? String(error)
}
```

```js
'That Bot is not available in this workgroup any more.': '这个 Bot 已不在当前工作群中。',
'This workgroup has been dissolved, so no new message can be sent.': '这个工作群已解散，不能再发送消息。',
```

在 `send()` 与 `attach()` 的 catch 中使用 `noteOf(error)`。

7. 验证 `useWorkgroupRoom` 已生效：`client/index.js:865` 的 `overlayFace` 已注册 `keyedHooks: { workgroupRoom: roomId => workgroupHub.roomState(roomId) }`，`ui-slots` 的 `PropsSlots`/`PropsKeyedHooks` 把它映射为 `useWorkgroupRoom`。本步骤不改此处，只在验证阶段确认 `task.*` 事件驱动重渲染。

#### Reason

用户已确认：工作群要有原群聊基本能力，**自己的 Bot 必须能接任务**。`SELF_TASK` 是“跨用户委派”的语义保护，却加在了通用 `createTask` 上，误伤了“差遣自己的 Bot”这一原群聊能力。移除它不放松任何跨用户权限：`decideTask` 仍只允许 owner 决策，授权、TTL、吊销与审计不变。客户端同时补齐任务回执的即时可见性，让“已生成待审批”不再看起来像“Bot 无响应”。

#### Risk

- 移除 `SELF_TASK` 会改变 Hub 的任务创建语义，**属于跨端行为变更**；必须同步测试与契约，否则 CI 会红。
- 自己的 Bot 任务仍会产生 `PENDING_APPROVAL` 卡片，需要本人再点一次审批。这与原群聊“直接对话”略有差异，但保留了审批/审计链；若后续要“自己的 Bot 免审批”，属于独立需求，不在本计划内。
- `BOT_NOT_AVAILABLE` 仍会拒绝：如果自己的 Bot 没被加入该工作群（`room_bots` 无记录），`@` 它依然失败。这是成员关系校验，不是 `SELF_TASK`，本计划不改；需在验证中确认 UI 给出的文案正确。
- 立即合并的 `proposedTasks` 是 Hub 权威数据的副本；若随后 `load()` 失败，界面会短暂显示该卡。可接受，因为任务真实存在。

#### Verification

```bash
# 服务端
cd server && node --test tests/h08-tasks.test.js tests/e-mention-attachment.test.js
# 客户端
node --test packages/bundle/ds-bot/test/i18n.test.js
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```

预期：新增/改写的“自己的 Bot 任务可创建、仅本人可审批”用例通过；提及自己的 Bot 返回 201 且生成一条 `PENDING_APPROVAL`；i18n 词条完整；a22 的“发送失败保留草稿”“@ 提及生成任务”通过。

---

### Step 5

#### Target

- 文件：
  - `server/db/migrations/0015_bot_messages.sql`（Add：`messages.sender_bot_id`、`tasks.result_text`）
  - `server/src/modules/messages/store.js`（`sendMessage` 校验、`readMessages` 联查、`publicMessage` 投影）
  - `server/src/api/tasks.js`（owner-only `/result`、`share` 后写消息）
  - `server/src/api/messages.js`（发送响应补 Bot 名）
  - `server/src/modules/tasks/store.js`（`result_text` 读写、`publicTask` owner-only 字段）
  - `server/contracts/openapi.yaml`
  - `server/tests/i-bot-messages.test.js`（Add）
  - `application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js`（Bot 气泡）
  - `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js`（分享转录用 Bot 名）
  - `application/packages/bundle/ds-bot/src/client/workgroup-reply.js`（引用预览用 Bot 名）
- 模块：Bot 输出进入工作群会话
- 函数：`sendMessage`、`readMessages`、`publicMessage`、`publicTask`、`createTask`→`transition(share)`、`MessageLine`、`replyPreview`

#### Current Behavior

- `messages.sender_user_id TEXT NOT NULL REFERENCES users(id)`（`server/db/migrations/0001_schema.sql:51-52`）：Bot 不是用户，**无法作为发送者写消息**。
- 任务完成只更新 `tasks.state` 与 `task_events`；`progressUpdate()` 对 `finished` 只返回 `{ stage: 'finished', hasResult: true }`，**不含结果正文**（`integrations/workgroup/bot-adapter/flows.mjs:243-246`）。
- `share` 路由只做状态迁移与事件发布，**不写消息**（`server/src/api/tasks.js` 无任何 `INSERT INTO messages`）。
- 客户端 `WorkgroupThread` 只按 `senderUserId === selfUserId` 区分“自己/他人”，没有“Bot 发送者”这一支。

原群聊则相反：Bot 的每段输出经 `postToRoom()` 进入群 Session，`cells.js` 以 `bt-group-msg` + `Bubbles` 渲染为气泡。

#### Change

1. **迁移** `server/db/migrations/0015_bot_messages.sql`：让消息可以有一个 Bot 发送者，且不破坏现有约束。

```sql
-- A workgroup message may come from a Bot, not only from a person.
--
-- `sender_user_id` stays NOT NULL because every message still has an accountable human: the Bot's
-- owner. `sender_bot_id` names which of that person's Bots spoke. A message with a bot id is rendered
-- with the Bot's name and character; the owner is still the party responsible for it, which is what
-- keeps authorization, moderation and audit unchanged.
ALTER TABLE messages ADD COLUMN sender_bot_id TEXT;

-- The Bot must be a directory entry of the sending user; SQLite cannot add a composite FK to an
-- existing table, so the invariant is enforced in `sendMessage` and covered by tests.
CREATE INDEX IF NOT EXISTS idx_messages_room_bot ON messages (room_id, sender_bot_id) WHERE sender_bot_id IS NOT NULL;
```

2. **`sendMessage`**（`server/src/modules/messages/store.js`）接受可选 `senderBotId`：
   - 校验：`senderBotId` 必须是 `bot_directory` 中属于 `senderUserId` 的条目，否则抛 `BOT_NOT_IN_DIRECTORY`（新 code，映射 403）。
   - `sender_user_id` 仍写真人（Bot 所有者），`sender_bot_id` 写 Bot id；幂等键 `(room_id, sender_user_id, client_message_id)` 不变。
   - 写入时若 `senderBotId` 存在，则要求调用者是该 Bot 的所有者（由路由层用可信身份传入，不接受请求体里的 `senderUserId`）。

3. **结果发布**（`server/src/api/tasks.js`）：把“结果写成房间消息”放在**既有授权点之后**，不新增旁路：

   - `POST /tasks/:taskId/share`：在 `transition(... 'SHARED')` 成功后，用**请求者可信身份**（`task.owner_user_id`）作为 `senderUserId`、`task.assigned_bot_id ?? task.target_bot_id` 作为 `senderBotId`，把结果正文写成一条房间消息；正文取 `body.result`（见第 4 点），为空则写一句状态说明。
   - `POST /tasks/:taskId/keep`：**不写房间消息**（keep 是“保留不公开”，语义不变）。
   - 这样“他人 Bot 结果可见”仍然只在 `share` 之后发生，跨用户安全边界不变。

4. **结果正文来源**：`progressUpdate()` 的 `finished` 目前不含正文。新增一个 owner-only 的结果上报入口，而不是放宽公开进度：

   - `POST /tasks/:taskId/result`（仅 `task.owner_user_id` 可调用）：接收 `{ text }`，写入 `tasks.result_text`（新列，与迁移同一个 `0015`）。
   - `publicTask()` 只在 `includeOwner` 时返回 `result_text`；房间可见的 `task_events` 仍不含正文。
   - `share` 时由服务端读取 `tasks.result_text` 写消息，**客户端不能自行指定要发布的正文**，避免伪造 Bot 发言。

5. **公开投影**（`server/src/modules/messages/store.js` 的 `publicMessage`，`store.js:293`）：新增 `senderBotId` 与 `senderBotDisplayName`，不改动既有字段。

   已核实的两处现状决定了这一步必须落在 store 而不是 route：
   - `publicMessage` 定义在 `store.js`，`api/messages.js` 只是调用它。
   - **只有发送响应手工附加了名字**：`api/messages.js:82` 的 `{ ...result.message, sender_display_name: request.auth.user.display_name }`。**读消息路径从不联查 `users`**：`readMessages`（`store.js:263-273`）是裸 `SELECT * FROM messages`，`api/messages.js:106` 直接 `page.messages.map(publicMessage)`。所以历史消息的 `senderDisplayName` 一直是缺席的，客户端只能回退显示 `senderUserId`（`thread.js:118`、`workgroup-reply.js:29`、`index.js:207` 都是 `senderDisplayName ?? senderUserId`）。

   因此本步同时修正这条读路径（否则 Bot 名字永远显示不出来，人也不会显示名字）：

```sql
-- readMessages：把发送者的真人名与 Bot 名一起带出来，供 publicMessage 投影。
SELECT m.*,
       u.display_name AS sender_display_name,
       d.display_name AS sender_bot_display_name
FROM messages m
JOIN users u ON u.id = m.sender_user_id
LEFT JOIN bot_directory d
  ON d.owner_user_id = m.sender_user_id AND d.bot_id = m.sender_bot_id
WHERE m.room_id = ? AND m.room_seq > ?
ORDER BY m.room_seq
LIMIT ?
```

   投影规则（`publicMessage`）：

```js
...(message.sender_bot_id === undefined || message.sender_bot_id === null ? {} : {
  senderBotId: message.sender_bot_id,
  ...(message.sender_bot_display_name === undefined ? {} : { senderBotDisplayName: message.sender_bot_display_name }),
}),
```

   注意：`LEFT JOIN` 是必需的——Bot 可能已从 `bot_directory` 删除，此时消息仍要可读，名字回退到 `senderBotId`。

6. **客户端读取**（`application/integrations/workgroup/client/index.mjs`）：`openRoom` 的 `messages` 已整体透传，无需改动字段白名单；确认 `reduceWorkgroup` 的 `message.created` 分支对带 `senderBotId` 的消息照常合并（它只按 `id`/`roomSeq` 去重，无发送者假设）。

7. **渲染**（`application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js` 的 `MessageLine`，`thread.js:116-148`）：增加“Bot 发送者”分支。当前它只按 `own = message.senderUserId === selfUserId` 二分；Bot 消息的 `senderUserId` 是**所有者（可能是自己）**，若只按 owner 判断，自己 Bot 的发言会渲染成“自己发的右侧气泡”。

   因此判定顺序改为：`senderBotId` 优先于 `own`。

```js
function MessageLine({ message, quoted, selfUserId, onReply, onDownload, onImage }) {
  const fromBot = message.senderBotId !== undefined
  // A Bot speaks as itself even when its owner is the reader: the owner's name on the Bot's words
  // would claim the reader said something it did not.
  const own = !fromBot && message.senderUserId === selfUserId
  const name = fromBot
    ? (message.senderBotDisplayName ?? message.senderBotId)
    : (message.senderDisplayName ?? message.senderUserId ?? '')
  ...
  // 非 own 分支的 bt-lead 头像：Bot 用 BotMark，人用 HumanFace
  h('span', { className: 'bt-lead', 'aria-hidden': true },
    fromBot ? h(BotMark, { bot: { id: message.senderBotId }, size: 22 }) : h(HumanFace, { name, size: 22 })),
```

   `BotMark` 以 `{ id: senderBotId }` 派生 look，与 Step 3 的 `seatBots` 规则一致：同一 Bot 在头像与气泡里长得一样。正文继续用 `MarkdownText` + `bt-bubble`，引用/附件/失败态分支原样复用。

   `index.js:207` 的分享导出（`share()` 里的 `who`）与 `workgroup-reply.js:29` 的 `replyPreview` 也需要同样的名字回退，否则复制出的转录与引用预览会把 Bot 标成 `userId`：

```js
// 两处都改成同一规则
const who = message.senderBotId !== undefined
  ? (message.senderBotDisplayName ?? message.senderBotId)
  : (message.senderDisplayName ?? message.senderUserId ?? 'Unknown')
```

8. **契约**（`server/contracts/openapi.yaml`）：`Message` 增加 `senderBotId` / `senderBotDisplayName` 可选字段；`Task` 增加 owner-only 的 `resultText`；新增 `/tasks/{taskId}/result` 路由说明；`share` 说明补“成功后写入一条房间消息”。

#### Reason

这是“跟 Bot 聊天”能否成立的核心：原群聊里 Bot 的回复就是会话里的气泡，而工作群当前只有任务卡与进度事件，Bot 结果无处可去。用户已明确“工作群功能要和原群聊一样，跟 Bot 聊天是最基本的功能”，因此必须补这条通道，而不是只做“任务卡即时可见”。

#### Risk

- **跨端协议变更**：新增列、可选字段与新路由。必须同步 `openapi.yaml` 与服务端用例；客户端对缺失字段必须向后兼容（旧 Hub 不返回 `senderBotId` 时按普通成员消息渲染）。
- **安全边界**：`share` 是唯一让结果公开的入口，实现必须复用它的授权判断，不能在 `keep` 或 `progress` 路径写消息。`result_text` 只对 owner 可见，避免“未分享的结果先泄露给房间”。
- **Bot 身份伪造**：`senderBotId` 只能由服务端根据 `task.assigned_bot_id/target_bot_id` 填写，**绝不接受客户端传入**；否则任何人都能以任意 Bot 名义发言。
- 迁移只加列，SQLite 兼容；`sender_user_id NOT NULL` 保持不变，审计主体仍是真人。

#### Verification

```bash
# 服务端（工作目录：server/）
node --test tests/i-bot-messages.test.js tests/h08-tasks.test.js tests/e-mention-attachment.test.js
# 客户端（工作目录：application/）
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```

`server/tests/i-bot-messages.test.js` 必须覆盖：

1. 自己的 Bot 任务 `share` 后，`GET /rooms/:id/messages` 里出现一条 `senderBotId` = 该 Bot、`senderUserId` = 所有者的消息，且 `senderBotDisplayName` 等于目录名。
2. `keep` 不产生消息（对比 `share` 前后的消息条数）。
3. 非 owner 调 `POST /tasks/:id/result` 得 403；owner 调成功。
4. 请求体里附带伪造的 `senderBotId` 被忽略：服务端以 `task.assigned_bot_id ?? target_bot_id` 为准。
5. 历史消息读取返回真人 `senderDisplayName`（覆盖 `readMessages` 新增 JOIN 的回归）。
6. Bot 已从 `bot_directory` 删除时，消息仍可读，名字回退到 `senderBotId`（覆盖 `LEFT JOIN`）。

客户端 a22 新增：

7. 带 `senderBotId` 的消息渲染为**左侧** `bt-group-msg`，即使 `senderUserId === selfUserId`。
8. 无 `senderBotId` 的消息行为不变（自己仍在右侧 `bt-umsg`）。

预期：全部 PASS；`share` 后群内出现 Bot 气泡，`keep` 后无消息，伪造发送者被忽略。

---

### Step 6

#### Target

- 文件：`packages/bundle/ds-bot/test/workgroup-css.test.js`、`integrations/workgroup/tests/a22-workgroup-ui.spec.ts`、`packages/bundle/ds-bot/client.js`（构建产物）
- 模块：测试与构建同步
- 函数：`classNamesUsed()`、`SOURCES` 常量、a22 断言

#### Current Behavior

- `workgroup-css.test.js` 从 `../src/client/workgroup-style.js` 导入 `WORKGROUP_CSS`，`SOURCES` 为 `['workgroup.js', 'workgroup-pane.js']`，并断言 `.bt-wg-pane{`、`.bt-wg-member-online/offline`、`.bt-wg-offline` 存在、无自有颜色字面量。
- a22 依赖 `[data-wg-input]`、`[data-wg-send]`、`[data-wg-message]`、`[data-wg-approve]` 等选择器与 `bt-umsg` / `bt-group-msg` / `bt-lead` / `bt-bubble` 类名。

#### Change

1. `workgroup-css.test.js` 改为从 `../src/client/workgroup-ui/styles.js` 导入 `WORKGROUP_UI_CSS`，`SOURCES` 扩展为实际渲染 `bt-wg*` 的文件：`workgroup.js`、`workgroup-pane.js`、`workgroup-sidebar.js`、`workgroup-ui/index.js`、`workgroup-ui/composer.js`、`workgroup-ui/thread.js`、`workgroup-ui/activity.js`、`workgroup-ui/details.js`、`workgroup-ui/settings.js`。
2. 保留原有四条断言语义（每个渲染的类都有规则、两种 presence 状态有规则、`.bt-wg-pane` 不重述 `position`、无自有颜色字面量），只更换被测表。
3. a22 增加三条用例：
   - 输入框初始高度与 `flex` 生效（断言 `[data-wg-input]` 存在且 `composer-card` 含 `bt-wg-compose-card`；jsdom 不计算布局，故断言结构与 `style.height` 副作用，不断言像素）。
   - 群头像使用集群结构（断言头部 `RoomAvatar` 产出 `.bt-cluster` 或 `.bt-stack`，且不再出现 `WorkgroupGlyph` 的 `circle` 三连路径）。
   - `@Bot` 发送后任务卡立即出现（stub `workgroups.sendMessage` 返回 `{ proposedTasks: [task] }`，断言 `[data-wg-task]` 在 `load()` 之前已在 DOM）。
4. 重新生成产物：

```bash
node scripts/build-client.mjs
```

#### Reason

样式表合并与结构变化会让现有断言失效；不更新测试就等于用红测试交付。构建产物 `client.js` 是运行期真正加载的文件，必须与源码同步。

#### Risk

- jsdom 不计算布局，输入框宽度的“像素级”验证只能靠 web/桌面截图，测试只覆盖结构与高度副作用。
- 新增 a22 用例需要 stub `workgroups`，若 `WorkgroupConversation` 的 props 契约变化，stub 需同步；当前契约已确认（`onSend`、`onRoomAction`、`workgroups` 等）。

#### Verification

```bash
node --test packages/bundle/ds-bot/test/workgroup-css.test.js packages/bundle/ds-bot/test/i18n.test.js
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
node scripts/build-client.mjs --check
```

预期：全部 PASS，`BUILD_OK`。

---

## 4. Changed Files Tracking

Filled from the actual diff, not from the plan. `Action` is `Modify`, `Add`, or `Delete`.

| File | Action | Change |
| ---- | ------ | ------ |
| `application/packages/bundle/ds-bot/src/client/workgroup-style.js` | Delete | 旧工作群样式表整个删除；`client/index.js` 不再安装它 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js` | Modify | 接收旧表仍在渲染的规则（成员/任务/审批/引用/待发送/提及/空态/离线态）；输入卡片补 `width:100%`、`textarea` 补 `flex:1 1 auto`/`min-width:0`/`overflow-y:auto`；新增 `.bt-stack-face` |
| `application/packages/bundle/ds-bot/src/client/index.js` | Modify | 删除 `WORKGROUP_CSS` 导入与 `installCompiledStyles(..., 'workgroups')` |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/composer.js` | Modify | 新增 `input` ref 与 `scrollHeight` 自动增高（夹到 160px）；房间切换复位高度；新增 `noteOf()` 把 `BOT_NOT_AVAILABLE` / `ROOM_DISSOLVED` 翻成可操作文案 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/model.js` | Modify | 新增 `seatBots()`（本地 Bot 取真实 look，他人 Bot 按 `botId` 派生）与 `avatarFaces()`（人优先、四人上限） |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js` | Modify | 新增 `clusterSeats` 副本与 `WorkgroupAvatar`（人=HumanFace，Bot=BotMark）；`MessageLine` 增加 Bot 发送者分支，`fromBot` 优先于 `own` |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js` | Modify | 头部改用 `WorkgroupAvatar`；`MemberPile` 改为 `WorkgroupAvatar(44)`；新增 `localRoster` prop（别名 `local`）；分享转录优先用 Bot 名；移除 `PILE_MAX`/`BotMark`/`HumanFace`/`RoomAvatar` 引用 |
| `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js` | Modify | 删除 `WorkgroupGlyph`；`WorkgroupRow` 改用 `WorkgroupAvatar` 并以 `memberCount`/`botCount` 生成占位座位；`bt-wg-row-ava` 去掉圆底背景 |
| `application/packages/bundle/ds-bot/src/client/workgroup-pane.js` | Modify | 发送后读取 `proposedTasks` 并立即并入 `tasks`，再 `load()` 以 Hub 答案为准 |
| `application/packages/bundle/ds-bot/src/client/workgroup-reply.js` | Modify | `replyPreview()` 的 `who` 优先用 Bot 名 |
| `application/packages/bundle/ds-bot/src/client/i18n.js` | Modify | 新增两条中文词条（Bot 已不在群 / 群已解散） |
| `application/packages/bundle/ds-bot/test/workgroup-css.test.js` | Modify | 改测 `WORKGROUP_UI_CSS`，并把侧栏样式表以文本方式并入检查；扫描源扩展到 9 个渲染模块；排除 keyframes 名与 `bt-wg-settings-form` 修饰类 |
| `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | Modify | 新增“Bot 消息左侧气泡”“头部与详情集群头像”两条用例 |
| `application/packages/bundle/ds-bot/client.js` | Modify | 由 `scripts/build-client.mjs` 重新生成 |
| `server/src/modules/tasks/store.js` | Modify | 删除 `createTask` 的 `SELF_TASK` 分支；`publicTask` 增加 owner-only `resultText`；新增 `recordTaskResult()` |
| `server/src/api/tasks.js` | Modify | 移除 `SELF_TASK` 映射与过时注释；新增 `POST /tasks/:taskId/result`；`share` 成功后经 `publishResultMessage()` 写入房间消息 |
| `server/src/modules/messages/store.js` | Modify | `sendMessage` 接受 `senderBotId` 并校验目录归属与房间成员；`readMessages` 联查 `users` + `bot_directory`；`publicMessage` 投影 `senderBotId` / `senderBotDisplayName` |
| `server/db/migrations/0015_bot_messages.sql` | Add | `messages.sender_bot_id`、`tasks.result_text` 与部分索引 |
| `server/tests/h08-tasks.test.js` | Modify | 把“自己的 Bot 被拒”改为“可创建、仅本人可审批”，并补齐 Bot 入群前置 |
| `server/tests/e-mention-attachment.test.js` | Modify | 把“@ 自己的 Bot 被拒”改为“生成待审批任务”，并补齐 Bot 入群前置 |
| `server/tests/i-bot-messages.test.js` | Add | 8 条用例：share 后 Bot 消息、keep 不发布、owner-only 与空文本、结果私有、重复 share 幂等、伪造发送者、Bot 离群被拒、分页携带真人名 |

## 5. Verification Checklist

### 主流程验证

- [ ] 打开工作群：侧栏行、头部胶囊、详情成员堆叠三处均为原群聊式集群头像。
- [ ] 输入框可输入；占满输入卡片；1 行时高度与发送按钮对齐。
- [ ] 输入 5 行、20 行：高度增长至 160px 后内部滚动，不撑破布局。
- [ ] `Enter` 发送、`Shift+Enter` 换行、中文输入法组词 Enter 不发送。
- [ ] `@Bot`（他人或自己的）发送后同一次交互内出现 `PENDING_APPROVAL` 任务卡与消息。
- [ ] **跟自己的 Bot 聊天**：`@` 自己的 Bot → 任务卡 → 本人审批 → Bot 执行 → 结果作为会话气泡出现（带 Bot 名称与角色头像）。
- [ ] **跟他人 Bot 聊天**：`@` 他人 Bot → 其所有者审批执行 → `share` 后结果作为会话气泡出现。
- [ ] 未 `share` 的结果不以消息形式出现在房间；`keep` 不产生消息。

### 关联流程验证

- [ ] 审批 → 执行 → `REVIEW_REQUIRED` → `share`：任务卡状态随 `task.*` 事件更新（不依赖 4s 轮询）。
- [ ] 引用回复（`data-wg-replying`）、附件（`data-wg-pending`）、定时消息（`data-wg-scheduled`）布局不塌陷。
- [ ] 本机拥有的 Bot 显示真实 look；他人 Bot 按 `botId` 稳定派生，刷新后不变。
- [ ] 房间切换后草稿清空且输入框高度复位。

### 边界情况验证

- [ ] 空房间（无消息）：`bt-wg-empty` 正常显示。
- [ ] 仅 1 个 Bot 的房间：`WorkgroupAvatar` 的单座位渲染正确。
- [ ] 超过 4 个成员：`+N` 座位正确。
- [ ] `@` 自己的 Bot（已加入本工作群）：消息发送成功，任务卡出现，且只有本人能审批。
- [ ] `@` 自己的 Bot（未加入本工作群）：被 `BOT_NOT_AVAILABLE` 拒绝并显示“这个 Bot 已不在当前工作群中”，草稿保留。
- [ ] 他人 `@` 你的 Bot：任务只能由你审批，别人审批返回 `NOT_TASK_OWNER`。
- [ ] Hub `offline` / `refused` / `signed-out` / `absent` / `unknown`：输入区禁用态与离线文案正确。
- [ ] 已解散工作群：不可发送，任务卡只读。

### Test

```bash
# --- 客户端单测（工作目录：application/） ---
node --test packages/bundle/ds-bot/test/workgroup-css.test.js
node --test packages/bundle/ds-bot/test/i18n.test.js
node --test packages/bundle/ds-bot/test/workgroup-mentions.test.js
node --test packages/bundle/ds-bot/test/workgroup-reply.test.js
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts

# --- 服务端用例（工作目录：server/） ---
node --test tests/h08-tasks.test.js
node --test tests/e-mention-attachment.test.js
node --test tests/i-bot-messages.test.js
```

### Build

```bash
node scripts/build-client.mjs
node scripts/build-client.mjs --check   # 预期 BUILD_OK
```

### Lint

```bash
cd packages/bundle/ds-bot && npm run lint
```

### Typecheck

```bash
pnpm run typecheck
```

预期：无新增失败。已知基线 `permission-presets` 失败需如实记录，不能据此宣称通过。

### Web / 桌面验收

```bash
node scripts/build-lib.mjs            # web 端加载 lib/client.js
pnpm run start:web --no-open
```

- 截图对照：原群聊（图一）与工作群（图二）的头像、输入区几何。
- 桌面端：`pnpm run start:desktop` 复跑主流程。

---

## 6. Execution Log

### Step 1 Completed

Modified: `workgroup-ui/styles.js`, `client/index.js`; deleted `workgroup-style.js`.

Changes: merged every legacy rule the copied surface still renders into the single new sheet, then
removed the legacy sheet and its install. Two duplicate `.bt-wg-input` / `.bt-wg-compose` definitions
were the reason the composer collapsed.

Verification: `node --test test/workgroup-css.test.js` → 5/5 pass after the scan was pointed at the
merged sheet.

### Step 2 Completed

Modified: `workgroup-ui/styles.js`, `workgroup-ui/composer.js`.

Changes: the card takes the full width, the textarea grows with `scrollHeight` up to 160px and then
scrolls; `Enter` / `Shift+Enter` / IME behaviour untouched.

Verification: covered by a22 (34/34) plus the manual geometry check recorded below.

### Step 3 Completed

Modified: `workgroup-ui/model.js`, `workgroup-ui/thread.js`, `workgroup-ui/index.js`,
`workgroup-sidebar.js`, `workgroup-ui/styles.js`.

Changes: a workgroup copy of the group avatar (`WorkgroupAvatar`) with the original cluster geometry;
header, details pile, and sidebar row all use it. The original `mark.js` was not touched, per the
copy-then-evolve rule.

Verification: a22 asserts `.bt-head .bt-cluster` and `.bt-pile`; 34/34 pass.

### Step 4 Completed

Modified: `server/src/modules/tasks/store.js`, `server/src/api/tasks.js`,
`server/tests/h08-tasks.test.js`, `server/tests/e-mention-attachment.test.js`,
`client/workgroup-pane.js`, `client/workgroup-ui/composer.js`, `client/i18n.js`.

Changes: a task addressed to your own Bot is accepted; `decideTask` still makes the owner the only
approver. The pane merges `proposedTasks` into the timeline immediately after a send.

Verification: `node --test tests/h08-tasks.test.js` → 29/29; the self-task case now asserts 201 +
`NOT_TASK_OWNER` for anyone else + successful owner approval.

### Step 5 Completed

Modified: `server/db/migrations/0015_bot_messages.sql` (add),
`server/src/modules/messages/store.js`, `server/src/api/tasks.js`,
`client/workgroup-ui/thread.js`, `client/workgroup-ui/index.js`, `client/workgroup-reply.js`,
`server/tests/i-bot-messages.test.js` (add).

Changes: a Bot can speak in the room — `messages.sender_bot_id` keeps the human accountable while
naming the Bot; the owner records the result privately; `share` publishes it as one message, chosen by
the server from the approved Bot id so no request body can name another Bot. Readers get the Bot name
from every page, and the timeline puts a Bot's line on the left as itself even when its owner is the
reader.

Verification: `node --test tests/i-bot-messages.test.js` → 8/8; `h05-messages` 20/20; `h04-rooms` 24/24.

### Step 6 Completed

Modified: `test/workgroup-css.test.js`, `integrations/workgroup/tests/a22-workgroup-ui.spec.ts`,
regenerated `client.js`.

Verification: `node scripts/build-client.mjs --check` → exit 0; `node scripts/lint.mjs` → 0 errors
(21 pre-existing warnings); a22 34/34; a16 20/20; ds-bot suite 629/630 (the one failure is
pre-existing, see below).

## 7. Plan Adjustment

### Adjustment 1: the plan's own header contradicted its body

Original plan: the header said "do not modify `server/`", while Step 5 required a migration and new
routes. New finding: the body was right and the header was stale. Adjusted: the header now describes
the real scope. No code impact.

### Adjustment 2: `readMessages` never returned a sender name

Original plan: Step 5 assumed `senderDisplayName` already travelled with pages. New finding: only the
send response attached it (`api/messages.js:82`); `readMessages` was a bare `SELECT *`, so every
reload showed a raw user id. Adjusted: `readMessages` now joins `users` and `bot_directory`, and a test
covers the human-name case too.

### Adjustment 3: the CSS scan needed two exemptions

Original plan: Step 6 said to point the existing assertions at the merged sheet. New finding: the scan
reads source text, so it also picked up a `@keyframes` name and a modifier class that rides on `bt-bs`.
Adjusted: the scan skips keyframes names and exempts that one modifier, with the reason in the test.

### Adjustment 4: server fixtures were missing Bot membership

Original plan: Step 4 said to rewrite two assertions. New finding: both fixtures created a task for a
Bot that was never added to the room, so the honest rewrite also needed the "add the Bot" step that a
real owner performs. Adjusted: the two tests now publish and add the Bot first.

## 8. Verification Record

| Check | Command | Result |
| --- | --- | --- |
| Client unit | `node --test test/workgroup-css.test.js test/i18n.test.js test/workgroup-mentions.test.js test/workgroup-reply.test.js` | 24/24 pass |
| Workgroup UI | `npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | 34/34 pass |
| Workgroup interactions | `npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` | 20/20 pass |
| Bot messages (new) | `node --test tests/i-bot-messages.test.js` | 8/8 pass |
| Tasks | `node --test tests/h08-tasks.test.js` | 29/29 pass |
| Messages | `node --test tests/h05-messages.test.js` | 20/20 pass |
| Rooms | `node --test tests/h04-rooms.test.js` | 24/24 pass |
| DS Bot suite | `npm test` in `packages/bundle/ds-bot` | 629/630; the failure (`without a running version…`) also fails on a clean tree |
| Build | `node scripts/build-client.mjs --check` | exit 0 |
| Lint | `node scripts/lint.mjs` | 0 errors, 21 pre-existing warnings |
| Typecheck | `pnpm run typecheck` | fails at `Host Typert` / `permission-presets` paths on a clean tree too |

### Pre-existing failures found, not caused by this change

- `server/tests/e-mention-attachment.test.js`: two cases (`mentioning a colleague's Bot…`,
  `mentioning a Bot that is not available…`) fail because their fixture never adds the Bot to the room,
  so `assertMentions` answers `BOT_NOT_IN_ROOM` before the assertion they make. Identical on a clean tree.
- `server/tests/h09-grants.test.js`: 22 cases fail on the same missing Bot membership in `pendingTask()`.
  Identical on a clean tree (1 pass / 22 fail both before and after).
- `packages/bundle/ds-bot`: `without a running version there is nothing to compare against`.
- `pnpm run typecheck`: `Host Typert` fails on `permission-presets` tsconfig paths.

## 9. Approval Gate

Execution performed. Changed files above are the actual diff.
