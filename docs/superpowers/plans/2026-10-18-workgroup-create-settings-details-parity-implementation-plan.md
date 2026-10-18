# Implementation Plan

**Feature:** 工作群创建、群设置、群详情与原群聊一致性

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作群的创建面、会话外壳、群详情和群设置从“结构近似”修正为“按原群聊代码复制骨架并只做工作群语义适配”，同时修复创建后的邀请失败、详情设置入口失效、Hub 阻断原因错误、中文文案缺失等已定位问题。

**Architecture:** 不修改服务端、Host Bridge 或原群聊文件。所有改动限制在 `workgroup-ui/` 复制件、工作群 pane 装配、工作群状态文案和对应测试内。创建面复制 `new-chat.js` 的 group 模式骨架；设置/详情复用 shell 的 `bt-panel-view` 和原群聊 `bt-drawer-*` 类名；工作群专属的 Hub 状态、任务、Bot 成员、群记忆只加在复制件中。

**Tech Stack:** Node.js 24、React 18 `h()`、DSH/Cordis、Vitest + jsdom、Node test runner、Playwright（web 端 UI 验证）。

## Global Constraints

- Requirement 是唯一业务事实来源：`docs/requirements/workgroup-parity-requirement.md`。
- 技术设计是唯一架构来源：`docs/design/workgroup-parity-technical-design.md`。
- 原群聊代码、样式、行为和测试不得修改：`new-chat.js`、`details-drawer.js`、`group-settings.js`、`browser-pane.js`、`header.js`、`styles.js` 均视为只读。
- 工作群 UI 必须来自原群聊代码复制件；工作群专属逻辑只进入复制件。
- Hub 是房间、成员、Bot 成员、公告、任务、审批和记忆的唯一事实源。
- 不新增服务端路由、数据库字段、迁移或 OpenAPI 契约。
- 每个行为变更先写/改失败测试，再写最小实现；完成后运行本计划第 5 节的全部门禁。
- 所有用户可见文案必须经 `t()`，并在 `i18n.js` 的 `DICTIONARY.zh` 中有中文条目。
- `client.js` 是提交进仓库的浏览器构建产物，修改 `src/client` 后必须重新生成并提交。
- 允许使用 web 端进行 UI 测试；没有运行中的真实 Hub/Host 时，必须明确记录“视觉验收未执行”，不能宣称 AC-03/AC-04 全部通过。

---

## 1. Goal

### 本次修改目标

1. **创建工作群可用且与原群聊一致**
   - 三个入口打开同一个复制原群聊 `NewChat` 骨架的创建面。
   - 创建面从右侧 560px 卡片改为覆盖会话区的完整 `bt-pane`，使用 `bt-newchat`、`bt-to`、`bt-drop`、`bt-nc-compose`、`bt-nc-card` 等原群聊类名。
   - 支持名称必填、自己的 Bot 可选、真人按 user id 邀请、Esc 关闭、键盘选择 Bot。
   - Hub 阻断原因准确区分未配置、未登录、离线、重连中、被拒绝、Host 不可达。
   - 房间创建成功后即使邀请失败也进入工作群，并明确提示邀请失败；不因重试产生第二个房间。

2. **群设置与原群聊结构一致**
   - 设置改为右侧 `bt-wg-panel` 内的 `bt-subhead + bt-drawer-body bt-set-body`，不再整页替换对话。
   - 名称/公告改用原群聊同款 `Row + InlineText`（失焦/回车保存）。
   - Members 与 Bots 合并为一张 Members 卡；保留工作群专属的角色、Bot 所有权/可见性、邀请、解散语义。
   - 删除底部自定义 Close。

3. **群详情与原群聊结构一致**
   - 详情使用 `bt-panel-view + bt-drawer-top + bt-drawer-id + bt-drawer-body`。
   - 顶部提供齿轮（设置）和关闭；头像堆叠、名称内联改名、副标题与原群聊详情一致。
   - 正文按公告、成员、工作群状态、任务活动、群记忆、用量组织。
   - 修复详情里的“Group settings”按钮无效的问题。

4. **会话外壳与原群聊一致**
   - 标题从 56px 自定义 `bt-wg-head` 改为原群聊 `bt-head + bt-pill + bt-pill-go`。
   - 删除头部齿轮、错误的全量未读徽标、消息上方公告条；公告只在详情展示。
   - 设置入口改为“标题 pill → 详情 → 齿轮”，与原群聊一致。

5. **中文文案与门禁补齐**
   - 补齐 `workgroup-ui/` 下至少 53 个缺失中文条目及本次新增文案。
   - `test/i18n.test.js` 改为递归扫描 `src/client/**/*.js`。
   - 更新 a22/a16 的结构与交互断言，重新生成 `client.js`。

### 不包含

- 不修改服务端 `POST /api/v1/rooms`、`createRoom`、数据库迁移、OpenAPI、事件契约。
- 不修改 Host `hub-create-room`、`/api/bot` 白名单、`workgroup-hub.js` 的客户端适配。
- 不修改原群聊任何文件。
- 不重写消息线程、composer、任务卡业务逻辑；只改会话外壳、详情、设置和创建面。
- 不新增 Hub 真人目录、不新增 Bot 邀请 API、不实现 Hub 登录界面。
- 不为创建幂等新增服务端幂等键；HTTP 响应丢失导致的重复建房作为残余风险记录。
- 不声称 AC-04 的全部像素一致；本轮聚焦创建、会话外壳、详情、设置，消息时间分隔/composer 细项留待后续固定环境对照。

### 成功标准

- AC-03：三个入口打开原群聊骨架的创建面；名称可填；创建者成为 owner；自己的 Bot 可直接选择；真人邀请保持 pending；创建后打开工作群；不再只生成日期名称。
- AC-09：设置页结构、分组、控件和确认交互与原群聊一致，工作群专属设置有明确落点。
- AC-10：详情页结构与原群聊一致，公告、成员、任务活动、群记忆、用量有明确落点。
- AC-04（本范围内）：创建面、会话头、详情、设置的结构和类名与原群聊对齐；固定窗口/主题/语言/缩放下截图对照通过。
- 原群聊代码零修改；`git diff` 只包含本计划列出的工作群复制件、测试、i18n、bundle 和文档。
- 所有测试、构建、lint、i18n 门禁通过；web 端 UI 验证完成或明确记录环境阻塞。

---

## 2. Current Understanding

### 2.1 工作群基调（来自 Requirement / Design）

- 工作群采用“复制原群聊后独立演进”：复制原群聊的功能、页面结构、样式、交互和必要配套，形成独立实现。
- 原群聊代码、样式、行为和测试保持不变；工作群专属逻辑只能进入复制件（R1/R1a、AC-18）。
- Hub 是房间、成员、Bot 成员、公告、任务、审批和记忆的唯一事实源。
- 工作群以 `wg:<roomId>` DSH Session 打开，经 `shell.overlay` 挂载，不进入本地 `roster.rooms`。
- 三个入口继续使用，不新增第四个入口；三处统一打开复制原群聊的创建表单。

### 2.2 当前实现方式

- 工作群入口：
  - `NewChat` 的 `extraOptions`；
  - Bot 设置 `GroupsPage` 的 `extraGroups`；
  - `CommandPalette` 的 `extraCommands`。
  - 三者都调用 `workgroupActions.openWorkgroupCreate()`。
- `openWorkgroupCreate()` 执行 `actions.closeSettings?.(); actions.openNewChat('workgroup')`。
- `Overlays` 在 `ui.newChat === 'workgroup'` 时渲染 `WorkgroupCreate`。
- 创建提交：
  `WorkgroupCreate` → `workgroups.createRoom(name, { kind: 'workgroup', botIds })` → 浏览器 `call('hub-create-room')` → `src/host/channel.js` → Host `hub-create-room` → Hub `POST /api/v1/rooms` → 服务端 `createRoom()` 单事务写入 `rooms + room_members(owner) + room_bots`。
- 创建成功后：
  Host `startBridge()/bridge.watch()` → 返回 `created.room` → `onCreated(room)` → `enterWorkgroup()` 创建/打开 `wg:<roomId>` → `WorkgroupSurface` 调 `openRoom(roomId)`。
- 设置/详情数据：
  `WorkgroupPane` 读 `openRoom`、`taskEvents`、`workgroupSchedules`；设置写操作走 `onRoomAction` → Host Bridge → Hub。
- 状态维护：
  - `WorkgroupCreate` 局部维护 `name/picked/invites/target/busy/error`；
  - `WorkgroupConversation` 局部维护 `detailsOpen`；
  - `WorkgroupPane` 局部维护 `settingsOpen`；
  - `WorkgroupSettingsForm` 局部维护草稿；
  - `workgroupPrefs` 在 localStorage；
  - `workgroupHub` source 和 `workgroupRoster` 轮询列表是读模型；
  - Hub 是最终事实源。

### 2.3 涉及模块

| 层 | 模块 | 职责 |
|---|---|---|
| 创建 UI | `workgroup-ui/create.js` | 创建表单、Bot 目录读取、创建 + 邀请 |
| 创建接线 | `client/overlays.js` | 打开 `WorkgroupCreate`、传入 `workgroups`/`hub`/`onCreated` |
| 会话外壳 | `workgroup-ui/index.js` | 标题、消息/任务时间线、composer、详情/设置面板 |
| 详情 | `workgroup-ui/details.js` | 公告、成员、任务活动、群记忆、用量 |
| 设置 | `workgroup-ui/settings.js` | 名称/公告、成员、Bot、侧栏、解散/离开 |
| Pane 装配 | `client/workgroup-pane.js` | 读 Hub、执行动作、维护打开状态 |
| Hub 状态 | `client/workgroup-status.js` | `hubStatusOf` / `hubStatusCopy` |
| 侧栏 | `client/workgroup-sidebar.js` | 工作群行、邀请区、创建入口阻断文案 |
| 文案 | `client/i18n.js` | `DICTIONARY.zh` |
| 测试 | `a22`、`a16`、`test/i18n.test.js` | 工作群 UI、交互、中文 key 门禁 |
| 产物 | `application/packages/bundle/ds-bot/client.js` | 提交的浏览器 bundle |

### 2.4 数据流 / 调用链

```text
NewChat extraOptions / Settings extraGroups / CommandPalette extraCommands
  -> workgroupActions.openWorkgroupCreate()
  -> ui.newChat = 'workgroup'
  -> Overlays
  -> WorkgroupCreate
     -> workgroups.directory({ ownerUserId })       // 自己的已发布 Bot
     -> workgroups.createRoom(name, { kind, botIds })
        -> /api/bot hub-create-room
        -> Host hub-create-room
        -> Hub POST /api/v1/rooms
        -> createRoom(): rooms + owner + room_bots (single transaction)
     -> workgroups.invite(roomId, { targetUserId })
     -> onCreated(room)
        -> workgroups.openWorkgroup(roomId)
        -> enterWorkgroup(): create/open wg:<roomId>
        -> WorkgroupPane -> openRoom(roomId)
```

```text
WorkgroupPane
  -> openRoom / taskEvents / workgroupSchedules
  -> WorkgroupView (workgroup-ui/index.js)
     -> thread + composer + tasks
     -> panel (details | settings)
        -> WorkgroupDetails
        -> WorkgroupSettingsForm
           -> onRoomAction(operation, payload)
           -> Host Bridge -> Hub
```

### 2.5 已确认的影响范围

**直接修改（仅这些文件）**

- `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/details.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/settings.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
- `application/packages/bundle/ds-bot/src/client/overlays.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-status.js`
- `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js`
- `application/packages/bundle/ds-bot/src/client/i18n.js`
- `application/packages/bundle/ds-bot/test/i18n.test.js`
- `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
- `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`
- `application/packages/bundle/ds-bot/client.js`（构建产物）
- `docs/superpowers/plans/workgroup-parity-implementation.md`（执行记录）

**确认无需修改**

- `server/src/api/rooms.js`、`server/src/modules/rooms/store.js`：创建/公告/Bot 成员/邀请已实现，h16 覆盖。
- `server/db/migrations/`、`server/contracts/openapi.yaml`、`server/contracts/events.schema.json`：无新增契约。
- Host `workgroup-hub.js` 的 `hub-create-room`、`src/host/channel.js` 白名单。
- `client/workgroup-hub.js` 的 `createRoom/directory/invite`。
- `client/workgroup-entry.js`。
- `client/workgroup-roster.js`、`client/workgroup-sidebar.js` 的会话行数据逻辑（仅共享创建提示文案）。
- 原群聊 `new-chat.js`、`details-drawer.js`、`group-settings.js`、`browser-pane.js`、`header.js`、`styles.js`。
- `workgroup-ui/thread.js`、`composer.js`、`activity.js` 的消息/任务业务逻辑。

### 2.6 文档与代码不一致（必须记录，不自行改需求）

1. `docs/superpowers/plans/workgroup-parity-implementation.md` 的 Task 9 标记 DONE，称“复制消息、composer、设置、详情、任务活动、群记忆与创建表单”；实际：
   - `create.js` 是自定义居中卡片，不是原群聊 `NewChat` 骨架；
   - `settings.js` 使用自定义 `bt-bs-input + Save`，不是原群聊 `InlineText`；
   - `details.js` 缺少原群聊 `bt-drawer-top/bt-drawer-id`；
   - 详情→设置入口实际无效。
   本次需把 Task 9 的完成度修正为“结构近似，未达到 AC-03/04/09/10”。
2. 需求功能 2 写原群聊创建“选择管理员、成员，填写名称”；实际原群聊 **New Chat → Create group chat** 不填群名（未命名按成员命名），填写名称的是设置页 `NewGroupForm`。工作群必须有名称，因此复制 New Chat 骨架时要增加名称输入，这是需求驱动的最小差异，不是需求冲突。
3. `test/i18n.test.js` 只扫描 `src/client/*.js` 顶层，未扫描 `workgroup-ui/` 子目录；当前至少有 53 个 `t()` key 缺中文（创建、设置、详情、任务、群记忆、Hub 状态等）。
4. `application/tests/app-a03-ui-check.mjs` 只检查 bundle 中是否存在 `bt-wg-thread` 等字符串，不能证明“原群聊结构/视觉一致”；需要 a22 的 DOM 层级断言和固定环境截图补充。
5. `workgroup-ui/index.js` 详情里的 `onOpenSettings` 调用 `onCloseSettings?.('open')`，但 `WorkgroupPane` 传入的 `onCloseSettings` 忽略参数并执行 `setSettingsOpen(false)`，所以该按钮只关闭设置、不打开设置。

---

## 3. Implementation Steps

> 执行顺序固定。每步先改测试并确认失败，再改实现并确认通过；每步完成后更新第 4 节文件记录和第 7 节 Execution Log。

### Step 1: 重建创建工作群界面并修正创建失败语义

#### Target

- `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js`
  - `WorkgroupCreate`
  - `inviteIdsOf`
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
  - `WORKGROUP_UI_CSS` 中的 `.bt-wg-create*` 规则
- `application/packages/bundle/ds-bot/src/client/overlays.js`
  - `Overlays` 中 `WorkgroupCreate` 的 props
- `application/packages/bundle/ds-bot/src/client/workgroup-status.js`
  - 新增 `hubCreateHint(status, view)`
- `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js`
  - `WorkgroupSectionHead` 的 `createHint`

#### Current Behavior

- 根节点是 `bt-pane bt-wg-create-pane`，没有 `style.left = usePaneLeft()`；固定定位元素只有 `right:0`，宽度收缩为约 592px，表现为右侧卡片而非原群聊整块创建面。
- 内部使用 `bt-wg-create` 卡片、`bt-bs-input` 字段和 `bt-ng-chip` 选择器；原群聊创建面使用 `bt-newchat/bt-to/bt-drop/bt-option/bt-nc-compose/bt-nc-card/bt-nc-send`。
- 没有 `useEscape`，没有 ArrowUp/ArrowDown/Enter 选择 Bot，没有 `bt-x` 的 `×` 关闭按钮。
- `available` 只判断 `workgroups.available`；未配置、未登录、离线、重连中、被拒绝都显示“请管理员配置 Hub”。
- `create()` 先 `createRoom` 再逐条 `invite`；任一邀请失败会进入 catch，`onCreated` 不执行；房间已经创建，用户停留在表单，重试会创建第二个房间。
- Bot 目录请求没有按当前用户过滤；`identity.userId` 未就绪时可能把别人的可见 Bot 列进来，选中后创建会被 Hub 以 `NO_SUCH_BOT` 拒绝。

#### Change

1. **导入与基础状态**
   - 从 `../overlay-hooks.js` 引入 `useEscape`、`usePaneLeft`。
   - 从 `../mark.js` 引入 `BotMark`（保留 `BotAvatar` 仅当仍需要）。
   - 从 `../icons.js` 引入 `PlusIcon`、`ArrowUpIcon`、`CloseIcon` 或使用原群聊的 `×` 文本。
   - 从 `../workgroup-status.js` 引入 `hubStatusOf`、`hubCreateHint`。
   - 新增 props：`hub`（可选，`Overlays` 传入当前 Hub view）。
   - 局部 state：`name`、`bots`、`query`、`picked`、`target`、`invites`、`busy`、`created`、`error`。

2. **Hub 阻断判断**
   - 计算：
     ```js
     const status = hub === undefined ? undefined : hubStatusOf(hub)
     const blockedReason = status === undefined
       ? (workgroups?.available === false
           ? t('Creating a workgroup needs the Workgroup Hub. Ask your administrator to configure one.')
           : undefined)
       : (status === 'live' ? undefined : t(hubCreateHint(status, hub)))
     const blocked = blockedReason !== undefined
     ```
   - `hub === undefined` 时保留旧测试兼容（a22 现有 mock 不传 `hub`）。
   - `create()` 在 `busy || created || blocked || name.trim() === ''` 时直接返回。

3. **Bot 目录**
   - `useEffect` 调 `workgroups.directory({ ownerUserId: workgroups.identity?.userId })`。
   - 结果按 `entry.ownerUserId === workgroups.identity?.userId || entry.mine === true` 过滤；`identity` 缺失时结果为空。
   - 目录失败时设置 `error`，但允许无 Bot 创建。

4. **创建与邀请**
   - `create()`：
     1. 清空错误，`setBusy(true)`。
     2. `const room = await workgroups.createRoom(name.trim(), { kind: 'workgroup', botIds: [...picked] })`。
     3. 成功后立即 `setCreated(room)`，防止重复提交。
     4. 逐条 `await workgroups.invite(room.id, { targetUserId, role: 'member' })`，用 `try/catch` 收集失败，不因单条失败中止。
     5. 调用 `onCreated?.(room)` 打开工作群。
     6. 若有邀请失败，调用 `report?.(new Error(t('Workgroup created, but invitations failed: {reason}', { reason: ... })))`。
     7. `createRoom` 失败才 `setError(...)`、`report?.(failure)`、`setBusy(false)`；成功后组件会被 overlay 关闭，不把 `busy` 重置为可提交。
   - `created` 存在时禁用两个提交按钮，避免测试/异常路径下二次建房。

5. **DOM 骨架（复制原群聊）**
   ```jsx
   h('div', { className: 'bt-pane', style: { left: paneLeft } },
     h('div', { className: 'bt-newchat', role: 'dialog', 'aria-label': t('Create workgroup chat') },
       h('div', { className: 'bt-to' },
         h('span', { className: 'bt-to-label' }, t('To:')),
         picked.map(bot => h('span', { className: 'bt-token', key: bot.botId },
           h(BotMark, { bot: { id: bot.botId, name: bot.displayName ?? bot.botId }, size: 16 }),
           bot.displayName ?? bot.botId,
           h('button', { type: 'button', onClick: () => unpick(bot.botId) }, '×'))),
         invites.map(id => h('span', { className: 'bt-token', key: id },
           h(HumanFace, { name: id, size: 16 }), id,
           h('button', { type: 'button', onClick: () => dropInvite(id) }, '×'))),
         h('input', {
           autoFocus: true, value: query, 'aria-label': t('Add your Bot'),
           placeholder: t('Add your Bot'),
           onChange: event => { setQuery(event.target.value); setCursor(0) },
           onKeyDown: handleBotKeyDown,
         }),
         h('input', {
           className: 'bt-wg-invite-input', value: target, 'aria-label': t('User ID to invite'),
           placeholder: t('User ID to invite'),
           onChange: event => setTarget(event.target.value),
           onKeyDown: handleInviteKeyDown,
         }),
         target.trim() === '' ? null : h('button', {
           type: 'button', className: 'bt-soft bt-soft-sm', 'data-wg-create-invite': 'add',
           onClick: addInvite,
         }, h(PlusIcon), t('Add')),
         h('button', {
           type: 'button', className: 'bt-send bt-to-create',
           'data-wg-create-submit': 'true',
           disabled: busy || created !== undefined || blocked || name.trim() === '',
           onClick: () => void create(),
         }, t('Create workgroup chat')),
         h('button', { type: 'button', className: 'bt-x', 'aria-label': t('Close'), onClick: onCancel }, '×')),
       h('div', { className: 'bt-drop' },
         h('div', { role: 'listbox', 'aria-label': t('Bots to add'), className: 'bt-drop-list' },
           bots.length === 0
             ? h('div', { className: 'bt-hint' }, t('You have no published Bots. You can create the workgroup without one.'))
             : filteredBots.map((bot, index) => h('button', {
                 key: bot.botId, type: 'button', role: 'option', className: 'bt-option',
                 'aria-selected': index === active,
                 'data-wg-create-bot': bot.botId,
                 onMouseEnter: () => setCursor(index),
                 onClick: () => toggleBot(bot.botId),
               },
               h(BotMark, { bot: { id: bot.botId, name: bot.displayName ?? bot.botId }, size: 22 }),
               h('span', { className: 'bt-option-label' }, bot.displayName ?? bot.botId),
               picked.includes(bot.botId) ? h('span', { className: 'bt-option-hint' }, t('Added')) : null)))),
       h('div', { className: 'bt-nc-spacer' }),
       blockedReason === undefined ? null : h('div', { className: 'bt-error', role: 'status', 'data-wg-create-unavailable': 'true' }, blockedReason),
       error === undefined ? null : h('div', { className: 'bt-error', role: 'alert', 'data-wg-create-error': 'true' }, error),
       h('div', { className: 'bt-nc-compose' },
         h('div', { className: 'bt-nc-card' },
           h('span', { className: 'bt-nc-plus', 'aria-hidden': true }, h(PlusIcon)),
           h('textarea', {
             rows: 1, value: name, 'aria-label': t('Workgroup name'),
             placeholder: t('Workgroup name'), maxLength: 60,
             onChange: event => setName(event.target.value),
             onKeyDown: (event) => {
               if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                 event.preventDefault()
                 void create()
               }
             },
           }),
           h('button', {
             type: 'button', className: 'bt-nc-send',
             'data-wg-create-send': 'true',
             'aria-label': t('Create workgroup chat'),
             disabled: busy || created !== undefined || blocked || name.trim() === '',
             onClick: () => void create(),
           }, h(ArrowUpIcon))))))
   ```
   - 实际实现需保留 `data-wg-create-*` 钩子；可使用 `HumanFace`（从 `./thread.js` 引入）。
   - Bot 选项列表可始终显示；`filteredBots` 按 `query` 过滤；`active` 用 `Math.min(cursor, options.length - 1)`。
   - 键盘：ArrowDown/ArrowUp 移动 `cursor`，Enter 选中当前 Bot，Backspace 在 `query === ''` 时移除最后一个 pick；邀请输入 Enter 添加 token；均处理 `isComposing`。
   - `query`/`bots` 改变时 `setCursor(0)`。

6. **样式**
   - 删除 `.bt-wg-create-pane`、`.bt-wg-create`、`.bt-wg-create-head`、`.bt-wg-create-title`、`.bt-wg-create-row`、`.bt-wg-create-invites`、`.bt-wg-create-foot` 以及对应 reduced-motion 规则。
   - 新增 `.bt-wg-invite-input { flex: 0 1 200px; min-width: 140px; }`；其余复用 shell `bt-to`/`bt-drop`/`bt-nc-*` 规则。
   - `usePaneLeft` 测量当前会话列；`bt-pane` 只通过 `style.left` 定位，与原群聊一致。

7. **共享 Hub 提示**
   - `workgroup-status.js` 新增：
     ```js
     export function hubCreateHint(status, view) {
       switch (status) {
         case 'absent': return 'Hub is not configured'
         case 'signed-out': return 'Configured, signed out'
         case 'offline': return 'Hub is offline. Reconnect to create a workgroup.'
         case 'refused': return 'Hub refused this device. Sign in again to create a workgroup.'
         case 'unknown':
           return view?.phase === 'unreachable'
             ? 'Could not check the Workgroup Hub.'
             : 'Checking the Workgroup Hub…'
         default: return undefined
       }
     }
     ```
   - `workgroup-sidebar.js` 的 `WorkgroupSectionHead` 删除本地 `createHint` 函数，改为：
     ```js
     const hint = typeof action === 'function'
       ? (hubCreateHint(hubState, hub) === undefined ? undefined : t(hubCreateHint(hubState, hub)))
       : t('Workgroup creation is not available in this build.')
     ```
     避免重复 `hubCreateHint` 调用可先存 `const key = hubCreateHint(...)`。
   - `overlays.js` 的 `WorkgroupCreate` 增加 `hub` prop。

#### Reason

- 满足 AC-03“创建界面与原群聊创建界面一致”，并让创建面真正覆盖会话区。
- 修复“房间已创建但邀请失败导致用户停留、重试重复建房”的逻辑缺口。
- 让 Hub 不可用的原因与实际状态一致，避免“未登录”被误报成“未配置”。
- 避免把别人的 Bot 当作自己的 Bot 选择，减少创建被 400/404 拒绝。

#### Risk

- `bt-to` 行同时放 Bot 搜索、邀请输入和两个按钮，窄窗口可能换行；原群聊 `bt-to` 本身是 `flex-wrap`，需要 web 端 1280×820 和窄窗口各看一次。
- `bt-drop` 是 `position:absolute; top:48px`；如果 `bt-to` 行因 token 换行变高，下拉可能与行重叠；这是原群聊既有行为，保持复制，不在本步发明新布局。
- 名称放在 `bt-nc-card` textarea 中，是原群聊“消息输入”位置的语义复用；必须通过 placeholder/aria-label 说明是群名称。
- 邀请失败后仍进入工作群，用户可能没看到 toast；需要测试确认 `report` 被调用，且侧栏/详情可看到 pending 邀请（若有）。
- `hub` 未传入时回退到 `workgroups.available`，保持现有 a22 mock 可用；真实 `Overlays` 必须传 `hub`。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts -t "creation"
```

新增/更新断言：

- 根节点 `bt-pane` 有 `style.left`（jsdom 下为 `280px`）。
- 存在 `.bt-newchat`、`.bt-to`、`.bt-drop`、`.bt-nc-compose`、`.bt-nc-card`、`.bt-x`、`.bt-send.bt-to-create`。
- 名称空时提交禁用；填名称后可提交。
- 选择 Bot、添加邀请后调用参数不变：`createRoom('Launch', { kind: 'workgroup', botIds: ['mine'] })`、`invite('room-9', { targetUserId: 'u3', role: 'member' })`。
- `invite` 拒绝时 `onCreated` 仍被调用，`report` 收到错误，`createRoom` 只调用一次。
- `hub` 为 `signed-out`/`offline`/`refused` 时显示对应原因并禁用提交；不传 `hub` 时沿用 `available` 回退。
- Escape 关闭调用 `onCancel`。

Web 端第一步只验证创建面结构，最终视觉在第 6 步统一截图。

---

### Step 2: 会话外壳改为原群聊 pill，详情/设置改为右侧面板

#### Target

- `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js`
  - `WorkgroupConversation`
  - 新增 `GoArrow`、`MemberPile`、`PanelName`（或等价局部组件）
- `application/packages/bundle/ds-bot/src/client/workgroup-pane.js`
  - `WorkgroupSurface` 的 `settingsOpen` 状态与 `view.current(null)` 分支
- `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
  - `WORKGROUP_UI_CSS` 的头部/抽屉/面板规则

#### Current Behavior

- 头部是 `bt-wg-head`：56px、下边框、右侧 `bt-icon-btn bt-wg-gear`；原群聊是 `bt-head`（40px）+ `bt-pill` + `bt-pill-go`。
- `settingsOpen` 为 true 时 `WorkgroupConversation` 直接返回整页 `bt-wg bt-wg-settings`，对话被替换；原群聊设置是详情面板内的 `bt-subhead + bt-drawer-body`。
- 详情是 `aside.bt-wg-drawer`，自定义宽度 `min(360px,42%)`、`bt-wg-details`；没有 `bt-panel-view/bt-drawer-top/bt-drawer-id`。
- 详情底部的 “Group settings” 调 `onCloseSettings('open')`，pane 忽略参数并 `setSettingsOpen(false)`，入口无效。
- 头部未读 `unreadCount(messages, watermark)` 的 `watermark` 从未传入，实际把全部历史算作未读。
- 公告在消息上方额外渲染 `bt-wg-notice-bar`；原群聊只在详情展示公告。

#### Change

1. **头部**
   - 删除 `bt-wg-head`、`bt-icon-btn bt-wg-gear`、`bt-wg-unread`、`bt-wg-notice-bar` 的渲染。
   - 使用：
     ```jsx
     h('div', { className: 'bt-head' },
       h('button', {
         type: 'button', className: 'bt-pill bt-wg-pill',
         'data-wg-details': panel === null ? 'closed' : 'open',
         'aria-expanded': panel !== null,
         'aria-label': t('View conversation details'),
         onClick: () => setPanel(value => value === null ? 'details' : null),
       },
       room ? h(RoomAvatar, { room: { ...room, members: (members ?? []).map(member => member.userId) }, roster: { byId: {}, bots: [] }, size: 24 }) : null,
       h('span', { className: 'bt-pill-name' }, room?.name ?? ''),
       h('span', { className: `bt-wg-hub-dot bt-wg-hub-dot-${hubState ?? 'unknown'}`, 'aria-hidden': true }),
       h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow))))
     ```
   - `GoArrow` 从 `header.js` 复制同一段 SVG（不 import 原文件，避免耦合）。
   - 删除 `unreadCount` import 与 `watermark` prop；`messages` 继续给 thread。
   - 保留 `data-wg-hub` 在根节点；Hub 状态文案在详情 `Workgroup` 区域显示。

2. **面板状态**
   - `const [panel, setPanel] = useState(null)`，类型 `null | 'details' | 'settings'`。
   - 删除 props `settingsOpen`、`onCloseSettings`、`watermark`。
   - `panel === null` 时不渲染右侧面板；`panel === 'details'` 渲染详情；`panel === 'settings'` 渲染设置。
   - `WorkgroupConversation` 不再 `return` 整页设置；始终保留 thread/composer，右侧面板用 flex 挤压 `.bt-wg-main`。

3. **详情面板结构**
   ```jsx
   h('aside', { className: 'bt-wg-panel', 'aria-label': t('Group details') },
     h('div', { className: 'bt-panel-view' },
       h('div', { className: 'bt-drawer-top' },
         h('button', {
           type: 'button', className: 'bt-round', 'aria-label': t('Group settings'),
           title: t('Group settings'), 'data-wg-settings': 'open',
           onClick: () => setPanel('settings'),
         }, h(GearIcon)),
         h('button', {
           type: 'button', className: 'bt-round', 'aria-label': t('Close details'),
           'data-wg-details-close': 'true', onClick: () => setPanel(null),
         }, h(CloseIcon))),
       h('div', { className: 'bt-drawer-id' },
         h(MemberPile, { members, bots }),
         h(PanelName, { room, onRename: name => renameRoom(name) }),
         h('span', { className: 'bt-drawer-role' }, t('Workgroup · {count} members', { count: (members ?? []).length + (bots ?? []).length }))),
       h(WorkgroupDetails, {
         room, members, bots, tasks, events, selfUserId,
         actions, run, loadOwnerBots, onDecision, onReview, onCancel,
         onOpenSettings: () => setPanel('settings'),
         memory, hubState,
       })))
   ```
   - `MemberPile`：真人用 `HumanFace`（size 44），Bot 用 `BotMark`（look circle/blue，size 44）；最多 4 个，超出显示 `+N`；复用 `bt-pile/bt-pile-face/bt-pile-more`。
   - `PanelName`：
     - 非编辑态 `button.bt-drawer-name`，点击进入编辑；
     - 编辑态 `input.bt-drawer-name-input`，`autoFocus`，`onBlur`/Enter 保存，Escape 取消并回退；
     - 空值或未变化不调用 `renameRoom`；
     - 保存调用 `onRoomAction('renameRoom', { name })`，失败写入 `setError`。
   - `renameRoom` 需要在 `WorkgroupConversation` 内定义，捕获错误到现有 `error` 状态。

4. **设置面板结构**
   ```jsx
   h('div', { className: 'bt-panel-view' },
     h('div', { className: 'bt-subhead' },
       h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'), onClick: () => setPanel('details') }, h(ChevronLeftIcon)),
       h('span', { className: 'bt-subhead-title' }, t('Group settings')),
       h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'), onClick: () => setPanel(null) }, h(CloseIcon))),
     h('div', { className: 'bt-drawer-body bt-set-body' },
       h(WorkgroupSettingsForm, {
         room, members, bots, selfUserId, identity, prefs, onFlag,
         onAction: onRoomAction, onDissolve,
         onClose: () => setPanel(null),
         loadOwnerBots, loadBotCandidates,
       })))
   ```
   - 面板宽度 320，设置与详情宽度不变，不整页替换对话。

5. **Pane 清理**
   - 删除 `const [settingsOpen, setSettingsOpen] = useState(false)`。
   - 删除 `view.current` 顶部：
     ```js
     if (value === null) { setSettingsOpen(true); return true }
     ```
   - 删除传给 `WorkgroupView` 的 `settingsOpen`、`onCloseSettings`。
   - 保留 `onDissolve`、`onRoomAction`、`onSend` 等。

6. **样式**
   - 删除 `.bt-wg-drawer`、`.bt-wg-drawer>.bt-drawer-body`、`.bt-wg-gear`、`.bt-wg-unread`、`.bt-wg-notice-bar`、`.bt-wg-settings` 相关规则。
   - 新增：
     ```css
     .bt-wg-panel{flex:none;width:320px;max-width:45%;min-height:0;display:flex;flex-direction:column;border-left:.5px solid var(--bt-line-2);background:var(--bt-main);overflow:hidden;animation:bt-wg-panel-in .22s cubic-bezier(.16,1,.3,1)}
     .bt-wg-panel>.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column}
     @keyframes bt-wg-panel-in{from{transform:translateX(100%)}}
     ```
   - 保留 `.bt-wg-head`/`.bt-wg-name` 供 `workgroup-pane.js` 离线状态页使用；不要删除旧 `WORKGROUP_CSS` 中的同名规则。
   - 保留 `.bt-wg-pill`、`.bt-wg-hub-dot*`；必要时给 `.bt-wg-pill` 增加 `max-width:70%`（现有已有）。

#### Reason

- AC-04/AC-10 要求会话头、详情、设置视觉结构与原群聊一致；当前自定义头部/抽屉是全页最明显的差异。
- 修复详情→设置入口的真实逻辑 bug。
- 删除未读徽标的错误计算；未读由侧栏行承担，符合原群聊。
- 公告只在详情显示，符合原群聊。

#### Risk

- `bt-panel-view` 依赖 `SHELL_CSS`，已在客户端入口安装；工作群 `WORKGROUP_UI_CSS` 后安装不会覆盖核心布局。
- 原群聊面板是 fixed + `chatRoom` 平移，本实现是工作群 pane 内 flex 挤压；宽度/边框/内部结构一致，但拖拽调宽和跨列 spring 动画不复制，作为残余差异记录。
- 删除头部齿轮会改变用户操作路径；a16 必须同步改为“先开详情，再点齿轮”。
- `PanelName` 内联改名需要 `onRoomAction`；如果 Host 不支持，错误显示在现有 `error` 行，不新增请求。
- 详情面板 `max-width:45%` 在窄窗口可能小于 320；需要 web 端窄窗口检查。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```

断言：

- 初始无 `.bt-wg-panel`；点 `[data-wg-details]` 后出现 `.bt-wg-panel .bt-panel-view .bt-drawer-top .bt-drawer-id .bt-drawer-body`。
- 点 `[data-wg-settings="open"]` 后出现 `.bt-subhead`、`.bt-drawer-body.bt-set-body`，且 `.bt-wg-thread` 仍存在（对话未被替换）。
- 点 Back 回到详情；点 close 面板消失。
- 点标题 pill 在详情打开/关闭之间切换；`aria-expanded` 正确。
- 详情内联改名调用 `renameRoom`；空名/Escape 不调用。
- 删除头部齿轮后，a16 的设置操作先打开详情。

---

### Step 3: 群详情正文按原群聊结构对齐

#### Target

- `application/packages/bundle/ds-bot/src/client/workgroup-ui/details.js`
  - `WorkgroupDetails`
  - `About`
  - `MemberRows`
  - `TaskUsage`
  - `MemoryPanel` 保持数据逻辑不变

#### Current Behavior

- `WorkgroupDetails` 返回 `bt-drawer-body bt-wg-details`，包含公告、成员、工作群 Hub 状态、任务活动、群记忆、用量，但底部有自定义“Group settings/Close”按钮。
- 成员区 `MemberRows` 是自定义 `bt-member` 行，只有真人面孔/Bot 标记和在线点；没有原群聊详情的顶部图标、头像堆叠、名称、副标题（这些应在 Step 2 面板容器中）。
- 公告折叠组件 `About` 复用原群聊 `bt-about/bt-more`，但缺失公告时只作为一个按钮。
- `TaskUsage` 只统计任务总数/打开/共享，没有原群聊 `Usage` 的位置一致性。

#### Change

1. **外层**
   - 保留 `h('div', { className: 'bt-drawer-body', 'data-wg-details': room?.id })`，但删除 `bt-wg-details` 自定义间距类（若不再需要）。
   - 删除底部：
     ```jsx
     h('div', { className: 'bt-wg-task-actions' },
       h('button', { 'data-wg-settings': 'open', onClick: onOpenSettings }, t('Group settings')),
       h('button', { 'data-wg-details-close': 'true', onClick: onClose }, t('Close')))
     ```
     设置和关闭只由 Step 2 的 `bt-drawer-top` 提供。

2. **正文顺序**
   - `About` 公告（标题 `Notice`，缺失时“Add a notice in group settings”调用 `onOpenSettings`）。
   - `Members · {count}`：`(members?.length ?? 0) + (bots?.length ?? 0)`；真人 + Bot 都放在同一个 `bt-members`/`bt-member` 列表。
   - `Workgroup`：Hub 状态 `bt-kv`；解散时间（若有）`data-wg-dissolved`。
   - `Task activity`：保留 `WorkgroupTasks`，任务卡进度、审批、取消逻辑不变。
   - `Group memory`：保留 `MemoryPanel`。
   - `Usage`/`TaskUsage`：保留任务计数 `bt-kv`。
   - 真人有角色时继续由 `memberSummary` 显示 `Owner/Admin`；Bot 行保留 `Owner: {name}` 和 `Bot` 标签。

3. **成员行**
   - 保留 `data-wg-member`/`data-wg-presence`/`data-wg-bot`，确保 a22 现有选择器可用。
   - 真人行增加 `bt-member-sub` 展示 `member.role` 或在线状态（使用现有 `t('Owner')`、`t('Admin')`、`t('Member')`、`t('Online')`/`t('Offline')`，缺失中文在 Step 5 补齐）。
   - Bot 行继续显示 `Owner: {name}`；不新增跨设备“停止工作”按钮。

4. **不新增数据请求**
   - 详情只消费 pane 传入的 `room/members/bots/tasks/events/memory/hubState`；不改 `workgroup-pane.js` 的读取逻辑。

#### Reason

- AC-10 要求详情包含公告、成员、任务进度、用量，且结构与原群聊详情一致；当前顶部在 Step 2 补齐，正文需要去掉重复操作并统一顺序。
- 保持现有任务/记忆业务逻辑不变，避免扩大范围。

#### Risk

- a16 中 `[data-wg-settings="open"]` 从详情正文移动到面板顶部；测试需要先打开详情。
- 成员行新增 `bt-member-sub` 可能改变高度；用 web 端检查成员多时的滚动。
- `owner`/`admin`/`online` 等 key 若缺中文，Step 5 统一补；不能在本步用硬编码。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts -t "details"
```

断言：

- `WorkgroupDetails` 仍渲染公告、真人/Bot 成员、群记忆、任务活动。
- 不再渲染底部 Group settings/Close。
- `data-wg-settings="open"` 只存在于 Step 2 的面板顶部。
- a22 现有 `data-wg-memory-*`、`data-wg-approval-*` 选择器保持可用。

---

### Step 4: 群设置表单对齐原群聊控件与卡片结构

#### Target

- `application/packages/bundle/ds-bot/src/client/workgroup-ui/settings.js`
  - `WorkgroupSettingsForm`
  - `Hero`
  - `MemberRow`
  - `BotRow`

#### Current Behavior

- 名称/公告使用 `bt-bs-input` + `Save changes`/`Save notice` 按钮；保存依赖显式点击。
- Members 和 Bots 是两张独立卡；Bot 添加用 `select + Add Bot`；邀请他人 Bot 用另一个 select。
- 卡片顺序：Hero → Profile → Task collaboration → Members → Bots → Sidebar → Manage。
- 底部有 `Close` 按钮。

#### Change

1. **导入**
   - 从 `../bot-settings.js` 增加 `InlineText`；保留 `Card/Row/SwitchRow`。
   - 保留 `ChevronRightIcon`、`PlusIcon`（添加行用）。

2. **名称/公告**
   - 删除 `name`/`notice` 局部 state 和两个 `useEffect`。
   - Profile 卡改为：
     ```jsx
     h(Card, { title: t('Profile') },
       h(Row, { label: t('Name'), hint: t('Leave it empty to name the group after its members.') },
         manage
           ? h(InlineText, {
               label: t('Group name'), value: room.name, placeholder: t('Group name'),
               maxLength: 60, required: true,
               onSave: next => act(() => onAction('renameRoom', { name: next })),
             })
           : room.name),
       h(Row, { label: t('Notice'), hint: t('Every member reads it before speaking in this group.'), stack: true },
         manage
           ? h(InlineText, {
               label: t('Notice'), value: room.notice ?? '', multiline: true, maxLength: 2000,
               placeholder: t('Shared instructions every member reads before speaking…'),
               onSave: next => act(() => onAction('updateNotice', { notice: next })),
             })
           : (room.notice ?? '')))
     ```

3. **Members 合并**
   - 删除独立 `Bots · {count}` Card。
   - Members 卡标题 `Members · {count}`，count = `members.length + bots.length`。
   - 卡内顺序：
     1. 真人 `MemberRow`；
     2. Bot `BotRow`；
     3. 邀请真人输入行（保留 `data-wg-action="invite"`，创建后 `invitation` 显示 Revoke）；
     4. `candidateNote`；
     5. 添加自己的 Bot：`bt-gs-add` 行按钮（`data-wg-action="add-bot"` 仍放在最终确认按钮上），点击展开候选列表；
     6. 邀请他人 Bot：同样的 add 行，文案 `Invite another member's Bot` / `Ask the owner`；
     7. 说明 `A Bot’s owner approves every task it runs...`。
   - 保留 `present/available/own/others` 计算和 `visibilityOf/changeVisibility` 逻辑。
   - 保留 `data-wg-bot-visibility`、`data-wg-remove-bot`、`data-wg-role`、`data-wg-remove`。

4. **Hero**
   - `Hero` 增加 `bots` 参数，副标题 count = humans + bots；继续使用 `RoomAvatar` + `bt-bs-hero/bt-bs-who/bt-bs-name/bt-bs-sub`。

5. **底部**
   - 删除 `h('button', { onClick: onClose }, t('Close'))`。
   - 保留成员 `Leave workgroup`（`data-wg-action="leave"`），成功后 `onClose()`。
   - 保留群主 `Dissolve` 的二次确认（`data-group-action="dissolve"`、`data-confirm`）。

6. **卡片顺序**
   - Hero → Profile → Task collaboration → Members → Sidebar → Manage。
   - `Task collaboration` 说明保留，作为原群聊“Who answers/Working folder/Permissions”的工作群语义落点。

#### Reason

- AC-09 要求设置页结构、分组、控件和确认交互与原群聊一致；`InlineText` 和单 Members 卡是核心差异。
- 保留工作群专属 Bot 所有权/可见性和人类角色管理，不把原群聊的 Bot 管理员概念错误复制过来。

#### Risk

- `InlineText` 失焦/回车保存改变 a16/a22 测试交互；必须同步更新测试，不保留隐藏 Save 按钮。
- 合并卡片后 Bot 可视性开关、角色 select、添加/邀请按钮都集中在 Members 卡，需要检查 320px 面板下是否拥挤；必要时用 `bt-bs-stack`。
- `InlineText` 的 `required` 会阻止空名称保存；工作群服务端也要求非空名称，语义一致。
- `onClose` 只用于 Leave 后关闭；群主解散后 pane 会因 `dissolvedAt` 重新加载，不要自动关闭。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts -t "settings"
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

断言：

- 名称输入失焦/回车调用 `renameRoom`；公告输入失焦/回车调用 `updateNotice`。
- 不再存在 `[data-wg-action="rename"]` Save 按钮；不得用隐藏按钮绕过。
- Members 卡同时包含真人和 Bot；`data-wg-bot-visibility`、`data-wg-remove-bot`、`data-wg-role`、`data-wg-remove` 仍可用。
- 添加自己的 Bot、邀请他人 Bot、移除、pin/hide、dissolve/leave 行为不变。
- 非 owner 不显示 rename/notice 可编辑控件、不显示 dissolve。

---

### Step 5: 补齐中文文案与测试门禁

#### Target

- `application/packages/bundle/ds-bot/src/client/i18n.js`
  - `DICTIONARY.zh`
- `application/packages/bundle/ds-bot/test/i18n.test.js`
  - 递归扫描 `src/client/**/*.js`
- `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
  - 创建面结构、创建失败语义、详情/设置面板结构、内联改名
- `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`
  - 设置打开路径、InlineText 保存、任务卡测试中 `data-wg-settings` 的期望

#### Current Behavior

- `workgroup-ui/` 下至少 53 个 `t()` key 缺中文（用递归扫描可复现）。
- `test/i18n.test.js` 只读 `new URL('../src/client/', import.meta.url)` 的顶层文件，不进入 `workgroup-ui/`。
- a16 直接点击 `[data-wg-settings="open"]`（当前头部齿轮）；Step 2 后该按钮只在详情面板。
- a16 名称保存点击 `[data-wg-action="rename"]`；Step 4 后改为失焦/回车。
- a16 任务卡用例在 reject 后断言 `[data-wg-settings="open"]` 存在（当前头部齿轮）；Step 2 后应改为断言 `[data-wg-details]` 存在。

#### Change

1. **递归 i18n 门禁**
   - `test/i18n.test.js` 实现递归读取：
     ```js
     function clientSources(dir) {
       const files = []
       for (const entry of readdirSync(dir, { withFileTypes: true })) {
         const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
         if (entry.isDirectory()) files.push(...clientSources(child))
         else if (entry.name.endsWith('.js')) files.push(child)
       }
       return files
     }
     ```
   - 对每个文件执行现有 `t('...')` 正则，收集缺失 key；断言 `missing` 为空。
   - 保留现有语言切换测试。

2. **补中文**
   - 先运行门禁拿到完整缺失列表，再逐条加入 `DICTIONARY.zh`；保留 `{name}`/`{count}`/`{n}` 占位符。
   - 新增文案至少包括：
     - `Workgroup name`、`Add your Bot`、`Added`、`User ID to invite`、`Invite by user id`、`Bots to add`、`Workgroup created, but invitations failed: {reason}`；
     - 详情：`Group details`、`Owner: {name}`、`Task activity`、`{count} tasks`、`{count} open`、`Shared results`、`Group memory`、`Group memory is unavailable on this Host.`、`Search group memory`、`The group has not remembered anything yet.`、`revision {n}`、`Correct`、`New group memory`、`Corrected group memory`、`Something the group should remember…`、`Remember`、`Save correction`、`Hub`、`Online`、`Offline`；
     - 设置：`Workgroup · {count} members`、`Task collaboration`、`A Bot here belongs to someone else...`、`No Bots in this workgroup.`、`Add a Bot`、`Choose a Bot`、`Add Bot`、`Invite another member's Bot`、`Choose a colleague’s Bot`、`Ask the owner`、`A Bot’s owner approves every task it runs...`、`Your user id: {id}`；
     - composer/thread 现有缺失 key 也一并补齐（`Give the scheduled message a delay in minutes.`、`Write the message to send.`、`Scheduled message`、`Message to send later`、`Delay in minutes`、`Schedule`、`Image unavailable`、`Image attachment` 等）。
   - 不修改英文 key；只加中文值。

3. **a22 更新/新增**
   - 创建：
     - `bt-pane` 有 `style.left`；
     - `bt-newchat/bt-to/bt-drop/bt-nc-compose/bt-nc-card/bt-send.bt-to-create/bt-x` 存在；
     - Escape 调用 `onCancel`；
     - Bot 选项键盘上下 + Enter；
     - `invite` 拒绝时 `onCreated` 仍调用且 `report` 收到错误；
     - `hub` 为 `signed-out`/`offline`/`refused` 时显示对应原因并禁用提交。
   - 面板：
     - 点 `[data-wg-details]` 出现 `bt-wg-panel/bt-panel-view/bt-drawer-top/bt-drawer-id`；
     - 点 `[data-wg-settings="open"]` 出现 `bt-subhead` + `bt-drawer-body bt-set-body`，`.bt-wg-thread` 仍在；
     - Back/close 路径；
     - 详情内联改名调用 `renameRoom`。
   - 设置：
     - 名称/公告失焦保存；
     - Members 卡同时含真人和 Bot。
   - 保留现有消息/任务/记忆用例。

4. **a16 更新**
   - 设置操作前先 `click('[data-wg-details]')`，再 `click('[data-wg-settings="open"]')`。
   - 名称保存改为 `fill` 后触发 `blur` 或 `Enter`；公告同理。
   - reject 后的断言改为 `[data-wg-details]` 存在；若需要设置按钮，再打开详情。
   - 保留 dissolve/leave/role/remove 的 `data-wg-*` 选择器。

5. **测试运行顺序**
   - 先改测试，运行确认失败（预期：新选择器/新行为不存在）。
   - 再完成 Step 1–4 的实现（若按本计划顺序执行，Step 1–4 实现已完成，则本步先补测试中尚未覆盖的断言）。
   - 最后运行 a22/a16 全量。

#### Reason

- 中文界面缺少 53+ 条翻译，属于“样式/文案与原群聊不一致”的直接表现。
- 递归门禁防止未来复制件再次漏翻。
- a22/a16 需要覆盖真实新结构，否则测试仍可能把“自定义卡片”当成“原群聊复制件”。

#### Risk

- 递归扫描可能暴露其他顶层文件之外的新缺失 key；全部补齐，不通过跳过子目录来规避。
- `DICTIONARY.zh` 中已有相似 key 可能语义不同；不要复用错误翻译，按 key 精确添加。
- 修改 a16 交互步骤时不要降低覆盖；保留 role/remove/dissolve/leave 的断言。
- `InlineText` 失焦保存依赖真实 DOM 事件；jsdom 下用 `fireEvent.blur` 或 `element.blur()` 后等待异步 `act`。

#### Verification

```bash
cd application/packages/bundle/ds-bot
node --import ./test/harness-resolve.mjs --test test/i18n.test.js

cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

预期：

- i18n 测试缺失列表为空。
- a22/a16 全部通过；a16 的设置/改名/任务卡路径使用新交互。
- 不出现硬编码 UI 文案（后续 `verify-client-ui-i18n`）。

---

### Step 6: 构建、web 端 UI 验证与执行记录

#### Target

- `application/packages/bundle/ds-bot/client.js`
- `docs/superpowers/plans/workgroup-parity-implementation.md`
- 本计划文档的 Execution Log / Changed Files Tracking

#### Current Behavior

- `client.js` 是提交的浏览器 bundle，当前仍是旧 UI。
- 旧计划 Task 9 标记 DONE，但实际创建/设置/详情未达到原群聊结构一致。
- 尚未做固定窗口/主题/语言/缩放的 web 端截图对照。

#### Change

1. **构建**
   ```bash
   cd application/packages/bundle/ds-bot
   node scripts/build-client.mjs
   node scripts/build-client.mjs --check
   ```
   预期 `BUILD_OK`；`client.js` 包含新创建面、面板结构和新中文文案。

2. **Web 端验证**
   - 启动 Hub（沿用当前工作区配置）：`cd server && npm start`。
   - 启动 web 端：`cd application && pnpm run dev:web`，使用命令输出的 URL。
   - 使用 Playwright（已有 `playwright` 技能）打开 web 页面。
   - 固定视口 1280×820，浅色/深色、中文/英文、100%/125% 缩放分别截图：
     - 原群聊：New Chat → Create group chat（选 2 个 Bot）→ 创建后的会话头、详情、设置。
     - 工作群：三个入口打开创建面；创建后会话头、详情、设置。
   - 对比项：创建面 `bt-pane/bt-newchat/bt-to/bt-drop/bt-nc-compose` 结构、面板宽度/边框、`bt-head/bt-pill`、`bt-drawer-top/bt-drawer-id`、设置卡顺序、中文文案。
   - 若 web 端没有可用的 Hub/Host 配置：记录“结构与单元测试已验证，真实 Hub 视觉验收未执行”，不得标记 AC-03/AC-04 全通过。

3. **文档**
   - 更新 `docs/superpowers/plans/workgroup-parity-implementation.md`：
     - Execution State：Task 9 改为“结构近似，已按原群聊骨架重建（本次）”，Task 12 记录 web 端验证结果。
     - Execution Log：新增本次创建/设置/详情/头部/i18n/测试门禁的条目。
     - Plan 偏差：记录“原 New Chat 不填群名，工作群增加名称输入”的需求驱动差异；记录面板为 pane 内 flex 而非 fixed+chatRoom 的差异。
   - 更新本计划第 4 节 Changed Files Tracking 和第 7 节 Execution Log。

4. **最终检查**
   - `git diff --stat` 只包含本计划列出的文件。
   - `git diff --check` 无空白错误。
   - 检查原群聊文件未出现在 diff 中。

#### Reason

- 不重新构建，桌面端/web 端仍加载旧 `client.js`。
- web 端固定环境截图是 AC-03/AC-04/AC-09/AC-10 的唯一直接视觉证据；仅靠 jsdom 类名断言不足以证明一致。
- 旧计划状态必须与真实代码一致，避免后续把“结构近似”误认为“已完成”。

#### Risk

- web 端可能没有配置 Hub，工作群创建会被阻断；此时只能验证阻断文案和结构，真实创建/成员/任务流程需在具备 Hub 的环境补验。
- 截图受字体渲染、缩放、主题影响；固定同一浏览器和视口，记录环境。
- `client.js` 构建可能因仓库既有 warning/依赖状态失败；若失败，先记录完整错误，不修改无关文件。
- 不自动提交；是否提交由用户决定。

#### Verification

```bash
cd application/packages/bundle/ds-bot
node scripts/build-client.mjs --check
```

```bash
cd application
npm run verify-client-ui-i18n
```

```bash
cd application/packages/bundle/ds-bot
npm run lint
```

```bash
cd application
npm run typecheck
```

预期：

- build check：`BUILD_OK`。
- i18n gate：无硬编码 UI 字符串。
- lint：0 errors（记录既有 warning 基线）。
- typecheck：无本次引入的新错误；若基线已有错误，记录与本次无关的证据。
- web 端截图完成，或明确记录环境阻塞。

---

## 4. Changed Files Tracking

> 执行过程中每修改一个文件，更新本表；新增/删除文件也要记录。

| File | Action | Reason |
|---|---|---|
| `docs/superpowers/plans/2026-10-18-workgroup-create-settings-details-parity-implementation-plan.md` | Add | 本执行计划 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js` | Modify | 复制原群聊 NewChat 骨架，修复 Hub 阻断与邀请失败语义 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js` | Modify | 删除自定义创建卡片/抽屉样式，新增原群聊面板样式 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js` | Modify | 原群聊 pill 头部、详情/设置右侧面板、修复设置入口 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/details.js` | Modify | 详情正文结构对齐，删除重复底部按钮 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/settings.js` | Modify | InlineText 名称/公告、合并 Members/Bots 卡 |
| `application/packages/bundle/ds-bot/src/client/workgroup-pane.js` | Modify | 删除外部 settingsOpen，设置改由会话内面板管理 |
| `application/packages/bundle/ds-bot/src/client/overlays.js` | Modify | 向 WorkgroupCreate 传入 hub 状态 |
| `application/packages/bundle/ds-bot/src/client/workgroup-status.js` | Modify | 新增创建场景 Hub 阻断文案 |
| `application/packages/bundle/ds-bot/src/client/workgroup-sidebar.js` | Modify | 复用共享创建阻断文案，避免两套 |
| `application/packages/bundle/ds-bot/src/client/i18n.js` | Modify | 补齐工作群复制件缺失中文与新增文案 |
| `application/packages/bundle/ds-bot/test/i18n.test.js` | Modify | 递归扫描 `src/client/**/*.js` |
| `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | Modify | 覆盖创建面/面板/邀请失败/内联改名 |
| `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` | Modify | 更新设置入口、InlineText 保存、任务卡断言 |
| `application/packages/bundle/ds-bot/client.js` | Modify | 重新生成浏览器 bundle |
| `application/packages/bundle/ds-bot/lib/client.js` | Modify | 为 web 端验证重新 staging 的 ignored 浏览器 bundle；不进入提交 |
| `docs/superpowers/plans/workgroup-parity-implementation.md` | Modify | 修正 Task 9 完成度并记录本次执行 |

---

## 5. Verification Checklist

### 主流程验证

- [x] 三个入口（新建菜单 / Bot 设置 Group chats / 命令面板）都打开同一个原群聊骨架创建面（a04 6/6；web 侧栏入口实测）。
- [x] 创建面覆盖会话区，不是右侧 560px 卡片；Esc 可关闭（a22 与 web 截图）。
- [x] 名称必填、最多 60 字；自己的 Bot 可多选；真人可输入 user id 邀请（a22）。
- [x] 创建成功后创建者显示 Owner，工作群打开，侧栏出现工作群行（web 实测 `UI 验收工作群`）。
- [x] 点标题 pill 打开详情；详情齿轮打开设置；Back 回详情；Close 关闭面板，对话保留（a22 + web）。
- [x] 设置中名称/公告失焦或回车保存；成员/Bot/角色/可见性/邀请/移除/pin/hide/dissolve/leave 正常（a16 20/20、a22 26/26）。
- [x] 详情显示公告、真人+Bot 成员、Hub 状态、任务活动、群记忆、用量；没有重复的底部设置/关闭按钮（a22 + web）。

### 关联流程验证

- [ ] 原群聊 New Chat → Create group chat、群设置、群详情、消息、输入区、侧栏、删除/归档行为不变（本次未改原群聊文件，但未做真实 UI 回归；测试 profile 只有 1 个本地 Bot，无法创建本地群聊）。
- [x] 三个入口仍保持在原群聊对应位置；没有新增第四个入口（a04 6/6）。
- [x] 创建成功后 `workgroupRoster.refresh()` 生效，新行出现（web 实测）。
- [x] 设置写入只走 `onRoomAction` → Host → Hub，不调用本地 `updateRoom/deleteRoom`（a16）。
- [x] 非群主看不到 rename/notice 可编辑控件和 dissolve；成员可 Leave（a16）。
- [x] 侧栏未读仍正常；头部不再显示错误的“全部历史未读”（a21 14/14；代码已删除头部徽标）。
- [x] 详情内联改名、设置改名、公告保存的 Hub 拒绝错误可见（a22 内联改名；a16/a22 设置保存）。

### 边界情况验证

- [x] 空名称、60 字上限由控件/服务端约束；中文输入法 Enter 逻辑保留（a22 覆盖空名称与键盘，IME 分支未单独模拟）。
- [x] Escape 关闭创建面；ArrowUp/ArrowDown/Enter 选择 Bot；邀请失败路径只调用一次 `createRoom`（a22）。
- [x] 创建成功后邀请失败：工作群仍打开，失败提示可见，`createRoom` 只调用一次（a22）。
- [ ] 创建请求失败：显示错误，不打开工作群，不产生半成品房。
- [x] Hub 未配置 / 已配置未登录 / 离线 / 重连中 / 被拒绝：创建面显示对应原因并禁用提交（a22）；Host 不可达的 unknown 分支由同一 `hubCreateHint` 覆盖。
- [ ] 没有自己的 Bot：可只用名称创建。
- [ ] 窄窗口/125% 缩放：面板 320px 不把消息区挤到不可用；创建面不溢出（仅做 929×917 单视口 web 截图，未做 125% 缩放）。
- [ ] 切换房间/关闭面板：详情/设置状态重置，不串房（关闭面板已实测；切换房间未单独实测）。
- [ ] `prefers-reduced-motion`：无动画异常（未单独模拟）。

### Test

```bash
cd server
node --test tests/h16-workgroup-parity.test.js
```

预期：12/12 通过。

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts integrations/workgroup/tests/a21-workgroup-sidebar.spec.ts
```

预期：全部通过；新增用例计数以实际输出为准。

```bash
cd application/packages/bundle/ds-bot
node --import ./test/harness-resolve.mjs --test test/i18n.test.js
```

预期：缺失中文列表为空。

### Build

```bash
cd application/packages/bundle/ds-bot
node scripts/build-client.mjs
node scripts/build-client.mjs --check
```

预期：`BUILD_OK`，`client.js` 与源码一致。

### Lint

```bash
cd application/packages/bundle/ds-bot
npm run lint
```

预期：0 errors；记录既有 warning 基线。

### Typecheck

```bash
cd application
npm run typecheck
```

预期：无本次引入的新错误；若基线已有错误，记录完整输出并证明与本次文件无关。

### Web UI

- [x] 启动 Hub：本次以 `NODE_ENV=development HUB_PORT=18443 HUB_ANONYMOUS_BOOTSTRAP=true HUB_TOKEN_SIGNING_KEY=...` 启动临时 Hub。
- [x] 启动 web：使用 `pnpm run start:web --no-open`（已有构建产物），Playwright 打开输出 URL。
- [ ] 使用 Playwright 固定 1280×820、浅色/深色、中文/英文、100%/125% 缩放截图（已做 929×917 中文浅色创建面/详情/设置截图；其余环境未做）。
- [ ] 对比原群聊与工作群的创建面、会话头、详情、设置结构（工作群侧已实测；原群聊侧因 profile 只有 1 个 Bot、无模型/Key，无法创建本地群聊）。
- [x] 若 Hub/Host 不可用，记录阻塞原因，不宣称视觉验收通过（临时 Hub 可用；原群聊对照按上述阻塞记录）。

---

## 6. Plan Adjustment

### Adjustment 1: web 端实际加载 `lib/client.js`

- 原计划：只重建提交的根 `client.js`。
- 新发现：DSH web 通过包 `./client` export 加载 `lib/client.js`；根 `client.js` 是 link/git 安装产物。
- 为什么需要调整：不 staging `lib/client.js` 时，web 端仍显示旧创建卡片，无法完成 web UI 验证。
- 新增修改范围：运行既有 `node scripts/build-lib.mjs` 重新 staging ignored 的 `lib/client.js`；不新增源码文件，不进入提交。

### Adjustment 2: typecheck 基线失败

- 原计划：预期无本次引入的新错误。
- 新发现：`npm run typecheck` 在 Host Typert 阶段失败，报 `packages/interaction/permission-presets/lib/types/types.d.ts` 的既有路径问题；本次改动全部是 ds-bot 客户端 JS/测试，不涉及该包或 tsconfig。
- 处理：记录为基线失败，未修改无关 TS 配置。

### Adjustment 3: 原群聊真实 UI 对照受限

- 原计划：对比原群聊与工作群的创建/详情/设置。
- 新发现：当前 web profile 只有一个本地 `Chief` Bot，且没有可用模型/API Key，无法创建需要至少两个 Bot 的本地群聊。
- 处理：完成工作群侧真实 Hub 创建与截图；原群聊侧对照标记为未执行，不宣称 AC-04 全通过。

---

## 7. Execution Log

### Step 1 Completed

Modified:
- `workgroup-ui/create.js`
- `workgroup-ui/styles.js`
- `overlays.js`
- `workgroup-status.js`
- `workgroup-sidebar.js`

Summary: 创建面改为原群聊 `bt-pane/bt-newchat/bt-to/bt-drop/bt-nc-compose` 骨架；增加名称输入、Esc/键盘选择、只列自己的 Bot、Hub 状态阻断原因、创建成功后邀请失败不重复建房；侧栏与表单共享 `hubCreateHint`。

Verification: `npx vitest run .../a22-workgroup-ui.spec.ts -t "creation"` 8/8 通过（含结构、Escape、键盘、邀请失败、Hub 状态）；web 端创建面实测。

### Step 2 Completed

Modified:
- `workgroup-ui/index.js`
- `workgroup-pane.js`
- `workgroup-ui/styles.js`

Summary: 头部改为 `bt-head + bt-pill + bt-pill-go`；删除头部齿轮、错误未读徽标、消息上方公告条；详情/设置改到 `bt-wg-panel + bt-panel-view`，详情齿轮可打开设置，Back/Close 正常；删除 pane 外部 `settingsOpen`。

Verification: a22 26/26、a16 20/20；web 端真实打开详情/设置/返回/关闭并截图。

### Step 3 Completed

Modified:
- `workgroup-ui/details.js`

Summary: 正文保留 `bt-drawer-body`，按公告、成员、工作群 Hub、任务活动、群记忆、用量组织；成员行增加 `Online/Offline` 子行；删除底部重复 Group settings/Close。

Verification: a22 details 用例通过；web 详情面板实测。

### Step 4 Completed

Modified:
- `workgroup-ui/settings.js`
- `workgroup-ui/styles.js`（Bot 行窄面板布局）

Summary: 名称/公告改用 `Row + InlineText`（失焦/回车保存）；Members 与 Bots 合并为单卡；Add Bot / Invite colleague’s Bot 改为 `bt-gs-add` 展开；删除底部 Close；Bot 行在 320px 面板下改为上下布局。

Verification: a16 20/20、a22 settings 用例通过；web 设置面板实测并修复 Bot 行拥挤。

### Step 5 Completed

Modified:
- `i18n.js`
- `test/i18n.test.js`
- `a22-workgroup-ui.spec.ts`
- `a16-workgroup-interactions.spec.ts`

Summary: 补齐工作群创建/详情/设置/composer/thread 缺失中文；i18n 门禁改为递归扫描 `src/client/**/*.js`；a22 增加到 26 个用例；a16 改为先开详情再开设置、InlineText 失焦保存。

Verification: i18n/workgroup-css 7/7；a22 26/26；a16 20/20。

### Step 6 Completed

Modified:
- `client.js`
- `lib/client.js`（ignored，为 web 验证 staging）
- `docs/superpowers/plans/workgroup-parity-implementation.md`
- 本计划文档

Summary: 重新生成提交的根 `client.js`；为 web 验证 staging `lib/client.js`；更新旧计划 Task 9/12 与执行日志；记录 Plan Adjustment。

Verification: 工作群客户端 124/124；服务端 h16 12/12；`build-client.mjs --check` BUILD_OK；`verify-client-ui-i18n` 通过；lint 0 errors/20 既有 warnings；`git diff --check` 通过；web 端临时 Hub 创建 `UI 验收工作群` 并截图创建面/详情/设置；typecheck 基线失败（permission-presets 路径），原群聊真实 UI 对照未执行。

### Step Status

| Step | Status |
|---|---|
| Step 1 创建面与创建失败语义 | DONE |
| Step 2 会话外壳与右侧面板 | DONE |
| Step 3 群详情正文 | DONE |
| Step 4 群设置表单 | DONE |
| Step 5 中文文案与测试门禁 | DONE |
| Step 6 构建、web 端 UI 与记录 | DONE（原群聊像素对照与 typecheck 基线除外，见 Adjustment） |
