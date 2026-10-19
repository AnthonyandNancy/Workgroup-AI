# 工作群复刻原群聊：技术调查与技术设计（v2）

| 字段 | 内容 |
|---|---|
| 文档状态 | 技术调查与技术设计完成，待进入 Implementation Plan |
| 需求来源 | `docs/requirements/workgroup-parity-requirement.md`（已定稿，含 R14a 与 D1/D2） |
| 取代关系 | 取代 `workgroup-parity-technical-design.md`（v1）；v1 保留作历史调查记录 |
| 调查范围 | `application/packages/bundle/ds-bot`（host + client）、`application/integrations/workgroup`、`server/` |
| 代码阶段 | 仅调查与设计，未进入 Coding |
| 证据等级 | 当前仓库源码级调查；真实 UI 点击与像素对照尚未执行 |
| 本轮关键裁决 | 主持管理员应答普通消息**不走任务审批**（R14a / D2） |

---

# 当前系统

## 当前流程

### 原群聊的「管理员应答」（C-1 要对齐的基线）

```text
用户发消息
↓ client/composer → host/channel.js 'send' → turns.js 入 roomInbox
↓ host/groups.js group_relay → openingSpeakers(room, opener)
    ├─ 有 @：被点名者
    ├─ 无 @ 且 mode='admin'：admin
    └─ 无 admin：全员轮流
↓ runRound → groupSessionFor(room, member)
    ├─ 首次：createSession(`${bot.name} · ${room.name}`, { dir: workDirOf(...) })
    ├─ room.sessions[botId] = sessionId
    ├─ groupOwners.set(sessionId, { botId, roomId })
    └─ applyPermission(member, sessionId, room)   ← 群级预设覆盖 Bot 自身
↓ rt.deliver({ role:'room', roomId, sessionId, text, note })
    └─ delivery.js 生成 `[Group chat "X" · note]` 头 + followup
↓ Bot 在自己的 Session 里正常跑一轮（记忆、提示词、工具、权限预设全部生效）
↓ 若某工具需要批准：approvals.js 拦截 approval/request
    ├─ groupOwners 有该 sessionId → 生成群内审批卡
    ├─ rt.yieldRoomTurn(sessionId) → 该轮标记「等用户批准」
    └─ 用户在本机卡片上 allow/reject → 继续或中止
↓ Bot 输出文本 → postInRound → 群日志 + 用户可见气泡
```

**核心结论：原群聊里没有任何「任务审批」参与管理员应答。** 是否行动完全由 Bot 的权限预设与它自己的记忆/提示词决定。

### 工作群当前

```text
用户发消息 → POST /rooms/:id/messages
↓ sendMessage → 落库 + 广播 message.created
↓ 若 mention 带 botId → proposeTasksForMentions → createTask(PENDING_APPROVAL)
↓ 无 mention 时：什么都不会发生（没有主持应答）
↓ 客户端 MessageLine 渲染（Bot 行用 senderBotId 判定）
```

工作群**没有「Bot 在该群的会话」这个概念**：Bot 只通过一次性 Task Session 参与，因此任何 Bot 发言都必须先有任务、审批、授权。

### 工作群的建群与打开

```text
「创建工作群聊」→ openNewChat('workgroup') → workgroup-ui/create.js
↓ workgroups.createRoom(name, { kind:'workgroup', botIds })
↓ host/workgroup-hub.js 'hub-create-room' → POST /api/v1/rooms
↓ rooms/store.js createRoom（rooms + room_members(owner) + room_bots）
↓ workgroup-entry.js enterWorkgroup → sessions.create({sessionId:'wg:<roomId>'}) → openSession → watch
↓ workgroup-pane.js openRoom
   GET /rooms/:id + GET /rooms/:id/messages?limit=200 + GET /rooms/:id/tasks
↓ workgroup-ui/index.js WorkgroupConversation 渲染（自有 head / thread / composer / details）
```

## 当前数据模型

| 侧 | 结构 | 说明 |
|---|---|---|
| Hub `rooms` | `id,name,owner_user_id,next_seq,created_at` + `kind`(0009) + `dissolved_at/by`(0011) + `notice`(0014) | **缺** `reply_mode`、主持 Bot、`work_dir`、`permission` |
| Hub `room_members` | `role ∈ owner/admin/member`, `joined_at`, `removed_at` | 真人角色；与 Bot 管理员无关 |
| Hub `room_bots` | `(room_id,owner_user_id,bot_id)` PK, `display_name`, `added_*`, `removed_at` | **缺** 管家标记 |
| Hub `bot_directory` | `visibility ∈ private/room/public`, `state`, `last_seen_at`, `published_at` | **缺** 管家标记（Host 只上报 name+visibility） |
| Hub `messages` | `room_seq`, `sender_user_id`, `sender_bot_id`(0015), `client_message_id`, `body`, `mentions_json`, `attachments_json`, `reply_to_message_id` | Bot 身份已具备；**缺** 反应 |
| Hub `tasks` | 状态机 + `version` + `revocation_version` + `result_text`(0015) | 已够 |
| Hub `task_events` / `approvals` / `dispatch_grants` | — | 已够 |
| Hub `artifacts` | `acl_json = { roomId, userIds[], contentType }` | 分享需扩大 `userIds` |
| Hub `group_memories` / `memory_revisions` | — | 已够 |
| Host `state.rooms[id]` | `{ id, name, members[], admin, mode, notice, workDir, permission, sessions:{botId→sessionId}, seen{} }` | **仅本地群**；`id` 就是本地 Session id |
| Host `groupOwners` | `Map<sessionId, {botId, roomId}>` | 群会话归属；`approvals.js` 靠它决定是否出群内审批卡 |
| Host `state.taskSessions` | `{ [taskId]: { taskId, botId, sessionId, workDir, openedAt, closedAt } }` | 一次性任务会话的持久绑定 |
| Client `WorkgroupRoomState` | `{ room, members, bots, messages, tasks, events, schedules, head, …Stale }` | `integrations/workgroup/client/index.mjs` |
| Client `workgroup-prefs` | `{ [roomId]: { pinned, hidden, lastReadSeq } }` | `ds-bot:workgroup-prefs` |
| Client 侧栏行 | `publicRoomSummary` + `{ pinned, hidden, unread, lastActivityAt }` | `workgroupRow()` 计算 |

## 当前模块职责

| 模块 | 拥有什么 | 与 C-1 的关系 |
|---|---|---|
| `host/groups.js` | 本地群的轮次、主持人、投递、回复收集 | **管理员应答的真正实现处** |
| `host/roster.js` | `createRoom`/`updateRoom`/`isAdminOf`/权限 | 本地群治理与 `checkMembers`（2–12） |
| `host/delivery.js` | `deliver()` 与 `headerFor()`，靠 `rt.roomOf(roomId)` 取群名 | Bot 消息进入 Session 的唯一通道 |
| `host/approvals.js` | `approval/request` 拦截；按 `groupOwners` 出群内卡 | **决定「等用户批准」是否成立** |
| `host/permissions.js` | 预设目录、`applyPermission`、`setRoomPermission` | 群级预设覆盖成员预设 |
| `host/task-dispatch.js` | 跨用户任务：`task.approved` → `openTaskSession` → `mintGrant` | **与主持应答无关** |
| `host/task-sessions.js` | 一次性隔离 Session + 持久绑定 | 同上 |
| `host/workgroup-hub.js` | Hub 桥、目录发布、心跳、事件转发 | 需成为工作群轮次的入口 |
| `server/modules/rooms/*` | 房间/成员/Bot 关系/邀请/解散 | Hub 侧治理 |
| `server/modules/messages/store.js` | 发送幂等、mention→任务、分页 | 主持应答的消息落点 |
| `server/modules/tasks/store.js` | 状态机、`transition`、`createTask` | 跨用户任务唯一入口 |
| `client/workgroup-ui/*` | 工作群界面复制件 | 反应/更早消息/听写缺失 |
| `client/workgroup-sidebar.js` | 侧栏复制件（`WorkgroupRow` / `WorkgroupMenu`） | 菜单仅 2 项 |
| `client/workgroup-roster.js` | 轮询 + 本机偏好 + `markRead` | 未读仅本机计算 |

### 重复的业务规则（需在设计中收口）

1. **管理员判断**：原群聊 `store.js isAdminOf`（单值 `room.admin`）vs 工作群真人 `role=admin` —— 需拆成「真人角色」与「Bot 主持」两条正交判断。
2. **Bot 数量约束**：原群聊 `checkMembers`（整群 2–12）vs Hub 无任何上限 —— 工作群按「每人 ≤12、管家 ≤1」新建规则。
3. **未读**：原群聊 `completionUnread`（会话状态）vs 工作群 `lastSeq - lastReadSeq`（本机偏好）—— 需求要求并存，必须明确各自职责。
4. **`@all`**：原群聊在 Host 内存用 `mentionsIn` + `leads` 判定；工作群 mention 只带 `{ userId, botId }`，**Hub 无 `@all` 概念**。
5. **Bot 发言归属**：原群聊靠 `room.sessions[botId]`；工作群靠 `tasks.assigned_bot_id` —— C-1 后需第三条：工作群长期 Bot 会话。

## 可复用能力

| 能力 | 位置 | 用途 |
|---|---|---|
| **持久群会话创建模式** | `groups.js groupSessionFor` | 工作群主持会话可直接照此创建：`createSession(title,{dir})` + 登记归属 + `applyPermission` |
| **`deliver(role:'room')`** | `delivery.js` | Bot 消息进 Session 的唯一通道；只需让它能取到工作群名字 |
| **群内审批卡** | `approvals.js` + `groupOwners` | 主持管理员要工具批准时，卡片出现在群里而不是卡住 |
| **群级预设覆盖** | `permissions.js applyPermission` | R34 群级权限落地 |
| **`sendMessage({senderBotId})`** | `server/modules/messages/store.js` | Bot 回复写回 Hub（0015 已有） |
| **mention→任务** | `proposeTasksForMentions` | 主持管理员用 `@名字` 派活时自动变成待审批任务 |
| **`isBotInRoom`** | `server/modules/rooms/bots.js` | 唯一 Bot 成员判定 |
| **`publicRoom` 单一投影** | `server/modules/rooms/store.js` | 新增字段与 `effectiveReplyMode` 都从这里出 |
| **`reduceWorkgroup`** | `integrations/workgroup/client/index.mjs` | 事件归并模式 |
| **设置卡片组件** | `client/bot-settings.js`（`Card/Row/InlineText/SwitchRow/Segmented`）、`client/folder-menu.js` | 群设置页直接复用 |
| **听写逻辑** | `client/composer.js useDictation` | 复制到工作群 composer（不 import 原文件） |
| **Web 端回归骨架** | `integrations/workgroup/tests/a22-workgroup-ui.spec.ts` + `output/playwright/` | 扩展为逐屏对照 |

---

# Impact Map

## 直接影响

| 模块 | 变化 |
|---|---|
| `host/workgroup-turns.js`（**新增**） | 工作群主持应答：会话创建/复用、消息投递、回复收集、写回 Hub、去重与串行 |
| `host/workgroup-hub.js` | `message.created` 分发给 `workgroup-turns`；目录上报 `isChief`；新增 `hub-*` 动作 |
| `host/delivery.js` | `deliver` 接受显式 `roomName`（工作群不在 `state.rooms` 里） |
| `host/approvals.js` | 工作群 Bot 会话也要能出群内审批卡（登记归属） |
| `host/store.js` | 新增 `state.workgroupRooms` 与索引重建 |
| `host/permissions.js` | `applyPermission` 支持工作群 room（`permission` 来自 Hub） |
| `server/db/migrations/0016_workgroup_parity_v2.sql`（新增） | `rooms` 4 列 + `room_bots.is_chief` + `bot_directory.is_chief` + `message_reactions` |
| `server/src/modules/rooms/store.js` | `createRoom` 校验、`updateRoom` 新字段、`dissolveRoom` 主持分支、`publicRoom` 投影 |
| `server/src/modules/rooms/bots.js` | 三条加 Bot 路径的配额校验 |
| `server/src/modules/messages/store.js` | `@all`、`beforeSeq`、反应委托 |
| `server/src/modules/messages/reactions.js`（新增） | 反应增删与校验 |
| `server/src/modules/artifacts/store.js` | 按任务把附件 ACL 扩为全体成员 |
| `server/src/api/rooms.js` / `messages.js` / `tasks.js` | 路由字段与两条反应路由 |
| `client/workgroup-ui/thread.js` | 反应渲染、更早消息、Admin 标记 |
| `client/workgroup-ui/composer.js` | 听写、`@all` 候选 |
| `client/workgroup-ui/settings.js` | 补 `Who answers` / `Working folder` / `Permissions` 三卡 |
| `client/workgroup-sidebar.js` | 菜单 2 项 → 7 项 |
| `client/index.js` | `openSettings('groups')` 支持工作群、`markUnread` 支持工作群、打开即标已读 |
| `client/settings.js` + `client/overlays.js` | `SettingsDialog` 的 `groups` 页支持工作群房间 |
| `integrations/workgroup/client/index.mjs` | 新字段、`@all`、`beforeSeq`、反应、`reduceWorkgroup` 新事件 |
| `server/contracts/openapi.yaml` / `events.schema.json` | 对应条目 |

## 上游

| 上游 | 关注点 |
|---|---|
| Bot 目录发布（`host/workgroup-hub.js`） | 必须上报 `isChief`——否则管家链路整条不可用，这是**唯一事实来源** |
| 建群三入口（新建菜单 / 设置页群聊页 / 命令面板） | 都指向同一创建表单；参数新增 `adminBotId` |
| 邀请流程（真人 / Bot） | 接受时校验配额；成员移除连带回收管家身份与主持位 |
| 群主转让 / 成员移除 | 主持管理员若属被移除成员，按原群聊「不自动补位」处理 |
| 群级权限设置入口 | 仅群主可设，且要下发到全体 Host |
| **主持管理员的 Host 是否在线** | **C-1 之后新增的关键上游**：主持应答依赖该 Host 正在运行并订阅该 room |

## 下游

| 下游 | 关注点 |
|---|---|
| 消息事件消费 | `message.created` 现在有两个消费者：客户端渲染 + **主持 Host 的轮次** |
| 任务派发 | `@名字` / `@all` 仍走 `createTask`；**主持应答不再走这里** |
| 审批卡 | 群内工具批准卡与跨用户任务审批卡并存，UI 需区分两类 |
| 任务分享 | 附件 ACL 扩大后 `mayReadArtifact` 对全房间成员放行 |
| 未读与提示 | 徽标 = `max(Hub 计数, 本机标为未读)`；打开会话触发 `markRead` |
| 侧栏排序 | 置顶 + 活跃时间，工作群已实现，不需改 |
| 审计 | 新增：管家加/移除、主持移交、群目录/权限变更、Bot 解散 |
| Hub 管理端 | 解散一致性（复用 `dissolveRoom`）+ 新字段 |
| 搜索 / 命令面板 | 工作群名称参与搜索；新字段不影响 |
| 打包部署 | 无新增进程；Host 与 Hub 需配套升级 |

## 横向

- **列表**：`GET /rooms`（`publicRoomSummary`）带 `replyMode` / `adminBot*`，侧栏与设置页共用。
- **详情**：`GET /rooms/:id`（`publicRoom` + members + bots）带 `isChief`。
- **创建**：`POST /rooms`。
- **编辑**：`PATCH /rooms/:id`。
- **审批**：两类（任务审批 / 工具批准），只增入口不改状态机。
- **日志**：`audit_events`。
- **实时**：新增 `room.settings_changed`、`room.admin_bot_changed`、`message.reaction_changed`。
- **后台任务**：无定时任务改动；定时消息沿用现有本机调度。
- **管理端**：`server/src/api/admin.js` 已复用 `dissolveRoom`，自动继承新权限分支。
- **用户端**：侧栏、会话、设置、详情四个面全改。

## 确认无需修改

- 原群聊全部文件（`client/sidebar.js`、`cells.js`、`header.js`、`details-drawer.js`、`mark.js`、`styles.js`、`host/groups.js`、`host/roster.js`）。
- `tasks` 状态机、`approvals` 表、`dispatch_grants`、`task-grants.js` 的工具守卫、`policy/` 目录。
- `group_memories` / `memory_revisions` 与其 ACL。
- 消息幂等键、`room_seq` 分配、断线补拉顺序语义。
- Hub 鉴权、邀请 TTL、审计写入机制、备份恢复、打包部署。
- DSH Agent Loop、Bot 原生 Session 绑定。

---

# Requirement 对照

## 已满足

| Requirement | 现状 |
|---|---|
| R1/R2 原群聊基线不改 | 工作群已是复制件；本轮不触碰原群聊 |
| R4 两个实体分离 | `rooms.kind` + `wg:` 命名空间 + 独立 overlay |
| R12 成员自助加自己的 Bot | `addOwnBot`（`requireMember` + 目录归属校验） |
| R13 owner/admin 可移除他人 Bot、成员移除连带其 Bot | `removeRoomBot` + `removeBotsOwnedBy` |
| R22 跨用户任务只有所有者本人可审批 | `decideTask` 校验 `owner_user_id` |
| R23 分享后正文对全群广播 | `publishResultMessage`（0015 已实现） |
| R25 Bot 身份发言 | `sendMessage({senderBotId})` + `publicMessage` + `MessageLine.fromBot` |
| R36 非成员不可读 | `requireMember` → 404 语义 |
| R37 幂等与顺序 | `client_message_id` 唯一键 + `room_seq` |
| R38 邀请需接受 | `invitations` 流程 |
| R39 提及用稳定 id、回复同群、引用他人私聊拒绝 | `assertMentions` / `assertReplyTarget` / composer 禁用引用 |
| R40 定时任务不绕审批 | 定时消息只是普通消息延迟发送 |
| R41 终态不可恢复 | `canTransition` |
| R35 历史群不处理 | 无需迁移 |

## 需要修改

| Requirement | 需要变化 |
|---|---|
| R5 建群 ≥2 Bot | `createRoom` 加 Bot 数量校验（当前允许 1 个甚至 0 个） |
| R6/R7/R8 创建者带 1 个管家、邀请可选 | 创建参数加 `adminBotId`；创建时不要求真人邀请 |
| R9/R10/R11 归属与配额（管家 ≤1、每人 ≤12） | 三条加入路径统一加校验 |
| **R14/R14a 主持应答不走审批** | **新增 `workgroup-turns` 模块 + 工作群 Bot 会话 + `deliver` 支持 + 审批卡归属** |
| R15/R16 管家身份与管理员能力 | Hub 存 leader + `room_bots.is_chief` / `bot_directory.is_chief` |
| R18/R19 主持移交与空缺回退 | `updateRoom` + `publicRoom.effectiveReplyMode` |
| R20 解散含主持管理员 | `dissolveRoom` 分支 |
| R24 分享后附件全群可下载 | `share` 扩 ACL |
| R26 `@all` 仅管理员 | mention 新类型 + 校验 |
| R27/R28 反应、听写、更早消息 | 三者全缺，需新增 |
| R30 侧栏 7 项菜单 | 从 2 项扩到 7 项 |
| R31 群设置打开全局设置页 | `SettingsDialog` 支持工作群 |
| R32 未读双机制 | 徽标合成规则 |
| R33/R34 群目录与群权限 | Hub 存 + Host 下发 + 覆盖预设 |
| R3 Web 端视觉一致 | 逐屏对照回归 |

## 需要新增

1. `host/workgroup-turns.js`：工作群 Bot 会话与轮次。
2. `state.workgroupRooms` 持久结构（会话绑定、seen、轮次序号）。
3. `isChief` 上报（`bot_directory` + `room_bots`）。
4. 主持管理员字段与移交。
5. `reply_mode` + `effectiveReplyMode`。
6. `@all` mention 类型。
7. `message_reactions` 表 + 两条路由 + 事件 + `reactions.js`。
8. `beforeSeq` 向前翻页。
9. 群目录 / 群权限字段与下发。
10. 侧栏 5 项新菜单与动作。
11. 工作群接入全局设置对话框。
12. 听写 + 更早消息 UI。
13. 分享扩大附件 ACL。
14. `contracts/openapi.yaml` / `events.schema.json` 对应条目。

## 冲突

**无需求层冲突。** 以下为已裁决并在实现中必须显式收口的事项：

### C-1（已裁决 → 本设计核心）

主持管理员应答普通消息 = **直接进该 Bot 在群里的长期会话**，不产生任务、不需要逐条批准；是否行动由 Bot 的记忆/提示词与**权限预设**决定。

- 需求落点：R14a、D2。
- 边界：R17/R22 收窄为「**他人委托的跨用户任务**必须所有者本人批准」。
- 实现含义：工作群需要一类**长期、属于该群的主持 Bot 会话**，而非一次性任务 Session。

### C-2（已裁决）

群目录与群权限对全群生效，取代 `TECHNICAL_BLUEPRINT.md` 的禁止条款；**跨用户任务仍需所有者批准**，群目录/群权限只是执行环境默认值。需求落点：R33/R34、D1。

### C-3（无需裁决）

侧栏「删除群聊」→「解散」：位置/图标/危险样式/二次确认沿用；文案与后果按解散（`dissolve` 语义已存在）。

---

# 技术设计

## 数据

### 迁移 `0016_workgroup_parity_v2.sql`

| 变更 | 约束与默认 |
|---|---|
| `rooms.reply_mode TEXT NOT NULL DEFAULT 'everyone'` | `CHECK (reply_mode IN ('admin','everyone'))`；既有工作群保持现行为 |
| `rooms.admin_bot_owner_user_id TEXT` / `rooms.admin_bot_id TEXT` | 复合定位（Bot id 只在所有者命名空间内唯一）；`NULL` = 无主持 |
| `rooms.work_dir TEXT` / `rooms.permission TEXT` | `NULL` = 未设置 |
| `room_bots.is_chief INTEGER NOT NULL DEFAULT 0` | 管家标记镜像 |
| `bot_directory.is_chief INTEGER NOT NULL DEFAULT 0` | Host 上报 |
| `CREATE TABLE message_reactions (room_id, message_id, user_id, emoji, created_at)` | PK `(message_id, user_id, emoji)`；索引 `(message_id)` |

### Host 侧 `state.workgroupRooms`

```text
state.workgroupRooms[roomId] = {
  sessions: { [botId]: sessionId },   // 该 Bot 在本群的长期会话
  seen:     { [botId]: roomSeq },     // 已投递到的 Hub 序号
  turns:    { [botId]: number },      // 该会话已发言次数（用于确定性 clientMessageId）
  openedAt,
}
```

- **持久**（写入 team file，随 `save()`），重启后复用同一 Session —— 与原群聊「群会话长期存在」同构。
- 索引重建时把这些 sessionId 一并登记到会话归属表，使 `approvals.js` 能为它们出群内审批卡。

### 关键数据约束

| 约束 | 位置 |
|---|---|
| 建群 ≥2 Bot | `rooms/store.js createRoom` |
| 创建者必须带 1 个 `is_chief=1` 的 Bot | 同上 |
| 每成员管家 Bot ≤1 | `rooms/bots.js` 三条写入路径 |
| 每成员名下 Bot ≤12（含管家） | 同上 |
| 主持人必须是在群且 `is_chief=1` 的 Bot | `rooms/store.js updateRoom` |
| 反应只能删自己那行 | `api/rooms.js` 反应路由 |
| `@all` 仅 owner/admin/主持所有者 | `messages/store.js assertMentions` |

### 历史数据

新列全部可空或带默认值，**不回填**（R35）。`is_chief` 在升级后首次心跳自动补齐。无需 SQL 数据迁移。

### 唯一真实分歧点：如何表达「谁是管家 Bot」

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采纳）** | Host 上报 `isChief`，Hub 在 `bot_directory` 与 `room_bots` 上镜像 | 主持人/Admin 徽标/配额校验都能在服务端完成，客户端无需信任本地名册；跨设备一致。代价：新增上报字段，存在心跳周期内的短暂不一致 |
| B | Hub 完全不存，客户端各自从本地 roster 判断 | 零数据变更，但**无法在服务端校验「每人管家 ≤1」**，也无法给其他成员渲染 `Admin`，R10/R15 无法满足 |

采纳 A。不一致窗口用「心跳 + 写入时以当前上报为准」收敛；它只影响徽标展示，**权限判定始终读 `room_bots.is_chief`**。

## 核心流程

### 1. 建群与开场

```text
用户提交（名称可选、botIds[]、adminBotId）
↓ 客户端提示：≥2 个 Bot 且含自己的管家 Bot
↓ POST /rooms { kind:'workgroup', botIds, adminBotId }
↓ createRoom
   ├─ 校验 botIds 全属 caller、adminBotId ∈ botIds 且 is_chief=1、botIds.length ≥ 2
   ├─ 事务：rooms(含 admin_bot_*) + room_members(owner) + room_bots(is_chief 快照) + audit
   └─ 返回 room
↓ 群广播 room.created；客户端打开 wg:<roomId>
↓ 群主的 Host 收到 room.created（或打开该 room 时）
   → workgroup-turns 为主持创建群会话，投递 kickoff：
     「用户刚创建了这个工作群，还没有发言。用一句话问候并询问这个群要做什么。」
↓ Bot 正常作答（记忆 + 提示词 + 权限预设）
↓ 回复写回 Hub：POST /rooms/:id/messages { senderBotId, clientMessageId:'wg-turn:<roomId>:<botId>:0' }
↓ 所有成员看到 Bot 开场气泡
```

> **开场不写成系统消息**：Bot 的话必须由 Bot 产生（R10），因此它天然带权限预设与执行边界；开场失败时群内保留「等待主持管理员开场」的降级态。

### 2. 普通消息 → 主持应答（C-1 的核心）

```text
成员 A 发消息
↓ POST /rooms/:id/messages（无 mention）
↓ sendMessage 落库 + 广播 message.created
↓ 【客户端】渲染气泡
↓ 【主持管理员的 Host】收到 message.created
   ├─ 判定：effectiveReplyMode==='admin'
   │        且该 room 的主持就是我的 Bot
   │        且消息无 mention
   │        且不是我自己发的
   ├─ 取/建 state.workgroupRooms[roomId].sessions[leaderBotId]
   │    createSession(`${bot.name} · ${room.name}`, { dir: room.workDir ?? bot.workDir })
   │    登记会话归属（供 approvals.js 出群内卡）
   │    applyPermission(bot, sessionId, { permission: room.permission })   ← R34
   ├─ rt.deliver({ role:'room', roomId, roomName, sessionId, text, note:'new message from a member' })
   └─ 等该轮结束
↓ Bot 跑一轮
   ├─ 要工具批准且预设=ask → approvals.js 出群内卡片 → 本机用户 allow/reject
   └─ 是否自主行动由 Bot 自己的记忆与提示词决定（例如「你自己决定，不用问我」）
↓ 回复文本 → 写回 Hub（senderBotId），失败重试一次，仍失败则本机告警
↓ 若回复里 @ 了某个 Bot → 该消息的 mentions 正常触发 proposeTasksForMentions → 待审批任务
```

**必须成立的边界：**

- 同一消息**只投递一次**：`state.workgroupRooms[roomId].seen[botId]` 记录已投递的最大 seq，重启后从持久值恢复。
- 主持 Bot **不回应自己的消息**（发送者 sessionId 与投递目标相同则跳过）。
- 主持 Bot 已有轮次在处理时，新消息**排队**而非并发开第二个轮次（`rt.live` 判定 + 队列）。
- Host 离线 → 该消息无人应答；群内不显示「正在思考」，只显示普通消息（诚实降级）。

### 3. 点名 Bot（不变）

```text
消息含 { userId, botId } mention
↓ proposeTasksForMentions → createTask(PENDING_APPROVAL)
↓ 该 Bot 所有者审批 → task.approved → task-dispatch → openTaskSession → 隔离 Session 执行
↓ owner recordTaskResult → share → 以 Bot 身份广播
```

**与主持应答完全分离**：前者是跨用户任务（需审批），后者是本群主持（不需审批）。

### 4. `@all`

```text
消息含 { all: true }
↓ assertMentions：调用者须 owner / admin / 本群主持的所有者，否则 MENTION_ALL_NOT_ALLOWED
↓ 展开为「在群内所有 Bot 成员 + 若存在主持则主持优先」
↓ 主持目标按普通应答路径直接进会话；其余目标生成待审批任务
```

### 5. 表情反应

```text
POST /rooms/:id/messages/:msgId/reactions { emoji }
↓ 成员校验 + 消息属于该房间 + emoji 白名单
↓ INSERT OR IGNORE (message_id, user_id, emoji)
↓ 广播 message.reaction_changed { messageId, reactions }
撤销：DELETE 同路径，只能删自己那行；不存在也返回成功（幂等）
```

### 6. 分享

```text
POST /tasks/:id/share
↓ owner 校验 → transition(SHARED)
↓ 同一事务内：把该 task 关联 artifacts 的 acl.userIds 扩为全体当前成员
↓ publishResultMessage（已有）→ Bot 身份广播正文
↓ task.shared 事件
```

### 7. 解散（三条路径）

```text
POST /rooms/:id/dissolve
├─ membership.role === 'owner' → 允许
├─ 调用者拥有 rooms.admin_bot_* 指向的 Bot → 允许（主持管理员解散）
└─ actorOperatorId（Hub 管理端）→ 允许
↓ 统一：撤销待处理邀请 / Bot 邀请 / 取消未完成任务 / 广播 room.dissolved
↓ Host 侧收到后归档该群 Bot 会话并清理 state.workgroupRooms[roomId]
```

## 状态

### 工作群

```text
初始化中（建群成功，kickoff 已投递）
 ├─ 主持作答并写回 → 存续
 └─ 主持未作答（Host 离线/失败）→ 存续（无开场内容，群可用）
存续 → 已解散（终态；所有写路由先过 requireLiveRoom）
```

- 无回退；`isDissolved` 是唯一判定。
- 并发：`dissolveRoom` 在 `BEGIN IMMEDIATE` 内重读 `dissolved_at`，两次并发解散只有一次成功，另一次得 `ROOM_DISSOLVED`。

### 主持管理员

```text
有主持（admin_bot_* 指向 active room_bot 且 is_chief=1）
 ├─ 移交 → 新主持
 └─ Bot 被移除 / 所有者离群 / 降级 → admin_bot_* 置空（不自动补位）
无主持 → effectiveReplyMode 恒为 'everyone'（服务端计算，客户端不判断）
```

### 主持会话

```text
未创建 ── 第一条需应答的消息 ──→ 已创建（长期复用）
已创建 ── 群解散 / Bot 被移除 / 主持移交 ──→ 已归档
```

并发：同一 room 的主持轮次串行（队列）；跨 room 可并行。

### 任务

不变（`PENDING_APPROVAL → APPROVED → QUEUED → RUNNING → REVIEW_REQUIRED → COMPLETED/SHARED`，终态不可恢复）。

## 模块职责

| 职责 | 归属 | 说明 |
|---|---|---|
| 建群/配额/管家/主持人校验 | `server/modules/rooms/store.js` + `rooms/bots.js` | 服务端唯一裁决点；客户端只做前置提示 |
| `effectiveReplyMode` | `rooms/store.js publicRoom` | 单一来源，客户端不判断 |
| mention 校验（含 `@all`） | `messages/store.js assertMentions` | 复用现有校验器 |
| 跨用户任务生成 | `tasks/store.js createTask` | 三条路径共用 |
| 反应增删 | `modules/messages/reactions.js`（新文件） | 避免 `store.js` 继续膨胀 |
| 附件 ACL 扩大 | `artifacts/store.js` | 新增函数，由 `tasks.js` 调用 |
| **工作群 Bot 会话与轮次** | **`host/workgroup-turns.js`（新文件）** | 本设计的核心新模块 |
| 管家上报 | `host/workgroup-hub.js` 目录发布 | Host 侧唯一出口 |
| 群目录/权限下发到执行环境 | `host/permissions.js applyPermission` + `host/folders.js cleanWorkDir` | 执行前仍需本机 `approval.request` |
| 侧栏菜单动作 | `client/workgroup-sidebar.js`（发意图）+ `client/index.js`（实现） | 菜单不承载业务 |

**不新增顶层模块**：`workgroup-turns.js` 与 `reactions.js` 分别是 host / server 模块内文件，不构成第三代码边界。

## API

| 路由 | 类型 | 输入 | 输出 | 权限 | 幂等 / 错误 |
|---|---|---|---|---|---|
| `POST /rooms` | 改 | `{ name?, kind, botIds[], adminBotId }` | `{ room, bots }` | 登录用户 | `INVALID_BOT_COUNT`(<2) / `NOT_A_CHIEF_BOT` / `NO_SUCH_BOT` |
| `PATCH /rooms/:id` | 改 | `{ name?, notice?, replyMode?, workDir?, permission?, adminBot? }` | `{ room }` | `replyMode/workDir/adminBot`：owner 或主持所有者；`permission`：**仅 owner** | `NOT_ALLOWED` / `ROOM_DISSOLVED` |
| `POST /rooms/:id/dissolve` | 改 | `{}` | `{ roomId, pendingTasks }` | owner / 主持所有者 / operator | `ROOM_OWNER_REQUIRED` / `ROOM_DISSOLVED` |
| `POST /rooms/:id/bots` | 改 | `{ botId }` | `{ bot }` | 成员，Bot 须属自己 | `BOT_LIMIT_REACHED` / `CHIEF_BOT_LIMIT_REACHED` |
| `POST /rooms/:id/messages` | 改 | 见下 | `{ message, proposedTasks }` | 成员；`all` 仅 owner/admin/主持所有者 | `MENTION_ALL_NOT_ALLOWED`；重复键返回 200 |
| `GET /rooms/:id/messages` | 改 | `?afterSeq&beforeSeq&limit` | `{ messages, nextAfterSeq?, nextBeforeSeq?, hasMore }` | 成员 | `INVALID_CURSOR` |
| `POST /rooms/:id/messages/:msgId/reactions` | 新 | `{ emoji }` | `{ reactions }` | 成员 | `INVALID_EMOJI` / `NO_SUCH_MESSAGE`；同键重复=幂等成功 |
| `DELETE /rooms/:id/messages/:msgId/reactions/:emoji` | 新 | — | `{ reactions }` | 只能删自己的 | 不存在亦 200 |
| `POST /bots` | 改 | `{ botId, displayName, visibility, isChief }` | `{ bot }` | Bot 所有者 | — |
| `GET /rooms` / `GET /rooms/:id` | 改 | — | 加 `replyMode` / `effectiveReplyMode` / `adminBotOwnerUserId` / `adminBotId` / `workDir` / `permission`；bots 加 `isChief` | 成员 | — |
| `POST /tasks/:id/share` | 改 | `{ expectedVersion, recipients }` | `{ task, message?, sharedArtifacts }` | 任务所有者 | 三者同事务 |

`POST /rooms/:id/messages` 输入：

```text
{ clientMessageId, body, replyToMessageId?,
  mentions?: ({ userId, botId? } | { all: true })[],
  attachments?: { artifactId }[],
  senderBotId? }          ← Host 代 Bot 发言；服务端只接受「属于调用者且在群内」的 Bot
```

事件新增：`room.settings_changed`、`room.admin_bot_changed`、`message.reaction_changed`；全部带 `roomId`，客户端 reducer 按现有模式归并。

## 前端

### 入口与页面

| 面 | 变化 |
|---|---|
| 侧栏行 | 菜单 7 项；徽标 = `max(hubUnread, localMarked)`；打开会话触发 `markRead` |
| 会话 | 反应渲染、更早消息加载、「主持」标记、两类卡片（任务审批 / Bot 请求工具批准）视觉区分 |
| 输入区 | 听写按钮；`@` 候选含 `@all`（仅管理员可见） |
| 设置 | 新增 `Who answers`、`Working folder`、`Permissions` 三张卡；成员区混排真人/管家/普通 Bot |
| 详情 | 保留现有结构，补 `Admin` 标记 |

### 状态与数据来源

- 会话数据仍由 `openRoom` + `reduceWorkgroup` 提供；新字段全部走 `room.*`，不新增第二份本地状态。
- **更早消息**：`WorkgroupThread` 持 `beforeSeq` 游标（取自首次 200 条的头部），滚到顶时拉取并**前插去重**；失败保留已加载内容并给重试。
- **反应**：直接来自 `message.reactions`（分页与事件都带），reducer 覆盖整条消息。
- **主持状态**：只读 `room.effectiveReplyMode`，客户端不做第二份判断。
- loading / empty / error / success：沿用 `state.phase` 与 `bt-wg-empty`；开场未就绪时 empty 文案为「主持管理员正在准备开场」。

### 权限表现

| 用户 | 可见 / 可操作 |
|---|---|
| 群主 | 全部设置项（含 Permissions）、解散、重命名、移除任意 Bot |
| 真人管理员 | 除 Permissions 与解散外的设置项 |
| 主持管理员的所有者 | 对 `workDir` / `replyMode` 有与群主同等权利；解散入口以「管家 Bot」名义呈现 |
| 普通成员 | 只管理自己的 Bot；不能解散；能加反应、能删自己的反应 |

### 组件复用

`client/bot-settings.js` 的 `Card/Row/InlineText/SwitchRow/Segmented`、`client/folder-menu.js`、`client/motion.js useLinger`；听写从 `client/composer.js` 的 `useDictation` 复制（不 import 原 composer，保持原群聊文件不动）。

## 后端

- **Controller**（`server/src/api/*`）：鉴权门 + 参数整形 + 事件发布，无业务规则。
- **Domain**（`server/src/modules/*`）：所有校验与事务，沿用 `BEGIN IMMEDIATE` + `try/catch/ROLLBACK` 风格。
- **事务边界**：
  - `createRoom`：rooms + room_members + room_bots + audit；
  - `sendMessage`：messages + seq 递增 +（如需）mention 任务；
  - `dissolveRoom`：状态 + 邀请撤销 + 任务取消；
  - `share`：任务状态 + 附件 ACL 扩大 + 消息写入（失败则三者一起回滚，避免「状态已分享但附件未开」）。
- **并发与幂等**：消息 `client_message_id`；任务 `version`；解散事务内重读；反应复合主键；**主持轮次按 room 串行**。
- **异常**：沿用 `RoomError/RoomBotError/MessageError/TaskError` + 各自 `*Failure(reply, error)`；非成员一律 404。

### Host 侧 `workgroup-turns` 的落点

| 关注点 | 设计 |
|---|---|
| 触发 | `workgroup-hub.js publishWorkgroupEvent` 中，`message.created` 分发给 `rt.onWorkgroupMessage?.(event)` |
| 是否应答 | `room.effectiveReplyMode==='admin'` 且本机拥有 `admin_bot_*` 且消息无 mention 且非自己发 |
| 会话 | `state.workgroupRooms[roomId].sessions[botId]`；缺失时 `createSession` + 登记归属 + `applyPermission` |
| 投递 | `rt.deliver({ role:'room', roomId, roomName, sessionId, text, note })`（`deliver` 增加可选 `roomName`） |
| 回复 | 收集该轮助手文本 → `POST /rooms/:id/messages { senderBotId, clientMessageId:'wg-turn:<roomId>:<botId>:<n>' }` |
| 去重 | `seen[botId]` 存已投递的最大 seq，持久化 |
| 串行 | 同一 room 一轮未结束时新消息入队 |
| 失败 | 写回失败重试一次；仍失败则本机告警，不回退成「假装回答了」 |

## 兼容 / 迁移

| 项 | 处理 |
|---|---|
| 历史工作群 | 新列默认；`reply_mode='everyone'` 保持现有行为；无开场回填（R35） |
| 旧客户端 | 新字段为增量；读不到即退回当前行为 |
| 旧 Host | 不上报 `isChief` → 管家链路不可用；**Hub 在校验中返回可读错误而非静默降级**；Host 与 Hub 必须配套升级 |
| 旧接口 | 无 `beforeSeq` 时行为不变 |
| 旧页面 | 详情抽屉设置页保留，与全局设置页共享同一数据与校验 |
| 数据迁移 | 无需 SQL 回填；`is_chief` 由升级后首次心跳补齐 |

---

# 风险

```text
风险：主持管理员应答依赖其所有者的 Host 在线且订阅该 room
原因：C-1 之后应答走「Bot 在群里的长期会话」，Bot 只能在其所有者机器上运行
影响：主持离线时群内普通消息无人应答，且不会像任务那样留下"待审批"痕迹
处理：群内在主持不可达时显示明确状态（如「主持管理员未在线，消息已保存」）；这是忠实复刻原群聊的必然结果（原群聊群里 Bot 也只能在本机跑），不静默伪装成功
```

```text
风险：工作群 Bot 会话长期存在，与原群聊"群会话"同构，但跨设备数量会放大
原因：每个 (room, bot) 一个 Session，且需持久绑定
影响：Session 数量随参与的工作群增长；重启后需重建索引
处理：绑定写入 team file 并随 load 重建索引（照 taskSessions 的做法）；群解散 / Bot 移除时归档
```

```text
风险：审批语义分成两类，容易混淆
原因：跨用户任务（所有者审批）与群内工具批准（本机卡片）现在是两条独立链路
影响：UI 或文档若混为一谈，会误以为"管家可代批"
处理：两类卡片视觉与文案区分；R17/R22 明确只约束前者；D2 记录边界
```

```text
风险：消息事件有两个消费者，可能出现"客户端显示了、Host 没应答"或"重复应答"
原因：message.created 同时驱动渲染与主持轮次
影响：漏答或重复发言
处理：seen 游标持久化去重；主持轮次按 room 串行；clientMessageId 用确定性序号，Hub 幂等兜底
```

```text
风险：群级权限（R34）覆盖主持管理员的预设，可能让"由 Bot 自己决定"失效
原因：setRoomPermission 会覆盖成员在本群的预设
影响：群主以为交给了 Bot，实际被群级预设限制
处理：设置页明确显示"群权限将覆盖成员预设"；R14a 与 R34 的关系写进文案
```

```text
风险：管家 Bot 身份存在两份事实（本机 mainBotIds 与 Hub is_chief）
原因：事实只能由所有者本机产生
影响：徽标短暂不一致；极端下 Hub 认为已有管家而本地已降级
处理：以心跳与每次写入时的上报为准；权限判定只读 Hub；降级作为显式上报
```

```text
风险：群目录对全群生效（R33）与执行边界模糊
原因：目录由群主或管家设定，执行发生在各成员本机
影响：其他成员 Bot 可能被指向他设的目录
处理：目录只作默认执行目录，本机执行前仍走 approval.request；跨机目录不存在时明确失败不回退
```

```text
风险：表情反应从本机状态变为服务端共享状态
原因：原群聊无此概念（本机 localStorage），R28 要求全群可见
影响：高频小写入放大实时事件量
处理：事件按消息聚合（一次事件带该消息全部反应）；emoji 白名单
```

```text
风险：向前翻页需要新游标，而现有读接口是为断线补拉设计的
原因：只有 afterSeq
影响：实现不当会重复或跳页
处理：beforeSeq 独立于 afterSeq，返回 nextBeforeSeq；客户端前插按 roomSeq 去重
```

```text
风险：分享时三处写入必须同事务
原因：R23/R24 要求正文与附件同时放开
影响：部分成功 = 看得到正文但下载被拒
处理：单一事务，任一失败整体回滚并回报明确错误
```

```text
风险：`@all` 与主持应答都会新增任务，可能与现有 mention 任务重复
原因：同一消息可能既有 `@名字` 又触发主持应答
影响：重复任务、重复审批
处理：先算 mention 命中集合；非空则不生成主持应答（与原群聊 openingSpeakers 的优先级一致）
```

```text
风险：视觉一致性验收（R3）依赖 Web 端逐屏对照，工作量大且易遗漏
原因：工作群样式表远小于原群聊（129 行 vs 1066 行）
影响：多处细节（间距、动效、hover）可能不一致，验收反复
处理：以 a22 用例为骨架逐屏补结构断言，再做像素对照留档
```

---

# 技术方案摘要

```text
核心设计：
- 主持管理员应答普通消息 = 把消息投递进该 Bot 在本群的长期会话，不走任务、不需逐条批准；是否行动由 Bot 自身记忆/提示词与权限预设决定（R14a、D2）。
- 跨用户任务（他人 @ 某 Bot）保持原样：待审批 → 所有者批准 → 隔离 Task Session 执行。
- 两类审批链并存且边界清晰：任务审批（所有者）与工具批准（本机卡片）。
- 服务端是群治理的唯一裁决点：管家镜像、主持、应答模式、配额、@all、解散权限。
- publicRoom 输出 effectiveReplyMode，客户端不做第二份判断。

主要变化：
- Host 新增 workgroup-turns 模块与 state.workgroupRooms 持久结构（(room,bot) 长期会话 + seen 去重 + 串行）。
- deliver 支持显式 roomName；工作群会话登记到群会话归属，使其能出群内审批卡。
- rooms 增 reply_mode / admin_bot_* / work_dir / permission；room_bots 与 bot_directory 增 is_chief；新增 message_reactions。
- 建群强制 ≥2 Bot 且必须含创建者管家；三条加 Bot 路径统一配额校验。
- 消息增 beforeSeq、@all、反应；分享在同一事务内扩附件 ACL。
- 侧栏 2 项菜单 → 7 项；群设置接入全局设置对话框；会话补听写、更早消息、反应、Admin 标记。

复用：
- 原群聊的群会话创建模式（groupSessionFor）、deliver(role:'room')、approvals.js 群内审批卡、applyPermission 群级预设覆盖。
- server 侧 rooms/messages/tasks/artifacts 四个领域模块、三个权限门、transition、proposeTasksForMentions、sendMessage(senderBotId)、publicMessage、realtime 发布。
- 客户端 bot-settings 卡片、folder-menu、motion、useDictation、reduceWorkgroup。

新增：
- 0016 迁移、workgroup-turns 模块、workgroupRooms 状态、reactions 模块与两条路由、beforeSeq、@all、群目录/权限字段、isChief 上报、7 项侧栏菜单、设置页接入、听写与更早消息 UI。

关键影响：
- Host 与 Hub 必须配套升级（isChief 上报），否则管家链路不可用，需可读报错而非静默降级。
- 主持应答依赖其所有者 Host 在线；离线时明示状态，不伪装成功。
- 历史工作群不受影响（默认值 + 不回填）。
- 原群聊文件零改动。

风险：
- 主持 Host 离线则无人应答（原群聊同构限制）。
- 长期 (room,bot) 会话数量与重建成本。
- 两类审批语义混淆。
- 消息事件双消费者带来的漏答/重答。
- 群级权限覆盖主持预设可能削弱"自己决定"。
- 视觉一致性验收工作量大。
```

---

# 附录：与 v1 文档的差异

| 项 | v1（已作废） | v2（本文件） |
|---|---|---|
| 主持应答 | 假设为「生成待审批任务」 | **改为直接进 Bot 群内长期会话**（R14a / D2） |
| 审批语义 | 单一「所有者审批」 | 两类并存：跨用户任务审批 + 群内工具批准 |
| Host 状态 | 无工作群会话概念 | 新增 `state.workgroupRooms` |
| 群目录/权限 | 标为「按工作群模型替换」 | 按原群聊放开，取代实施书禁止条款（D1） |
| 管家 Bot | 未涉及 | 由 Host 上报 `isChief`，Hub 镜像 |
