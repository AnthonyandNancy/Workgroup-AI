# 工作群复刻原群聊（v2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 执行本计划。步骤用 checkbox（`- [ ]`）追踪状态；中断后按「## 执行状态」表恢复。

**Goal:** 让工作群在功能、界面、样式、初始化与侧栏菜单上与原群聊对齐，并保留工作群专属能力（Hub 状态、任务审批、群记忆、Bot 所有者）。

**Architecture:** 服务端（`server/`）成为工作群「群治理」的唯一裁决点（管家镜像、主持管理员、应答模式、配额、`@all`、解散权限、反应、向前翻页）。客户端 Host（`application/packages/bundle/ds-bot/src/host/`）新增 `workgroup-turns` 模块，为每个 `(room, bot)` 维护**长期群会话**，把群内普通消息直接投递给主持管理员——不走任务、不需逐条审批（需求 R14a / 设计 D2）。客户端 UI（`src/client/workgroup-*`）补齐反应、更早消息、听写、7 项侧栏菜单与设置页接入。

**Tech Stack:** Node.js 24 + Fastify + better-sqlite3 风格 SQLite（WAL）；React 18 `h()`（无 JSX）；Cordis slots；Node test runner（`node --test`）、Vitest（integration specs）、esbuild 客户端打包。

## Global Constraints

- 需求基线：`Workgroup-AI/docs/requirements/workgroup-parity-requirement.md`（R1–R41、R14a、D1、D2）。
- 技术设计：`Workgroup-AI/docs/design/workgroup-parity-technical-design-v2.md`。
- **原群聊代码零改动**：`client/sidebar.js`、`client/cells.js`、`client/header.js`、`client/details-drawer.js`、`client/mark.js`、`client/styles.js`、`client/composer.js`、`client/group-settings.js`、`client/settings.js`、`host/groups.js`、`host/roster.js`。工作群只改复制件。
- 不新增顶层代码边界：只有 `application/` 与 `server/`。新文件放在既有模块目录内。
- 不做与需求无关的重构；不新增当前需求用不到的抽象。
- 所有用户可见文案经 `t()`，并在 `src/client/i18n.js` 加中文条目。
- 修改 `src/client` 后必须重新生成 `application/packages/bundle/ds-bot/client.js`（`cd application/packages/bundle/ds-bot && node scripts/build-client.mjs`）。
- 迁移编号：本计划用 `0016_workgroup_parity_v2.sql`。既有最大编号是 `0015_bot_messages.sql`。
- 服务端测试用 `node --test "tests/*.test.js"`（不要在 `server/` 下写 `node --test tests/`，会找不到模块）。
- ds-bot 测试用 `npm test`（即 `node --import ./test/harness-resolve.mjs --test "test/*.test.js"`），须在 `application/packages/bundle/ds-bot/` 下执行。
- 未获用户明确指示，不 commit、不 push。
- **已知基线失败（非本次引入，不要试图修）**：`server/tests/e-mention-attachment.test.js` 两条（fixture 未把 Bot 加进房间）、`server/tests/h09-grants.test.js` 22 条、ds-bot `without a running version there is nothing to compare against`、`pnpm run typecheck` 的 typert 路径。

## 执行状态

| Task | 内容 | 状态 |
|---|---|---|
| 1 | 迁移 0016：rooms 4 列 + is_chief ×2 + message_reactions | 待执行 |
| 2 | 管家 Bot 上报链路（bot_directory → POST /bots → Host 发布） | 待执行 |
| 3 | createRoom：≥2 Bot、必须含创建者管家、快照 is_chief | 待执行 |
| 4 | Bot 配额校验（管家 ≤1、本人 ≤12，三条路径） | 待执行 |
| 5 | publicRoom 投影：replyMode / effectiveReplyMode / adminBot / workDir / permission / isChief | 待执行 |
| 6 | updateRoom：新字段 + 主持移交规则 + 主持空缺回退 | 待执行 |
| 7 | dissolveRoom：主持管理员的所有者可解散 | 待执行 |
| 8 | messages：`@all` 权限校验 | 待执行 |
| 9 | messages：`beforeSeq` 向前翻页 | 待执行 |
| 10 | reactions 模块 + 两条路由 + 事件 | 待执行 |
| 11 | share：把成果附件 ACL 扩为全体成员 | 待执行 |
| 12 | Host `workgroup-turns` + `state.workgroupRooms` + `deliver` 支持 roomName | 待执行 |
| 13 | Host `workgroup-hub` 接线（isChief 上报、message.created 分发、新增 action） | 待执行 |
| 14 | 客户端 Hub adapter：新字段、`@all`、`beforeSeq`、反应、reducer | 待执行 |
| 15 | UI thread：反应渲染、更早消息、Admin 标记 | 待执行 |
| 16 | UI composer：听写、`@all` 候选 | 待执行 |
| 17 | UI settings：Who answers / Working folder / Permissions 三卡 | 待执行 |
| 18 | 侧栏：7 项菜单与动作 | 待执行 |
| 19 | 设置页接入工作群 + 未读双机制 | 待执行 |
| 20 | 契约同步 + i18n + 重新生成客户端产物 | 待执行 |
| 21 | 验证：服务端用例、ds-bot 用例、构建、lint | 待执行 |

---

## Task 1：迁移 0016

**Files**
- Create: `server/db/migrations/0016_workgroup_parity_v2.sql`
- Test: `server/tests/h17-workgroup-v2-schema.test.js`

**当前行为**
`rooms` 只有 `kind`、`dissolved_*`、`notice`；`room_bots` 无角色列；`bot_directory` 无管家标记；没有反应表。

**修改内容**
新增（全部可空或带默认值，不回填）：

```sql
ALTER TABLE rooms ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'everyone'
  CHECK (reply_mode IN ('admin','everyone'));
ALTER TABLE rooms ADD COLUMN admin_bot_owner_user_id TEXT REFERENCES users(id);
ALTER TABLE rooms ADD COLUMN admin_bot_id TEXT;
ALTER TABLE rooms ADD COLUMN work_dir TEXT;
ALTER TABLE rooms ADD COLUMN permission TEXT;

ALTER TABLE room_bots ADD COLUMN is_chief INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_directory ADD COLUMN is_chief INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS message_reactions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions (message_id);
```

**对应需求** R5–R11、R14/R14a、R15/R16、R20、R26、R28、R33/R34；设计 §数据。

**依赖** 无。所有后续 Task 依赖它。

**验证** `node --test "tests/h17-workgroup-v2-schema.test.js"`：迁移后列存在、默认值正确、旧库（0015 后）升级不报错、`message_reactions` 主键冲突被拒。

---

## Task 2：管家 Bot 上报链路

**Files**
- Modify: `server/src/modules/bots/store.js`（`publishEntry` 接受 `isChief`）
- Modify: `server/src/api/bots.js`（`POST /api/v1/bots` 传入 `isChief`）
- Modify: `server/src/modules/bots/store.js`（`publicEntry` 输出 `isChief`）
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`（发布时上报 `isChief`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加用例）

**当前行为**
`publishEntry({ ownerUserId, ownerDeviceId, botId, displayName, visibility })`；Host 只上报 name + visibility（`host/workgroup-hub.js` 大约 390–412 行）。

**修改内容**
- `publishEntry` 增加 `isChief = false`，写入 `bot_directory.is_chief`（1/0）；`publicEntry` 输出 `isChief`。
- `POST /bots` 读取 `body.isChief === true`。
- Host 侧：`localBots()` 已能拿到 `rt.isMain(bot.id)`；在发布与心跳的 `body` 里带上 `isChief: rt.isMain(bot.id) === true`；`publishedBots` 记录里也存 `isChief`，以便管家降级时触发一次重发。

**对应需求** R15、R16、R9；设计 §数据（方案 A：Host 上报，Hub 镜像）。

**依赖** Task 1。

**验证** 服务端用例：发布 `isChief:true` 后 `GET /bots/directory` 返回 `isChief:true`；非布尔值被当作 false。

---

## Task 3：createRoom 校验与管家快照

**Files**
- Modify: `server/src/modules/rooms/store.js:229-275`（`createRoom`）
- Modify: `server/src/api/rooms.js:113-128`（`POST /rooms`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
`createRoom` 只校验 `assertRoomName` + 每个 botId 已发布；无数量下限、无管家要求、不写 `is_chief`。

**修改内容**
- 参数增加 `adminBotId`。
- 校验：`wantedBots.length >= 2`，否则 `INVALID_BOT_COUNT`。
- 校验：`adminBotId` 必填且 ∈ `wantedBots`，且该 Bot 在 `bot_directory` 中 `is_chief = 1`，否则 `NOT_A_CHIEF_BOT`。
- 插入 `rooms` 时写 `admin_bot_owner_user_id = ownerUserId`、`admin_bot_id = adminBotId`、`reply_mode = 'admin'`。
- 插入 `room_bots` 时写 `is_chief`（从 `bot_directory.is_chief` 读到的快照）。
- 只对 `kind = 'workgroup'` 强制以上规则；`ordinary` 保持原行为（Hub 管理端 `admin/store.js` 走 `createRoom` 时需同步传 `adminBotId` 或跳过校验——见「Plan 偏差」预案）。

**对应需求** R5、R6、R7；设计 §核心流程 1。

**依赖** Task 1、Task 2。

**验证** 用例：1 个 Bot 被拒（`INVALID_BOT_COUNT`）；缺 `adminBotId` 被拒；`adminBotId` 非管家被拒；合法请求返回 `adminBotId` 与 `replyMode: 'admin'`。

---

## Task 4：Bot 配额校验

**Files**
- Modify: `server/src/modules/rooms/bots.js`（`addOwnBot`、`inviteBot`、`acceptBotInvitation`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
`addOwnBot` 只要求成员身份 + Bot 已发布；无数量限制。

**修改内容**
新增两个内部校验，在三条写入路径共用：

```text
assertMemberBotQuota(db, { roomId, ownerUserId, botId, isChief })
  - 该成员在本群 active room_bots 计数（含本次）> 12 → BOT_LIMIT_REACHED
  - 若即将加入的 Bot 是管家（is_chief=1）且该成员已有 active 管家 → CHIEF_BOT_LIMIT_REACHED
```

`is_chief` 从 `bot_directory` 读，`room_bots.is_chief` 写快照。

**对应需求** R9、R10、R11。

**依赖** Task 1、Task 2。

**验证** 用例：第 13 个 Bot 被拒；同一成员第二个管家 Bot 被拒；不同成员各自计数互不影响。

---

## Task 5：publicRoom 投影

**Files**
- Modify: `server/src/modules/rooms/store.js:602-616`（`publicRoom`）
- Modify: `server/src/modules/rooms/store.js:625-635`（`publicRoomSummary`）
- Modify: `server/src/modules/rooms/bots.js:52-63`（`listRoomBots` 输出 `isChief`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
`publicRoom` 输出 `id/name/kind/ownerUserId/notice/createdAt/dissolvedAt/myRole`。

**修改内容**
`publicRoom` 增加：

```text
replyMode            room.reply_mode ?? 'everyone'
effectiveReplyMode   hasLeader ? reply_mode : 'everyone'    ← 有主持才可能为 'admin'
adminBotOwnerUserId  （存在才输出）
adminBotId           （存在才输出）
workDir              （存在才输出）
permission           （存在才输出）
```

`hasLeader` 判定：`admin_bot_id` 非空 **且** 该 `(room, owner, bot)` 在 `room_bots` 里 `removed_at IS NULL` **且** `is_chief = 1`。

`listRoomBots` 每条增加 `isChief: row.is_chief === 1`。

**对应需求** R18、R19、R33、R34；设计 §模块职责（「`effectiveReplyMode` 单一来源，客户端不判断」）。

**依赖** Task 1。

**验证** 用例：无主持时 `effectiveReplyMode === 'everyone'` 即使 `reply_mode === 'admin'`；主持被移除后 `effectiveReplyMode` 回退。

---

## Task 6：updateRoom 新字段与主持移交

**Files**
- Modify: `server/src/modules/rooms/store.js:314-400`（`updateRoom`）
- Modify: `server/src/api/rooms.js:277-300`（`PATCH /rooms/:id`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
`updateRoom` 只处理 `name`、`notice`。

**修改内容**
- 新增可更新字段：`replyMode`（`admin`/`everyone`）、`workDir`、`permission`、`adminBot`（`{ ownerUserId, botId } | null`）。
- 权限：`replyMode` / `workDir` / `adminBot` → owner 或**当前主持的所有者**；`permission` → **仅 owner**（`NOT_ALLOWED`）。
- 移交校验：新主持必须是在群（`removed_at IS NULL`）且 `is_chief = 1` 的 Bot，否则 `NOT_A_CHIEF_BOT`。
- 置空规则（同原群聊）：主持 Bot 被移除 / 其所有者离群时 `admin_bot_*` 置空，**不自动补位**。
- 通知客户端：字段变化时发布 `room.settings_changed`（`replyMode`/`workDir`/`permission`）或 `room.admin_bot_changed`。

**对应需求** R16、R18、R19、R33、R34；设计 §核心流程、§状态。

**依赖** Task 1、Task 5。

**验证** 用例：非 owner 改 `permission` 被拒；主持所有者改 `workDir` 成功；改主持为普通 Bot 被拒；移除主持 Bot 后 `adminBotId` 消失。

---

## Task 7：dissolveRoom 主持分支

**Files**
- Modify: `server/src/modules/rooms/store.js:675-730`（`dissolveRoom`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
只有 `membership.role === 'owner'` 或 operator 可解散。

**修改内容**
增加第三个允许条件：调用者在 `rooms.admin_bot_*` 指向的 Bot 的所有者 → 允许。审计 `details` 里记录 `via: 'leader_bot'`。

**对应需求** R20、R21。

**依赖** Task 1、Task 5。

**验证** 用例：主持所有者可解散；其他成员的管家 Bot 所有者被拒（`ROOM_OWNER_REQUIRED`）；群内解散与 Hub 管理端解散的 pending tasks 结果一致。

---

## Task 8：`@all` mention

**Files**
- Modify: `server/src/modules/messages/store.js:69-100`（`assertMentions`）
- Modify: `server/src/modules/messages/store.js:393-409`（`proposeTasksForMentions`）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
mention 只支持 `{ userId, botId? }`；Hub 无 `@all`。

**修改内容**
- `assertMentions` 接受 `{ all: true }`：校验调用者是 owner/admin 或**主持的所有者**，否则 `MENTION_ALL_NOT_ALLOWED`；`all: true` 不得与其它 mention 混用（`INVALID_MENTIONS`）；`all` 本身不落库为 userId。
- `proposeTasksForMentions`：遇到 `all` 时展开为「该群所有 active `room_bots`」；**排除主持 Bot**（主持走会话路径，见 Task 12）。

**对应需求** R26、R16；设计 §核心流程 4。

**依赖** Task 1、Task 5。

**验证** 用例：普通成员发 `@all` 被拒；owner 发 `@all` 生成多个待审批任务且不含主持。

---

## Task 9：`beforeSeq` 向前翻页

**Files**
- Modify: `server/src/modules/messages/store.js:280-300`（`readMessages`）
- Modify: `server/src/api/messages.js:94-115`
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
只有 `afterSeq`（向后）。

**修改内容**
`readMessages` 增加 `beforeSeq`：非空时按 `room_seq < beforeSeq DESC LIMIT pageSize` 取，再反转为升序返回，并给出 `nextBeforeSeq`（本页最小 seq）与 `hasMore`。`beforeSeq` 与 `afterSeq` 同时出现 → `INVALID_CURSOR`。

**对应需求** R27；设计 §风险（向前翻页独立游标）。

**依赖** 无（可与 Task 1 并行，但为顺序执行放在这里）。

**验证** 用例：300 条消息分页拉全、无重复无缺；`nextBeforeSeq` 最终为 0 时 `hasMore=false`。

---

## Task 10：表情反应

**Files**
- Create: `server/src/modules/messages/reactions.js`
- Modify: `server/src/api/rooms.js`（两条反应路由）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
无反应能力。

**修改内容**
`reactions.js` 导出：

```text
listReactions(db, { roomId, messageIds })   → Map<messageId, { emoji, userIds }[]>
addReaction(db, { roomId, messageId, userId, emoji, now })  → INSERT OR IGNORE
removeReaction(db, { roomId, messageId, userId, emoji })    → DELETE（仅自己那行）
```

`emoji` 白名单：`['👍','❤️','😂','🎉','👀','🙏']`，否则 `INVALID_EMOJI`。
路由：`POST /rooms/:id/messages/:msgId/reactions`、`DELETE /rooms/:id/messages/:msgId/reactions/:emoji`；均需成员身份；消息必须属于该 room（否则 `NO_SUCH_MESSAGE`）。变更后广播 `message.reaction_changed { messageId, reactions }`（**按消息聚合**）。

分页与 `publicMessage` 一并带上 `reactions`。

**对应需求** R27、R28；设计 §核心流程 5。

**依赖** Task 1。

**验证** 用例：加两次同 emoji 幂等；删他人反应无效；非成员 404。

---

## Task 11：share 扩大附件 ACL

**Files**
- Modify: `server/src/modules/artifacts/store.js`（新增 `shareTaskArtifactsWithRoom`）
- Modify: `server/src/api/tasks.js:341-375`（`share` 路由内调用）
- Test: `server/tests/h17-workgroup-v2-schema.test.js`（追加）

**当前行为**
`share` 只把任务转为 `SHARED` 并广播正文；附件 ACL 不变。

**修改内容**
新增 `shareTaskArtifactsWithRoom(db, { taskId, roomId, actorUserId })`：把 `artifacts` 中 `task_id = taskId` 的行的 `acl.userIds` 扩为**全体当前成员**。在 `share` 的同一事务语义内调用（状态与 ACL 一起成功或一起失败）。

**对应需求** R23、R24。

**依赖** Task 1。

**验证** 用例：分享前非接收人下载 403；分享后全群成员可下载；未分享任务不受影响。

---

## Task 12：Host `workgroup-turns`（C-1 核心）

**Files**
- Create: `application/packages/bundle/ds-bot/src/host/workgroup-turns.js`
- Modify: `application/packages/bundle/ds-bot/src/host/store.js:19`（state 增加 `workgroupRooms`）、`indexSessions`（登记归属）
- Modify: `application/packages/bundle/ds-bot/src/host/delivery.js:42`（`deliver` 接受 `roomName`）
- Modify: `application/packages/bundle/ds-bot/index.js`（MODULES 增加 `workgroupTurns`，置于 `workgroupHub` 之前）
- Test: `application/packages/bundle/ds-bot/test/workgroup-turns.test.js`

**当前行为**
工作群没有「Bot 在该群的会话」；`deliver` 靠 `rt.roomOf(roomId)` 取群名（工作群不在 `state.rooms` 里，取到 `undefined`）。

**修改内容**
- `state.workgroupRooms[roomId] = { sessions:{botId→sessionId}, seen:{botId→roomSeq}, turns:{botId→n}, openedAt }`，持久化；`indexSessions` 把这些 sessionId 登记到 `groupOwners`（键加前缀或新增 `workgroupSessionOwners`，使 `approvals.js` 能出群内审批卡）。
- `deliver({ ..., roomName })`：`headerFor` 用 `roomName ?? room?.name`。
- `workgroup-turns.js` 导出 `install(rt)` 并挂 `rt.onWorkgroupMessage = handleRoomMessage`：
  - 判定是否应答：`room.effectiveReplyMode === 'admin'` 且 `room.adminBotOwnerUserId === 本机 userId` 且消息无 mention 且 `message.senderUserId !== 本机 userId` 或 `senderBotId !== 该 Bot`；
  - 取/建会话：`createSession(`${bot.name} · ${room.name}`, { dir: room.workDir ?? bot.workDir })` + 登记归属 + `applyPermission(bot, sessionId, { permission: room.permission })`；
  - `rt.deliver({ role:'room', roomId, roomName, sessionId, text, note })`；
  - 收集该轮助手文本，写回 `POST /rooms/:id/messages { senderBotId, clientMessageId: `wg-turn:${roomId}:${botId}:${n}` }`；
  - `seen[botId]` 去重（持久化）；同一 room 串行（Promise 队列）；
  - 群解散收到 `room.dissolved` 时归档会话并清 `state.workgroupRooms[roomId]`。

**对应需求** R14、R14a、R10、R25；设计 D2、§核心流程 2。

**依赖** Task 1、Task 5（需要 `effectiveReplyMode` 与 `adminBot*`）。

**验证** ds-bot 单测：给定 room 快照 + 一条普通消息，断言只投递一次、回复以 `senderBotId` 写回、`seen` 前进、第二次相同 seq 不重投。

---

## Task 13：Host `workgroup-hub` 接线

**Files**
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`（`publishWorkgroupEvent` 分发 `message.created`；目录发布带 `isChief`；新增 `hub-*` action）
- Test: `application/packages/bundle/ds-bot/test/workgroup-turns.test.js`（追加）

**当前行为**
`publishWorkgroupEvent` 只做 `reduceWorkgroup` + `ctx.emit`。目录发布只带 name + visibility。

**修改内容**
- `publishWorkgroupEvent` 末尾追加 `rt.onWorkgroupMessage?.(event)`。
- 目录发布 body 增加 `isChief`（见 Task 2），`publishedBots` 记录字段同步。
- 新增 action：`hub-reactions-add`、`hub-reactions-remove`、`hub-messages-before`、`hub-update-settings`、`hub-set-admin-bot`、`hub-dissolve-bot`（由主持 Bot 发起解散时用）。

**对应需求** R14a、R15、R18、R20、R27、R28、R33、R34。

**依赖** Task 2、Task 12。

**验证** ds-bot 单测：`message.created` 事件确实到达 `rt.onWorkgroupMessage`；发布 body 含 `isChief`。

---

## Task 14：客户端 Hub adapter

**Files**
- Modify: `application/integrations/workgroup/client/index.mjs`（`openRoom` 字段、`messagesBefore`、反应、`reduceWorkgroup` 新事件）
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`（新 invoke 包装）
- Test: `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`（追加结构断言）

**当前行为**
`openRoom` 取 200 条 + tasks；reducer 只处理 messages/presence/member/renamed/notice/bot/dissolved/invitation/task。

**修改内容**
- `openRoom` 保留 `room.replyMode`/`effectiveReplyMode`/`adminBot*`/`workDir`/`permission`；`bots[].isChief` 透传。
- 新增 `messagesBefore(roomId, beforeSeq, limit)`。
- 新增 `addReaction` / `removeReaction`。
- `reduceWorkgroup` 增加 `message.reaction_changed`（覆盖该消息 `reactions`）、`room.settings_changed`、`room.admin_bot_changed`（置 `roomStale`）。

**对应需求** R27、R28、R33、R34、R19。

**依赖** Task 8–11（服务端路由存在）。

**验证** a22 断言：`effectiveReplyMode` 透传；反应事件后消息 `reactions` 更新。

---

## Task 15：UI thread（反应、更早消息、Admin 标记）

**Files**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
- Modify: `application/packages/bundle/ds-bot/src/client/i18n.js`
- Test: `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`（追加）

**当前行为**
`MessageLine` 渲染气泡与引用，无反应、无更早消息、无 Admin 标记。

**修改内容**
- 气泡下渲染 `message.reactions`（`bt-reacts` / `bt-react`，复用原群聊类名）；点击自己加的反应可删，他人的不可删（无按钮或 disabled）。
- 消息动作里增加「添加反应」入口，emoji 白名单同服务端。
- `WorkgroupThread` 顶部增加「加载更早消息」按钮（`bt-soft`），持 `beforeSeq` 游标，**前插去重**（按 `roomSeq`），失败保留已有内容并给重试。
- Bot 行在 `room.adminBotId === message.senderBotId` 时显示 `Admin` 标记。

**对应需求** R27、R28、R16、R3。

**依赖** Task 14。

**验证** a22：反应按钮存在且只对自己可删；更早消息按钮在前插后消失/更新；主持 Bot 行有 `Admin`。

---

## Task 16：UI composer（听写、`@all`）

**Files**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-ui/composer.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-mentions.js`
- Modify: `application/packages/bundle/ds-bot/src/client/i18n.js`
- Test: `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`（追加）

**当前行为**
composer 无听写按钮；mention 候选只有真人与 Bot。

**修改内容**
- 复制 `composer.js` 的 `useDictation` 到工作群 composer（**不 import 原文件**，保持原群聊零改动）；按钮类名 `bt-mic`，文案经 `t()`。
- `mentionCandidates` 增加 `@all` 候选（`kind: 'all'`），**仅当查看者是 owner/admin 或主持所有者**时出现；`composeMessage` 输出 `{ all: true }`。

**对应需求** R27、R26。

**依赖** Task 8、Task 14。

**验证** a22：听写按钮存在；普通成员看不到 `@all`；管理员看到且发送后 mentions 含 `{all:true}`。

---

## Task 17：UI settings 三卡

**Files**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-ui/settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/i18n.js`
- Test: `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`（追加）

**当前行为**
设置页只有 Profile / Task collaboration / Members / Sidebar / Manage。

**修改内容**
按原群聊顺序补三张卡：
- `Who answers`：`Segmented`（`Admin leads` / `Everyone`），无主持时 `admin` 选项 disabled 并提示；说明文案写明「群权限会覆盖成员 Bot 自己的预设」。
- `Working folder`：`FolderMenu`，改 `workDir`。
- `Permissions`：`GroupPermission` 同款（仅群主可见/可改）。
成员区混排：真人（角色下拉）、管家 Bot（`Admin` 标记 + 不可移除提示）、普通 Bot（可移除）。

**对应需求** R31、R16、R33、R34。

**依赖** Task 6、Task 14。

**验证** a22：三张卡存在；非群主看不到 Permissions；改 `replyMode` 调用到 `onRoomAction`。

---

## Task 18：侧栏 7 项菜单

**Files**
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js:500-523`（`WorkgroupMenu`）
- Modify: `application/packages/bundle/ds-bot/src/client/index.js`（动作实现）
- Modify: `application/packages/bundle/ds-bot/src/client/i18n.js`
- Test: `application/integrations/workgroup/tests/a21-workgroup-sidebar.spec.ts`（追加）

**当前行为**
菜单只有「置顶 / 从列表隐藏」两项。

**修改内容**
补至 7 项，与原群聊房间菜单对齐（顺序与分组一致）：置顶/取消置顶、标为未读、群设置、重命名群聊、复制对话 ID、从侧栏隐藏、**解散工作群聊**（危险项，仅 owner 或主持所有者可见）。
- 群设置 → `actions.openSettings('groups', roomId)`（Task 19 让它支持工作群）。
- 重命名 → 与原群聊一致进入改名态。
- 复制对话 ID → 复制 `roomId`。
- 解散 → 二次确认，调 `workgroups.dissolve`。

**对应需求** R30、R31。

**依赖** Task 13（`hub-dissolve-bot`）、Task 19。

**验证** a21：7 项齐全；非 owner 看不到解散；点击群设置调用 `openSettings('groups', id)`。

---

## Task 19：设置页接入工作群 + 未读双机制

**Files**
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js`（`groups` 页支持工作群）
- Modify: `application/packages/bundle/ds-bot/src/client/overlays.js`（传入工作群房间）
- Modify: `application/packages/bundle/ds-bot/src/client/index.js`（`markUnread` 支持工作群；打开会话时 `markRead`）
- Test: `application/integrations/workgroup/tests/a21-workgroup-sidebar.spec.ts`（追加）

**当前行为**
`SettingsDialog` 的 `groups` 页只认 `roster.roomsById[id]`（本地群）；工作群只能从详情抽屉进设置。`markUnread` 只对本地会话生效。

**修改内容**
- `SettingsDialog` 在 `page === 'groups'` 且 `id` 是工作群时渲染 `WorkgroupSettings`（复用 Task 17 的组件），数据来自 `workgroupRoster`。
- `GroupsPage` 的列表追加工作群行（带 `Workgroup` 徽标与主持名）。
- `markUnread(roomId)` 对工作群写本机 `marked` 标记；徽标 = `max(hubUnread, marked ? 1 : 0)`；打开会话时清本地标记并 `markRead`。

**对应需求** R31、R32。

**依赖** Task 17、Task 18。

**验证** a21：从侧栏菜单进群设置落在全局设置页；标为未读后徽标出现，打开后消失；Hub 计数独立变化。

---

## Task 20：契约同步 + i18n + 产物

**Files**
- Modify: `server/contracts/openapi.yaml`（`POST /rooms`、`PATCH /rooms/{id}`、`GET /rooms/{id}/messages`、`POST /api/v1/bots`、两条反应路由、`POST /tasks/{id}/share`）
- Modify: `server/contracts/events.schema.json`（三个新事件）
- Modify: `application/packages/bundle/ds-bot/src/client/i18n.js`
- Regenerate: `application/packages/bundle/ds-bot/client.js`

**对应需求** 全部（契约一致性）。

**依赖** Task 1–19。

**验证** `node scripts/build-client.mjs --check` 退出 0；`node --test "tests/d-contract-parity.test.js"` 通过。

---

## Task 21：验证

见文末「## 验证命令」。任何一步非零退出码都必须修复后重跑。

---

## Plan 偏差预案（执行前已知）

1. **`server/src/admin/store.js` 的 `createRoom` 调用**：Hub 管理端建群没有 `adminBotId`。处理：`createRoom` 的 ≥2 Bot 与管家校验**只作用于 `kind === 'workgroup'`**；管理端建群保持原行为（管理端不建 Bot 成员），并在 `d-dissolve.test.js` 与 `adm-workgroups.test.js` 上回归确认。
2. **`groupOwners` 复用 vs 新表**：若把工作群 sessionId 塞进 `groupOwners` 会污染 `state.rooms` 相关逻辑（`groupSessionsOf`、`roomOf`），改用 `rt.groupOwners` 之外的一张新 Map `workgroupOwners`，并让 `approvals.js` 同时查两张表。这是**小偏差**，不改设计结论。
3. **反应 emoji 白名单**：设计只说「白名单」，具体集合在 Task 10 定；若与原群聊 `bt-react-strip` 的集合不同，以原群聊为准并记录。
