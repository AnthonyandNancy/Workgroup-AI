# 工作群复刻原版群聊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作群以复制后的原群聊 UI 呈现，并补齐公告、Bot 成员、Bot 邀请、任务活动、统一解散和原群聊回归能力。

**Architecture:** 先落地 Hub 数据/权限/API，再补 Host Bot 发布与 Bridge，再建立工作群客户端读模型；随后复制原群聊 UI 并接入 `wg:<roomId>` overlay，最后清理原群聊历史 workgroup 分支并做回归。

**Tech Stack:** Node.js 24、Fastify 5、SQLite/WAL、React 18 `h`、DSH/Cordis、Vitest、Node test runner。

## Global Constraints

- Requirement 是唯一业务事实来源：`docs/requirements/workgroup-parity-requirement.md`。
- 技术设计是唯一架构来源：`docs/design/workgroup-parity-technical-design.md`。
- 原群聊本地行为、数据、样式和测试不得改变；清理任务只迁移 workgroup 分支。
- 工作群 UI 必须来自原群聊代码复制件；不得继续在工作群中使用自有主界面作为最终形态。
- 三个工作群入口已存在，不新增第四个入口；只替换创建行为。
- Hub 是房间、成员、Bot 成员、公告、任务、审批和记忆的唯一事实源。
- 不泄露模型、Session、工作目录、工具 scope 或其他私人执行字段。
- 每个行为变更先写失败测试，再写最小实现；提交前运行对应命令。

## Execution State

| 任务 | 状态 | 备注 |
|---|---|---|
| Task 1 DB 迁移 | DONE | 0014 migration 已应用；迁移测试通过；新增 h16 覆盖公告/Bot 成员 |
| Task 2 房间域与公告 | DONE | notice/update、rename、邀请、接受、角色、移除、离开、Bot 写入口均有 dissolved guard；消息/任务域同样拒绝已解散房间 |
| Task 3 房间 Bot 成员/邀请域 | DONE | 直接加入、邀请、接受、移除、列表已实现 |
| Task 4 API/事件/契约 | DONE | notice/bot/invite/task-events/bot-candidates API、房间列表 summary、OpenAPI、admin 解散取消任务 |
| Task 5 消息/任务联动与任务活动 | DONE | 房间 Bot 校验、Bot/成员移除取消任务、房间任务事件已实现并测试 |
| Task 6 Host Bot 发布与 Bridge | DONE | 登录/恢复发布、改名/删除同步、60s 心跳、withdraw、bot-candidates；a20 10/10 |
| Task 7 客户端工作群读模型/reducer | DONE | openRoom 显式 room bots；reducer 公告/Bot/邀请/解散；新增 workgroup-roster 读模型与本地偏好 |
| Task 8 客户端 roster/侧栏/邀请 | DONE | 复制侧栏 WorkgroupTeamSidebar：本地实体 + 工作群行 + 真人/Bot 邀请 + pin/hide + Hub 状态 |
| Task 9 复制原群聊会话/设置/详情/创建 UI | DONE | workgroup-ui/ 复制消息、composer、设置、详情、任务活动、群记忆与创建表单；接入 `wg:` overlay |
| Task 10 入口/overlay/注册接线 | DONE | 三入口统一打开复制创建表单；通用 extraOptions/extraCommands/extraGroups；创建后进入并刷新 roster |
| Task 11 原群聊清理 | DONE | 原群聊文件移除 workgroup 分支；旧 WorkgroupSettings 备份到 backups/ 并停止引用；复制件独立演进 |
| Task 12 回归与验收 | PARTIAL | 定向回归、构建、lint 已通过；真实双客户端 Hub、离线重连、原群聊真实 UI 回归与固定窗口/主题/语言/缩放截图对照尚未执行（本会话无运行中的 Hub/Host 桌面环境） |

## Plan 偏差

执行中发现以下事实需要记录，均未改变 Requirement 的业务规则：

1. **composer 与消息 cell 的复制来源是 shell 组件。** 原群聊的输入区是 `@deepseek-ai/dsh-client-ui-conversation` 的 `InputBar`，消息 cell 是 ds-bot 注册进 shell conversation 的组件。工作群用 `shell.overlay` 挂载，无法直接复用该 conversation 工厂（技术设计决策 3 已拒绝第二条事实源）。复制件因此在 `workgroup-ui/` 中复刻其 DOM 结构、class 与设计 token，并复用 `bt-group-msg`/`bt-umsg`/`bt-bubble` 等原群聊样式，而不是 import shell 内部组件。像素对照时，shell 自有的 chrome 以同一渲染环境为基线。
2. **引用会话在工作群中禁用并给出原因。** 原群聊的“引用会话”把本机 Session 引用插入 prompt；工作群消息发往 Hub，跨用户 Bot 无法读取本机会话，复制该行为会把私人会话内容复制到共享房间。菜单项保留位置但禁用，并说明原因（R3/R14 的工作群适配）。
3. **定时任务由 Host 调度，只发送普通消息。** 队列持久化在 Host 的 `workgroup-schedules.json`，窗口关闭或重启后仍按期发送；@ Bot 仍由 Hub 生成待审批任务，不直接执行；发送失败保留条目、记录原因并稍后重试。客户端不再持有定时器。
4. **Bot 可见性由所有者决定，默认 private。** 工作群设置里自己的 Bot 有“成员可见”开关，打开后以 `room` 可见性重新发布，其他成员才能发现并邀请；默认仍是 private，非所有者不能改变该设置。
5. **创建房间与所选 Bot 单事务。** `POST /rooms` 接受 `botIds`（创建者自己的已发布 Bot），房间、owner 成员关系与这些 Bot 同事务写入；任一 Bot 未发布则整个创建被拒绝，不留半个工作群。真人邀请仍是创建后的 pending 邀请。

## Execution Log

- Task 1：新增 `server/db/migrations/0014_workgroup_parity.sql`；`node --test tests/h02-database.test.js` 的迁移相关用例通过，但整个文件因既有长测试超时退出；新增 `tests/h16-workgroup-parity.test.js` 验证 notice/Bot 成员链路。
- Task 2/3/4/5 的服务端切片：
  - `tests/h16-workgroup-parity.test.js`：5/5 通过，覆盖公告、Bot 成员/邀请、@ 校验、Bot 移除取消任务、任务事件。
  - `tests/h08-tasks.test.js`：29/29 通过；测试 fixture 已改为 `kind=workgroup` 并显式添加房间 Bot。
  - `tests/h04-rooms.test.js`、`tests/h05-messages.test.js`、`tests/h07-bot-directory.test.js`：65/65 通过。
  - `tests/h08-tasks.test.js tests/h16-workgroup-parity.test.js` 合并运行：34/34 通过。
- 偏差：现有 H-08 fixture 原本使用普通 room + 目录可见性；按新规则改为 workgroup + 显式 room_bot，属于需求驱动的测试基线变更。
- Task 6/7 切片：Host 新增 `syncLocalBots` 与 Bridge endpoint；`openRoom` 改用显式 room bots；reducer 处理 `room.notice_changed`、`room.bot_added/removed`、`bot_invitation.created`、`room.dissolved`。
- 验证：`npx vitest run integrations/workgroup/tests/a15-workgroup-realtime.spec.ts` 4/4 通过；a15 的 openRoom 测试已改为显式 room bots。
- 追加：成员移除/离开会移除其 Bot 并取消任务；管理端解散会取消未完成任务；客户端设置页已接入公告、房间 Bot 列表、添加/移除自己的 Bot。
- 验证：`node --test tests/h16-workgroup-parity.test.js tests/h08-tasks.test.js` 35/35 通过；`npx vitest run integrations/workgroup/tests/a15-workgroup-realtime.spec.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/bot-entry.spec.ts` 41/41 通过。
- Task 2 补齐：确认 updateRoom/rename/invite/accept/role/remove/leave 均有 dissolved guard；消息与任务域同样拒绝已解散房间。
- Task 4 完成：`GET /rooms` 扁平 summary（memberCount/botCount/lastMessageAt/lastMessagePreview/lastMessageSeq/pendingApprovalCount）、`GET /rooms/:id/bot-candidates`、OpenAPI 32 paths；服务端 66/66。
- Task 6 完成：Host 登录/恢复发布本地 Bot（仅 botId/displayName/visibility），心跳 60s（state=online），rt.save 去抖同步改名/删除（withdraw），登出/销毁清理；a20 10/10、a13 14/14。
- Task 6 追加：`/api/bot` 显式 switch 补齐 hub-rename-room/update-notice/add-bot/remove-bot/bot-invitations/invite-bot/respond-bot-invitation/bot-candidates/task-events/download-artifact/memory-search/create/revise/delete；新增 a23 端点奇偶校验 4/4。
- Task 7/8：新增 `workgroup-roster.js`（列表、邀请、pin/hide/unread、轮询与归一化）与复制侧栏 `workgroup-sidebar.js`；a19 10/10、a21 14/14。
- Task 9：新增 `workgroup-ui/`（model、thread、composer、activity、settings、details、create、styles、index），消息区/任务活动/composer/设置/详情/群记忆/创建表单接入 `WorkgroupView`；替换旧自有 WorkgroupSettings（已备份到 backups/task11-old-workgroup-view/）。
- Task 10：三入口改为通用扩展注入（NewChat extraOptions / CommandPalette extraCommands / GroupsPage extraGroups），统一打开复制创建表单，创建后进入 `wg:` 并刷新 roster；a04 6/6、bot-entry 17/17。
- Task 11：原群聊 `new-chat.js`/`palette.js`/`settings.js`/`group-settings.js`/`sidebar.js` 已无 workgroup 分支；复制侧栏接管 `sidebar.workspaces`。
- 客户端回归：a02 6、a04 6、a15 5、a16 20、a19 10、a20 12、a21 14、a22 18、a23 4、a24 4、bot-entry 17 = 116/116 通过；服务端 103/103。
- 代码缺口收尾：
  - 可见性：Host `hub-set-bot-visibility`（仅 private/room）、`/api/bot` 白名单、client 适配、工作群设置里所有者专用“成员可见”开关；a20 覆盖共享后改名仍保持 room，a22 覆盖开关与非所有者不可见。
  - 离线删除：登录/恢复时读取所有者目录并与本地 Bot 对账，撤回已删除条目、记住既有可见性；a20 覆盖 stale withdraw 与改名保留 room。
  - 事件：`bot_invitation.changed` 在接受/拒绝/撤销后发布，进入 events 白名单与 JSON Schema，reducer 标记两个邀请列表 stale；h16 覆盖拒绝的公开形状与二次解析 409，a15 覆盖幂等。
  - 定时消息：Host 持久化队列 + 到期发送 + 取消 + 失败重试（`SCHEDULE_RETRY_MS`），endpoint 走 `/api/bot` 白名单；a24 4/4 覆盖发送、取消、失败重试、重启保留。
  - 创建：`createRoom` 校验并写入 `botIds` 同事务，路由返回 room+bots，Host 转发，创建表单改为一次调用；h16 覆盖原子性与未发布 Bot 404 不留房，a22 覆盖请求形状。
  - 引用会话：按 R17 保持禁用并说明原因（本机 Session 不能被跨用户 Bot 读取），登记为需求驱动适配而非缺口。
- Host 回归：新增 a20 10/10；a17（真实 `/api/bot` Loader composition）3/3。a13 曾因 Windows 下每个用例一个临时根、清理约 160s 而触顶 hook 预算（断言 14/14、文件级 exit 1）。改为**整文件一个临时根、用例使用唯一子目录**（`wg-a13-*`，符合 recycle 的安全前缀），清理降为一次；复验 exit 0（14/14，约 34s），不再随用例数增长。

---

### Task 1: Hub 数据迁移

**修改位置**
- Create: `server/db/migrations/0014_workgroup_parity.sql`
- Modify: `server/tests/migrations.test.js` 或现有 migration 测试
- Modify: `server/src/modules/rooms/store.js` 的 public shape（后续任务消费）

**当前行为**
- `rooms` 只有基础字段；没有公告。
- `room_members` 只记录真人；没有 Bot 房间成员或 Bot 邀请。

**修改内容**
- `rooms` 增加 `notice TEXT NOT NULL DEFAULT ''`。
- 新建 `room_bots`：`room_id`、`owner_user_id`、`bot_id`、`display_name`、`added_by_user_id`、`added_at`、`removed_at`，唯一键 `(room_id, owner_user_id, bot_id)`。
- 新建 `room_bot_invitations`：`id`、`room_id`、`owner_user_id`、`bot_id`、`invited_by_user_id`、`status`、`expires_at`、`created_at`、`resolved_at`；pending 唯一。
- 为房间 Bot 查询增加索引。
- `room_bots` 迁移回填：按当前 `openRoom` 可见口径，把工作群活跃成员拥有的 `public`/`room` 目录 Bot 作为 active；回填历史任务中仍引用且所有者在房间的 Bot。
- 不删除任何现有行。

**对应需求**
- R2、R8、R9、R22、R24；技术设计“数据/迁移”。

**依赖**
- 无；后续任务依赖本迁移。

**验证方式**
- 迁移测试：新库迁移成功；旧数据迁移后 notice 为空、既有 room/message/task/memory 行数不变。
- 回填测试：工作群当前可见 Bot 升级后仍在；非工作群不被回填。
- 运行：`cd server && node --test tests/migrations.test.js`（按实际测试文件调整）。

---

### Task 2: 房间域、公告与 live guard

**修改位置**
- Modify: `server/src/modules/rooms/store.js`
- Modify: `server/src/api/rooms.js`
- Modify: `server/tests/rooms*.test.js`

**当前行为**
- `renameRoom` 只改名；没有公告更新。
- 改名、邀请、接受邀请、角色、移除成员等写路径没有统一 dissolved guard。
- `publicRoom` 不返回 notice。

**修改内容**
- 增加 `requireLiveRoom(db, roomId)`，统一抛 `ROOM_DISSOLVED`。
- 增加 `updateRoomSettings(db, { roomId, name?, notice?, actor... })`：owner/admin、live、名称/公告长度校验、事务、审计。
- `publicRoom` 增加 `notice`（始终字符串）。
- `PATCH /rooms/:id` 接受 `name` 和/或 `notice`，发布 `room.renamed` / `room.notice_changed`。
- 所有房间写接口先走 live guard：改名/公告、邀请、接受、角色、移除、离开、Bot 操作、消息、任务。
- 保留现有非成员 404、权限 403、重复解散 409 语义。

**对应需求**
- R4、R5、R6、R7、R10、R11、R15、R21、R22；技术设计“决策 6/7”。

**依赖**
- Task 1。

**验证方式**
- 单测：notice 保存/清空/超长；admin 可改、member 403；dissolved 下所有写入口 409。
- API 测试：`PATCH` 返回 notice；非成员 404。
- 运行：`cd server && node --test tests/rooms*.test.js`。

---

### Task 3: 房间 Bot 成员与 Bot 邀请域

**修改位置**
- Create: `server/src/modules/rooms/bots.js` 或同模块新 section
- Modify: `server/src/modules/rooms/store.js`
- Modify: `server/src/api/rooms.js`
- Modify: `server/src/api/bots.js`（只做目录联动）
- Modify: `server/tests/rooms*.test.js`、新增 `server/tests/room-bots.test.js`

**当前行为**
- Bot 不是房间成员；`openRoom` 从目录自动汇总。
- 没有 Bot 邀请、所有者接受、移除 Bot。

**修改内容**
- `addOwnBot`：校验 Bot 属于调用者、Bot 目录存在、所有者是房间成员、房间 live；插入/恢复 `room_bots`；幂等返回 active。
- `inviteBot`：owner/admin 发起，校验 Bot 对调用者可见、Bot 所有者是房间成员、无 active/pending；创建 pending 邀请。
- `acceptBotInvitation`：仅 Bot 所有者；校验 live、所有者仍为成员、Bot 目录存在；插入/恢复 `room_bots`；邀请 accepted。
- `decline/revoke/expire`：状态转换，不建立房间关系。
- `removeRoomBot`：Bot 所有者或房间 owner/admin；标记 `removed_at`；触发任务取消/授权撤销（Task 5 完成具体联动）。
- 增加统一谓词 `isBotInRoom(db, { roomId, ownerUserId, botId })`；所有 @/任务校验使用它。
- 迁移回填在 Task 1。

**对应需求**
- R8、R9、R24；技术设计“决策 5”。

**依赖**
- Task 1、Task 2。

**验证方式**
- 单测：自己 Bot 直接加入；他人 Bot pending → owner accept；非 owner 不能接受；重复添加幂等；移除后不再 active；dissolved 下拒绝。
- 运行：`cd server && node --test tests/room-bots.test.js`。

---

### Task 4: API、事件与契约

**修改位置**
- Modify: `server/contracts/openapi.yaml`
- Modify: `server/contracts/events.schema.json`
- Modify: `server/src/realtime/events.js`
- Modify: `server/src/api/index.js`（如需注册）
- Modify: `server/src/api/admin.js`、`server/src/admin/store.js`
- Modify: `server/src/api/rooms.js`、`server/src/api/messages.js`、`server/src/api/tasks.js`
- Modify: 对应 server tests

**当前行为**
- 没有公告/Bot 成员/Bot 邀请/任务活动 API 和事件。
- Hub 管理端解散没有取消未完成任务。

**修改内容**
- `GET /rooms` 增加 summary：`memberCount`、`botCount`、`lastMessageAt`、`lastMessagePreview`、owner-scoped `pendingApprovalCount`。
- `GET /rooms/:id` 返回 `notice`、`bots`、`myRole`、`dissolvedAt`。
- 新 API：`POST /rooms/:id/bots`、`GET /rooms/:id/bot-candidates`、`POST /rooms/:id/bot-invitations`、`GET /bot-invitations`、`POST /bot-invitations/:id/accept|decline|revoke`、`DELETE /rooms/:id/bots/:ownerUserId/:botId`、`GET /rooms/:id/task-events`。
- 事件：`room.notice_changed`、`room.bot_added`、`room.bot_removed`、`bot_invitation.created`、`bot_invitation.changed`；更新 events enum 和 contract。
- `POST /rooms/:id/dissolve` 与 `DELETE /admin/workgroups/:id` 调用同一个 dissolve domain service；管理端也取消未完成任务、撤销邀请、广播 `room.dissolved`。
- 统一错误映射：`ROOM_DISSOLVED` 409、Bot 未发布/不可见 404、Bot 已在房间 409、邀请非 pending 409。
- 任务事件只返回 `publicTaskEvent`，按成员权限过滤。

**对应需求**
- R2、R5、R8、R10、R11、R21、R22；技术设计 API/事件。

**依赖**
- Task 2、Task 3。

**验证方式**
- contract/schema 校验；新 API 的权限/幂等/404/409 测试。
- 管理端解散取消任务；群主解散结果一致。
- 运行 server 相关测试。

---

### Task 5: 消息/任务联动与任务活动

**修改位置**
- Modify: `server/src/modules/messages/store.js`
- Modify: `server/src/modules/tasks/store.js`
- Modify: `server/src/api/messages.js`
- Modify: `server/src/api/tasks.js`
- Modify: `server/tests/messages*.test.js`、`server/tests/tasks*.test.js`

**当前行为**
- @ Bot 由目录可见性校验；任务目标不要求房间 Bot 成员。
- Bot 移除/成员移除/解散与任务取消没有统一联动。
- 没有房间级任务事件读取。

**修改内容**
- `assertMentions` 在消息发送前校验 bot 在 `room_bots` 且所有者是活跃成员；不可见/非成员统一拒绝。
- `createTask` 的目标 Bot 校验改为 `isBotInRoom`；执行 Bot 仍按 owner 的目录选择。
- `removeRoomBot`、`removeMember`、`leaveRoom`、`dissolve` 统一取消非终态任务并撤销 grants；事件后置。
- `proposeTasksForMentions` 只对房间 Bot 创建任务。
- `GET /rooms/:id/task-events` 用 join tasks 过滤 room，返回脱敏事件、时间、taskId；限制成员和分页。
- 任务活动不写入 messages，不占 roomSeq。

**对应需求**
- R9、R12、R13、R17、R19、R20、R22；技术设计“任务活动”。

**依赖**
- Task 3、Task 4。

**验证方式**
- 两个客户端 + 真实 Hub：@ 房间 Bot 生成 pending；非房间 Bot 拒绝；移除 Bot 后旧任务取消；任务事件不泄露 scope。
- 运行：`cd server && node --test tests/messages*.test.js tests/tasks*.test.js`。

---

### Task 6: Host Bot 发布与 Bridge

**修改位置**
- Modify: `application/packages/bundle/ds-bot/src/host/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/host/index.js` 或 Bot 生命周期所在模块
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/integrations/workgroup/protocol/hub-client.mjs`（如需新 endpoint 类型）
- Test: `application/integrations/workgroup/tests/*host*.spec.ts`

**当前行为**
- 产品 Host 没有把本地 Bot 发布到 Hub directory；只有测试直接 `POST /bots`。
- Host bridge 没有公告/Bot 成员/Bot 邀请/任务活动 endpoint。

**修改内容**
- Host 登录/恢复后发布本地 Bot 目录：`POST /bots`、心跳、改名/删除同步/withdraw；只发送 `botId`、显示名、目录可见性、状态等安全字段。
- 新增 bridge endpoint：notice、add/remove bot、bot candidates、bot invitations、task events。
- 浏览器 `createWorkgroupHub` 增加对应方法；不把 Hub token 传到浏览器。
- 连接/目录同步失败可见，不阻塞本地群。

**对应需求**
- R8、R17；技术设计“决策 11”。

**依赖**
- Task 3、Task 4。

**验证方式**
- 真实 Host：登录后目录出现本地 Bot；改名/删除同步；心跳过期离线；无私有字段。
- 运行：`cd application && npx vitest run integrations/workgroup/tests/` 中 Host 相关文件。

---

### Task 7: 客户端工作群读模型与 reducer

**修改位置**
- Modify: `application/integrations/workgroup/client/index.mjs`
- Create: `application/packages/bundle/ds-bot/src/client/workgroup-state.js`（or copied data adapter）
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-hub.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- Test: `application/integrations/workgroup/tests/a05-workgroup.spec.ts`、新增 state tests

**当前行为**
- 状态只有 room/members/messages/tasks/head/loading；没有 notice、bots、bot invitations、dissolvedAt、task activity。
- reducer 不处理 room.dissolved、notice、bot 事件。

**修改内容**
- `openRoom` 返回 `room.notice`、`bots`、`botInvitations`（如适用）、`dissolvedAt`。
- reducer 处理：
  - `room.notice_changed` → room.notice；
  - `room.bot_added`/`room.bot_removed` → bots 标记 stale 或增量更新；
  - `bot_invitation.created`/changed；
  - `room.dissolved`；
  - `task.*` 归类为 activity。
- 工作群 roster source：`rooms` 列表、入站邀请、本地 pin/hide/unread。
- 不复用本地 `roster.rooms`；工作群状态独立。

**对应需求**
- R2、R5、R8、R12、R22、R23；技术设计“客户端数据”。

**依赖**
- Task 4、Task 6。

**验证方式**
- reducer 纯函数测试：重复事件幂等、未知事件忽略、dissolve 只读、notice/bot 更新。
- openRoom 真实 Hub 测试。

---

### Task 8: 客户端 roster、侧栏与邀请

**修改位置**
- Create: `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js`（复制 TeamSidebar/RoomRow 的工作群版本）
- Modify: `application/packages/bundle/ds-bot/src/client/index.js` 的注册
- Modify: `application/packages/bundle/ds-bot/src/client/sidebar.js` 仅清理历史 workgroup 例外（Task 11）
- Test: `application/integrations/workgroup/tests/a15-workgroup-realtime.spec.ts`、新增 sidebar tests

**当前行为**
- 工作群没有侧栏列表/群行；邀请接口无 UI。

**修改内容**
- 复制 TeamSidebar 的群行视觉和排序行为，组合本地 Bot/Agent/本地群 + 工作群行。
- 工作群行显示名称、成员/Bot 数、最后活动、未读、审批提示、Hub 状态。
- 增加邀请区/徽标：真人邀请、Bot 邀请；接受/拒绝。
- pin/hide/unread 通过本地 UI store。
- `sidebar.workspaces` 仍单 owner；复制侧栏注册时保留本地实体行为。

**对应需求**
- R4、R5、R10、R24；技术设计“决策 4”。

**依赖**
- Task 7。

**验证方式**
- 本地群/Bot/Agent 回归；工作群行打开 `wg:`；邀请接受后出现房间；离线状态。
- UI 测试固定窗口/主题。

---

### Task 9: 复制原群聊会话、设置、详情、创建 UI

**修改位置**
- Create: `application/packages/bundle/ds-bot/src/client/workgroup-ui/`（复制/适配原群聊组件）
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`（改为渲染复制 UI）
- Delete: 当前 `workgroup.js` 工作群自有视图（Task 11 清理，或先保留到切换完成）
- Test: `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`、新增视觉测试

**当前行为**
- `WorkgroupView` 自有 thread/composer/members/settings。
- 没有公告、详情、任务活动、群记忆入口、图片、`+` 菜单。

**修改内容**
- 复制原群聊消息区、composer、群设置、群详情、成员行、创建表单为独立工作群组件。
- 数据适配器把 `WorkgroupRoomView` 映射给复制件；不向本地 roster 注入工作群。
- 设置：名称/公告、成员/Bot、invite、pin/hide、dissolve；替代原群级权限/目录为任务协作说明。
- 详情：公告、成员/Bot、工作状态、任务活动、用量/任务统计、群记忆。
- composer：文本、`+`（文件/引用/定时任务）、@、附件/图片、发送失败草稿。
- 任务活动卡：用复制原群聊 Bot/卡片视觉；审批操作仍在 owner 区域。
- 复制 UI 新增工作群专属元素只用同设计 token。

**对应需求**
- R4、R5、R6、R7、R12、R15、R16、R17、R18；技术设计“决策 1/2/9”。

**依赖**
- Task 7、Task 8。

**验证方式**
- 复制原群聊固定窗口/主题/语言/缩放截图对照；
- 消息、+ 菜单、图片、公告、设置、详情、群记忆、任务活动交互；
- 真实 Hub 两客户端。

---

### Task 10: 入口、overlay 与注册接线

**修改位置**
- Modify: `application/packages/bundle/ds-bot/src/client/index.js`
- Modify: `application/packages/bundle/ds-bot/src/client/new-chat.js`
- Modify: `application/packages/bundle/ds-bot/src/client/settings.js`
- Modify: `application/packages/bundle/ds-bot/src/client/palette.js`
- Modify: `application/packages/bundle/ds-bot/src/client/workgroup-entry.js`
- Test: `application/integrations/workgroup/tests/bot-entry.spec.ts`

**当前行为**
- 三个入口都已存在并进入工作群内容；`workgroups.create` 立即自动命名、创建、打开。

**修改内容**
- 三入口统一打开复制原群聊的创建工作群表单；表单提交后创建 Hub room，再进入 `wg:` Session。
- 保留入口位置和 Hub 未配置错误。
- 工作群 overlay 挂载复制 UI；原群聊 conversation 不变。
- 删除/替换当前工作群自定义入口动作中的自动命名逻辑；`newWorkgroupName` 只作为兜底，不作为用户可见默认。

**对应需求**
- R4、R5、R6、R24；技术设计“决策 3”。

**依赖**
- Task 9。

**验证方式**
- 三入口各进入创建表单；创建后显示工作群；Hub 未配置显示稳定错误；本地群入口不变。

---

### Task 11: 原群聊清理与隔离

**修改位置**
- Modify: `application/packages/bundle/ds-bot/src/client/group-settings.js`（移除 workgroup 分支）
- Modify: `application/packages/bundle/ds-bot/src/client/sidebar.js`（移除 workgroup session 例外）
- Modify: `application/packages/bundle/ds-bot/src/client/new-chat.js`、`settings.js`、`palette.js`（如入口集成迁出）
- Delete: 当前工作群自有 UI 文件（迁移完成后；删除前用回收站/备份，不永久删除）
- Test: 原群聊回归、工作群新 UI 回归

**当前行为**
- 原群聊相关文件已有 workgroup 分支，违反“原群聊代码基线”。

**修改内容**
- 把 workgroup 分支迁入工作群复制件/集成层；
- 原群聊文件恢复本地群语义；
- 工作群入口仍保留，但由工作群集成层提供；
- 旧工作群 `WorkgroupView`/`WorkgroupSettings` 等不再注册；先备份到 `backups/` 或保留未引用，最终移入回收站；
- 运行原群聊全量回归。

**对应需求**
- R1a、R25、AC-15、AC-18。

**依赖**
- Task 9、Task 10 已切换到新 UI。

**验证方式**
- `git diff` 检查原群聊行为文件没有新增 workgroup 分支；
- 原群聊 UI 15/15 或现有回归；
- 工作群新 UI 不依赖原群聊业务组件 import（允许基础原语）。

---

### Task 12: 回归与验收

**修改位置**
- No production file unless fixes
- Test/docs: `application/integrations/workgroup/tests/`、`server/tests/`、`docs/superpowers/plans/` 状态

**当前行为**
- 需求包含大量跨模块行为。

**修改内容**
- 逐项执行 Requirement AC-01..AC-18。
- 运行相关 unit/integration/typecheck/build；只运行项目实际存在且与改动相关的命令。
- 记录证据：服务端测试、Host/客户端真实 Hub 测试、原群聊回归、视觉截图、迁移测试。
- 修复发现的问题并重新验证。

**对应需求**
- 全部。

**依赖**
- Task 1-11。

**验证方式**
- 服务端：`cd server && node --test tests/*.test.js`
- 应用端：`cd application && npx vitest run integrations/workgroup/tests/`
- 定向编译：`npx tsc -b apps/desktop/tsconfig.host.json --pretty false` 或相关 package build
- 视觉：固定窗口/主题/语言/缩放截图
- 两客户端真实 Hub：创建、邀请、Bot 加入、@ 审批、任务活动、解散、离线恢复
- 原群聊：创建/聊天/@/设置/成员/附件/引用/群记忆/侧栏/删除归档回归

---

## Self-Review

- **Spec coverage:** 所有 Requirement 功能均落入 Task 1-12；UI 像素复刻在 Task 9/12；原群聊清理在 Task 11。
- **Placeholder scan:** 计划刻意保持任务级接口和验证命令；具体 UI 文件复制清单在 Task 9 执行时按真实源码逐个列明，避免复制路径漂移。
- **Type consistency:** 服务端统一 `room_bots` 与 `isBotInRoom`；客户端统一 `WorkgroupRoomView`；事件名称在 Task 4 与 Task 7 保持一致。
