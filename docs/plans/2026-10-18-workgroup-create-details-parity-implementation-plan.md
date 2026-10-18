# Implementation Plan

**Feature:** 工作群创建、详情与基础界面一致性（修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作群在“创建者 + 至少一个 Bot”时即可创建，名称留空时静默自动命名；同时把工作群详情面板、详情功能、消息基础结构和 web 验收对齐到原群聊基线。

**Architecture:** 不修改服务端、Host Bridge、数据库或原群聊文件。创建改动只落在 `workgroup-ui/create.js`；详情改动复用原群聊的 `bt-panel` / `bt-drawer-*` / `bt-member-stop` 类名和现有 `useLinger`、`SPRING_SHAPE`；数据仍来自 `workgroup-pane.js` 已读取的 Hub 快照。消息正文复用 shell 的 `MarkdownText`，不引入第二个消息事实源。

**Tech Stack:** Node.js 24、React 18 `h()`、DSH/Cordis、Vitest + jsdom、Node test runner、Playwright（web 端验收）、现有 DS Bot 构建脚本。

## Global Constraints

- Requirement 以本轮确认结果为准：工作群最小创建集合是“创建者（自动 owner）+ 至少一个 Bot”。
- 名称输入保留，但不是必填；名称为空时由客户端静默生成，Hub 始终收到非空 `name`。
- 自动名称沿用原群聊的成员命名习惯，不使用仅日期名称。
- 不修改 `server/`、Host `hub-create-room`、`src/host/channel.js` 或数据库迁移。
- 不修改原群聊文件：`new-chat.js`、`details-drawer.js`、`group-settings.js`、`browser-pane.js`、`header.js`、`styles.js`。
- 工作群专属状态只进入 `workgroup-ui/` 复制件。
- 所有用户可见文案必须经 `t()`，并在 `application/packages/bundle/ds-bot/src/client/i18n.js` 中有中文条目。
- 修改 `src/client` 后必须重新生成 `application/packages/bundle/ds-bot/client.js`。
- web 验收加载 `application/packages/bundle/ds-bot/lib/client.js`；进行 web 验收前必须运行 `build-lib.mjs`。
- 当前工作区已有未提交改动；执行时只触碰本计划列出的文件，不回滚既有改动。
- 未获用户明确指示，不提交、不推送。
- `npm run typecheck` 存在既有 `permission-presets` 基线失败；必须运行并如实报告，不能据此宣称 typecheck 通过。

---

## 1. Goal

### 1.1 本次修改目标

1. 修正创建工作群的最小条件：
   - 创建者自动成为 owner，对应原群聊中的“管家/管理员”；
   - 至少选择一个自己的 Bot；
   - 真人邀请是可选增量。
2. 名称输入留空时静默生成：
   - 有名称时使用用户输入；
   - 无名称时用创建者和已选 Bot 的显示名生成；
   - 不显示“名称必填”错误，不打开额外弹窗。
3. 将详情/设置面板从 pane 内 flex 侧栏改为原群聊式 `bt-panel` 外壳：
   - 右侧 fixed 面板；
   - 可拖拽宽度；
   - 关闭退场；
   - 会话头部和主体随面板平移。
4. 补齐详情功能：
   - 顶部分享对话；
   - 公告、成员、在线状态、Bot 所有者；
   - 活动任务的 `Stop` 映射为取消任务；
   - 谁应答、权限的工作群说明；
   - 任务用量、任务活动和群记忆。
5. 对齐消息正文基础结构：
   - 非本人消息使用 `bt-lead` 头像位置；
   - 正文使用 `MarkdownText`。
6. 使用 web 端完成最终 UI 验收。

### 1.2 不包含

- 不新增或修改 Hub API、数据库字段、迁移和 OpenAPI 契约。
- 不修改原群聊创建、群详情、群设置、消息、侧栏或删除/归档行为。
- 不新增工作群群级共享工作目录或执行权限。
- 不新增 Bot 管理员。
- 不实现工作群消息 reaction、语音聊天或跨用户私聊引用；没有 Hub 数据源的能力保持明确禁用或说明。
- 不重写 composer、任务状态机、审批 API、群记忆 API 或侧栏入口。
- 不顺手重构无关模块，不提前抽象未来能力。

### 1.3 成功标准

- 选择一个 Bot、名称留空，创建按钮可用，提交成功。
- 创建出的工作群名称为非空成员名称，不是日期名称。
- 未选择 Bot 时，即使填写了名称也不能创建。
- 选择 Bot 并添加真人邀请时创建按钮保持可用。
- 点击群标题打开原群聊式右侧详情面板。
- 详情顶部有齿轮、分享、关闭；设置入口可返回和关闭。
- 活动任务的 Bot 在详情中可 Stop，且只调用任务取消。
- 非本人消息带 `bt-lead` 头像，消息正文经 `MarkdownText` 渲染。
- web 端真实 Hub 完成创建、详情、设置和基础会话界面验收。
- 不修改服务端、Host Bridge、原群聊文件。

---

## 2. Current Understanding

### 2.1 当前实现方式

#### 创建工作群

```text
新建菜单 / 设置 → 群聊 / 命令面板
  -> workgroupActions.openWorkgroupCreate()
  -> ui.newChat = 'workgroup'
  -> Overlays 渲染 WorkgroupCreate
  -> workgroups.createRoom(name, { kind: 'workgroup', botIds })
  -> hub-create-room
  -> Hub POST /api/v1/rooms
  -> server rooms/store.js createRoom()
```

当前 `workgroup-ui/create.js` 的创建按钮禁用条件：

```js
busy || created !== undefined || blocked || name.trim() === ''
```

选择 Bot 只写入 `picked`，不参与按钮启用判断；`create()` 内部还会再次拦截空名称。Hub `assertRoomName()` 要求名称 1–120 字符，空名称会返回 `INVALID_ROOM_NAME`。

#### 原群聊基线

- `new-chat.js` 的 `makeGroup()` 要求 `admin !== null` 且 `picked.length > 0`。
- Host `checkMembers()` 要求群成员总数至少为 2。
- 原群聊的最小组合实际是：一个管理员 Bot + 至少一个其他 Bot。
- 工作群由真人创建者自动成为 owner，因此对应最小组合是：创建者 + 至少一个 Bot。

#### 工作群详情

```text
bt-head 的标题 pill
  -> WorkgroupConversation.setPanel('details' | 'settings' | null)
  -> 当前在 .bt-wg-body 内渲染 aside.bt-wg-panel
  -> WorkgroupDetails / WorkgroupSettingsForm
```

数据来自 `workgroup-pane.js` 的 `openRoom`、`taskEvents`、`workgroupSchedules`，详情写操作通过 `onRoomAction` 回到 Hub。

当前差异：

- `aside.bt-wg-panel` 是 pane 内 flex 侧栏，不是原群聊 fixed `bt-panel`。
- 没有 `bt-panel-grip` 拖拽、关闭退场和会话区平移。
- 详情顶部缺少原群聊的分享对话。
- 详情正文没有“谁应答/权限”的工作群落点。
- Bot 成员行没有活动任务 Stop；任务卡有取消入口。
- `WorkgroupDetails` 的 `usage` 参数从未被传入。
- 消息正文是纯文本，非本人消息头像位置与原群聊不同。

### 2.2 涉及模块

| 层 | 模块 | 责任 |
|---|---|---|
| 创建 UI | `client/workgroup-ui/create.js` | 创建表单、Bot 选择、邀请、提交 |
| 创建入口 | `client/overlays.js` | 打开 `WorkgroupCreate`、传入 `workgroups/hub` |
| 会话外壳 | `client/workgroup-ui/index.js` | 标题、消息线程、composer、详情/设置 |
| 详情 | `client/workgroup-ui/details.js` | 公告、成员、任务、记忆、用量 |
| 任务状态 | `client/workgroup-ui/activity.js` | 任务卡、活动状态判断 |
| 消息 | `client/workgroup-ui/thread.js` | 消息/任务时间线、消息气泡 |
| 样式 | `client/workgroup-ui/styles.js` | 工作群自有 CSS 增量 |
| 文案 | `client/i18n.js` | 中文条目 |
| 测试 | `integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | 工作群 UI/创建/详情 |
| 测试 | `integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` | 工作群交互 |
| 产物 | `packages/bundle/ds-bot/client.js` | 提交的浏览器 bundle |

### 2.3 数据流 / 调用链

```text
Hub room
  -> workgroupHub.openRoom / taskEvents
  -> WorkgroupSurface
  -> WorkgroupView / WorkgroupConversation
  -> WorkgroupThread / WorkgroupComposer / WorkgroupDetails / WorkgroupSettingsForm

WorkgroupConversation 本地状态：
  reply / panel / panelWidth / copied / error

WorkgroupCreate 本地状态：
  name / bots / picked / invites / busy / created / error
```

### 2.4 已确认影响范围

- 创建行为只影响 `workgroup-ui/create.js`、文案和创建测试。
- 详情面板外壳影响 `workgroup-ui/index.js`、`workgroup-ui/styles.js` 和详情测试。
- 详情功能影响 `details.js`、`activity.js`、`i18n.js` 和详情测试。
- 消息基础结构影响 `thread.js` 和 UI 测试。
- 不涉及服务端、Host、API 契约和原群聊代码。

### 2.5 需求 / 代码不一致

- 旧计划和旧 `a22` 测试把“名称必填”作为正确行为；本轮需求已改为“名称可空、静默生成”。
- 旧创建提示“没有 Bot 也可以创建工作群”与本轮最小创建集合冲突，需要改写。
- 旧计划记录“详情面板采用 flex 侧栏”是残余差异；本轮要求对齐原群聊外壳。

---

## 3. Implementation Steps

### Step 1: 创建按钮启用条件与静默自动命名

#### Target

- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js`
- 文件：`application/packages/bundle/ds-bot/src/client/i18n.js`
- 测试：`application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
- 组件：`WorkgroupCreate`
- 逻辑：`pickedBots`、`create()`、两个提交按钮的 `disabled`

#### Current Behavior

- 选中 Bot 后创建按钮仍禁用。
- 名称空白时 `create()` 直接返回。
- 名称只来自 `name.trim()`。
- 无 Bot 时可以靠名称创建，文案还提示“可以不带 Bot 创建”。

#### Change

- [ ] 在 `pickedBots` 之后计算默认名称：

```js
const defaultName = pickedBots.length === 0
  ? ''
  : [t('You'), ...pickedBots.map(bot => bot.displayName ?? bot.botId)]
      .join(t(', '))
      .slice(0, 60)
const roomName = name.trim() === '' ? defaultName : name.trim()
const canCreate = !busy
  && created === undefined
  && !blocked
  && pickedBots.length > 0
  && roomName !== ''
```

- [ ] `create()` 的守卫改为 `if (!canCreate) return`。
- [ ] `workgroups.createRoom(roomName, { kind: 'workgroup', botIds: pickedBots.map(bot => bot.botId) })`。
- [ ] `bt-to-create` 与 `bt-nc-send` 的 `disabled` 均改为 `!canCreate`。
- [ ] `bt-to-create` 增加 `title`：无 Bot 时使用 `t('Add at least one Bot')`，否则沿用现有提示。
- [ ] 将空目录提示改为要求先发布 Bot：
  - 新 key：`You have no published Bots. Publish one before creating a workgroup.`
- [ ] 新增中文条目：
  - `Add at least one Bot` -> `请至少选择一个 Bot`
  - `You have no published Bots. Publish one before creating a workgroup.` -> `你还没有已发布的 Bot。请先发布一个再创建工作群。`
- [ ] 更新 `create.js` 顶部注释，不再声称名称必填。
- [ ] 测试：
  - Bot 单独选择、名称留空 -> 按钮启用；`createRoom` 收到 `You, Mine`（测试语言为英文）。
  - Bot + 邀请、名称留空 -> 按钮启用；邀请照常发出。
  - 只填名称、没有 Bot -> 按钮禁用。
  - 手填名称 -> 使用用户名称。
  - Hub 阻断状态仍禁用并显示原因。

#### Reason

当前直接根因是名称空值门禁；本轮已确认工作群最小集合为创建者 + 至少一个 Bot，名称可以静默生成。Hub 仍要求非空名称，所以生成必须发生在调用 Hub 之前。

#### Risk

- 自动名称可能在中文/英文语言环境不同；测试应使用当前 `t()` 输出。
- 自动名称可能超过客户端 60 字符，需要截断。
- 移除“仅名称创建”会与旧测试和旧提示冲突。
- 未加载完 Bot 目录时，`pickedBots` 为空；按钮应保持禁用。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```

重点断言：

- `createRoom` 调用参数非空。
- 生成名称不是日期格式。
- 未选择 Bot 时 `createRoom` 不被调用。
- 邀请失败路径仍只创建一次房间。

---

### Step 2: 详情/设置面板改为原群聊式 `bt-panel`

#### Target

- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js`
- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js`
- 测试：`application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
- 组件：`WorkgroupConversation`
- 新增本地状态：`panelWidth`、`resizing`
- 复用：`useLinger`、`SPRING_SHAPE`

#### Current Behavior

- 详情面板在 `.bt-wg-body` 内以 flex 侧栏渲染。
- 使用 `.bt-wg-panel` 自定义宽度和入场动画。
- 关闭时立即移除，没有退场。
- 不支持拖拽宽度。
- 会话头部不随面板平移。

#### Change

- [ ] 从 `../motion.js` 引入 `useLinger`；从 `../motion.js` 引入 `SPRING_SHAPE` 到 `styles.js`。
- [ ] 在 `WorkgroupConversation` 中增加：

```js
const [shownPanel, panelLeaving] = useLinger(panel, 300)
const [panelWidth, setPanelWidth] = useState(320)
const [resizing, setResizing] = useState(false)
```

- [ ] 增加面板宽度范围与 clamp helper：

```js
const PANEL_MIN = 320
const PANEL_MAX = 520
const MIN_CHAT = 420

const panelRange = () => {
  const high = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - MIN_CHAT))
  return [PANEL_MIN, high]
}

const clampPanel = (value, [low, high]) => Math.round(Math.max(low, Math.min(value, high)))
```

- [ ] 增加 `window.resize` 时的宽度收敛。
- [ ] 增加 `bt-panel-grip` 的 pointer drag：
  - pointerdown 记录起点和当前宽度；
  - pointermove 按 `startWidth + startX - clientX` 调整；
  - pointerup/pointercancel 清理监听并结束 `resizing`。
- [ ] 将 header + body 包入 `.bt-wg-surface`：

```js
h('div', {
  className: 'bt-wg-surface',
  'data-resizing': resizing || undefined,
  style: { marginRight: panel === null ? 0 : `${panelWidth}px` },
},
  h('div', { className: 'bt-head', ... }),
  h('div', { className: 'bt-wg-body', 'data-wg-details-shown': panel !== null || undefined },
    h('div', { className: 'bt-wg-main' }, ...)))
```

- [ ] 将面板移动到 surface 之后，改为：

```js
h('aside', {
  className: 'bt-panel bt-wg-panel',
  'aria-label': t('Group details'),
  'aria-hidden': panelLeaving || undefined,
  'data-leaving': panelLeaving || undefined,
  'data-dragging': resizing || undefined,
  style: { '--bt-panel-w': `${panelWidth}px` },
},
  panelLeaving ? null : h('div', {
    className: 'bt-panel-grip',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t('Resize panel'),
    'data-wg-panel-grip': 'true',
    onPointerDown: startResize,
  }),
  h('div', { className: 'bt-panel-view' }, shownPanel === 'settings' ? ... : ...))
```

- [ ] 保留 `data-wg-details`、`data-wg-settings`、`data-wg-details-close`、`data-wg-settings-back`、`data-wg-settings-close` 属性。
- [ ] 在 `styles.js`：
  - 删除 `.bt-wg-panel` 的固定宽度、边框、背景和 `bt-wg-panel-in` 动画。
  - 保留 `.bt-wg-panel` 作为工作群测试/定位钩子。
  - 增加：

```css
.bt-wg-surface {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  transition: margin-right ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing};
}
.bt-wg-panel[data-dragging],
.bt-wg-surface[data-resizing] {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .bt-wg-surface { transition: none; }
}
```

- [ ] 测试：
  - 打开详情后存在 `.bt-panel`、`.bt-wg-panel`、`.bt-panel-grip`、`.bt-panel-view`。
  - `style.getPropertyValue('--bt-panel-w')` 为 `320px`。
  - 关闭后等待退场，`.bt-wg-panel` 消失。
  - 设置 → Back → Close 仍工作。

#### Reason

旧实现只对齐了内部类名，没有对齐原群聊详情面板的外层行为。用户已明确指出详情要按原群聊样式和功能显示，因此本轮必须修复已记录的 flex 侧栏残余差异。

#### Risk

- `.bt-panel` 是 fixed 定位；工作群 `.bt-pane` z-index 为 45，面板必须处于同一层叠上下文，需真实 web 检查。
- `useLinger` 会让关闭测试需要等待，旧测试不能立即断言移除。
- 窄窗口面板可能挤压会话；需要 929×917、1280×820 和窄窗口检查。
- 拖拽期间必须关闭 margin/width 过渡，否则会滞后。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

并在 web 端检查：

- 面板打开/关闭动画；
- 拖拽宽度；
- 头部与消息区随面板平移；
- 设置切换不导致对话卸载。

---

### Step 3: 详情正文、分享和 Stop 映射

#### Target

- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/details.js`
- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/activity.js`
- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js`
- 文件：`application/packages/bundle/ds-bot/src/client/i18n.js`
- 测试：`a22-workgroup-ui.spec.ts`、`a16-workgroup-interactions.spec.ts`
- 组件：`WorkgroupDetails`、`MemberRows`、`TaskUsage`
- 函数：`isTaskActive`

#### Current Behavior

- 详情有公告、成员、Hub 状态、任务活动、群记忆。
- 顶部没有分享对话。
- Bot 成员行没有活动任务 Stop。
- 没有“谁应答/权限”的工作群落点。
- `usage` 参数从未传入，最后一行永远不渲染。
- `TaskUsage` 和任务活动都使用“Task activity”标题。

#### Change

##### `activity.js`

- [ ] 导出活动状态判断：

```js
export const isTaskActive = task => task !== undefined && !TERMINAL.includes(task.state)
```

- [ ] `TaskCard` 的 `cancellable` 改用 `isTaskActive(task)`。

##### `details.js`

- [ ] 从 `./activity.js` 引入 `isTaskActive`，并让 `TaskUsage` 使用它计算 open 数。
- [ ] `MemberRows` 接收 `tasks` 和 `onCancel`。
- [ ] 对每个 Bot 找第一个活动任务：

```js
const active = (tasks ?? []).find(task =>
  isTaskActive(task)
  && task.targetBotId === bot.botId
  && task.ownerUserId === bot.ownerUserId
)
```

- [ ] Bot 成员行显示 `Working`，并在有活动任务时渲染：

```js
h('button', {
  type: 'button',
  className: 'bt-member-stop',
  'data-wg-stop-bot': bot.botId,
  'aria-label': `${t('Stop')} · ${bot.displayName ?? bot.botId}`,
  onClick: () => onCancel?.(active),
}, t('Stop'))
```

- [ ] 人工成员保持 Online/Offline；Bot 行仍显示所有者。
- [ ] 在 Members 之后增加两组说明：

```js
h('div', null,
  h('div', { className: 'bt-section-title' }, t('Who answers')),
  h('div', { className: 'bt-muted', 'data-wg-who-answers': 'true' },
    t('No automatic answers. @ a Bot creates a task its owner approves.')))

h('div', null,
  h('div', { className: 'bt-section-title' }, t('Permissions')),
  h('div', { className: 'bt-muted', 'data-wg-permissions': 'true' },
    t('Each task runs only with the folder, tools, and lifetime its owner approves.')))
```

- [ ] 将 `TaskUsage` 标题由 `Task activity` 改为 `Usage`，保留任务总数、未完成数、已分享结果数。
- [ ] 删除 `WorkgroupDetails` 中永远为 `undefined` 的 `usage` 参数和最后一行 `usage` 渲染。
- [ ] 保留 Workgroup/Hub 状态、任务活动、群记忆和公告缺失链接。

##### `index.js`

- [ ] 在详情顶部齿轮和关闭之间加入分享按钮：

```js
h('button', {
  type: 'button',
  className: 'bt-round',
  'data-wg-share': 'true',
  'aria-label': copied ? t('Copied conversation') : t('Share conversation'),
  title: copied ? t('Copied') : t('Copy conversation as Markdown'),
  onClick: share,
}, copied ? h(CheckIcon) : h(ShareIcon))
```

- [ ] 用现有 `messages` 生成 Markdown：

```js
const transcript = (messages ?? []).map((message) => {
  const who = message.senderDisplayName ?? message.senderUserId ?? ''
  const files = (message.attachments ?? [])
    .map(entry => entry.fileName ?? entry.artifactId)
    .join(', ')
  return `**${who}:** ${message.body ?? ''}${files === '' ? '' : ` (${files})`}`
}).join('\n\n')
```

- [ ] `navigator.clipboard` 不可用时不能抛错；成功写入后显示 `CheckIcon`，1.6 秒后恢复。
- [ ] 新增中文条目：
  - `No automatic answers. @ a Bot creates a task its owner approves.` -> `工作群不会自动应答。@ Bot 只会生成任务，由 Bot 所有者审批。`
  - `Each task runs only with the folder, tools, and lifetime its owner approves.` -> `每个任务只能在 Bot 所有者批准的文件夹、工具和时限内运行。`

#### Reason

原群聊详情提供分享和成员停止；工作群必须提供等价入口。Stop 不能直接调用 `stopMemberWork`，必须映射到已有 `onCancel(task)`。

#### Risk

- 剪贴板 API 在 jsdom/无权限浏览器中可能不可用。
- 活动任务可能没有 `targetBotId`（待审批），此时不会显示 Bot Stop，任务卡仍负责取消/拒绝。
- 分享内容只包含当前工作群消息，不读取本地会话。
- `usage` 删除属于本次详情语义修正，不影响 `WorkgroupTasks` 数据。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

重点断言：

- 分享按钮存在并调用 clipboard。
- `data-wg-stop-bot` 点击调用 `onCancel(task)`。
- `data-wg-who-answers`、`data-wg-permissions` 存在。
- `Usage` 区块存在，任务活动仍存在。
- 设置入口、Back、Close 仍正常。

---

### Step 4: 消息正文结构与 Markdown 对齐

#### Target

- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js`
- 测试：`a22-workgroup-ui.spec.ts`、`a16-workgroup-interactions.spec.ts`（mock）
- 组件：`MessageLine`、`WorkgroupThread`

#### Current Behavior

- 消息正文直接渲染纯文本。
- 非本人消息把 `HumanFace` 放在发送者名称前。
- 原群聊非本人消息的 `bt-lead` 头像位于气泡左侧。

#### Change

- [ ] 从 `@deepseek-ai/dsh-client-ui-primitives` 引入 `MarkdownText`。
- [ ] 增加与原群聊一致的 labels：

```js
const mdLabels = () => ({
  code: { copyLabel: t('Copy'), copiedLabel: t('Copied') },
  footnotes: t('Footnotes'),
})
```

- [ ] 非本人消息：
  - `bt-group-name` 只保留名称；
  - `bt-msg-line` 内先渲染 `span.bt-lead` + `HumanFace`；
  - `bt-bubble` 内使用 `MarkdownText`。
- [ ] 本人消息的 `bt-ubody` 内也使用 `MarkdownText`。
- [ ] 保留引用、附件、图片、失败状态和回复按钮。
- [ ] 更新 a22/a16 的 `shell-primitives` mock，使 `MarkdownText` 渲染传入文本，而不是固定返回 `null`。

#### Reason

这是整体样式核对中最直接的消息结构差异；原群聊已使用 Markdown 和 lead 头像，工作群应复用同一套类名和渲染能力。

#### Risk

- `MarkdownText` 可能改变测试中的纯文本断言；需要更新 mock。
- 不复制 reaction、语音等无 Hub 数据源的能力。
- 连续同发送者消息的堆叠规则不在本步扩大范围。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
```

重点断言：

- 非本人消息存在 `.bt-lead`。
- 消息正文容器存在。
- 现有引用、附件、失败状态测试仍通过。

---

### Step 5: 回归、构建与 web 验收

#### Target

- 测试：`a22`、`a16`
- 产物：`application/packages/bundle/ds-bot/client.js`
- 验证产物：`application/packages/bundle/ds-bot/lib/client.js`（ignored，不提交）
- 文档：本计划 `Changed Files Tracking` / `Execution Log`

#### Current Behavior

- 旧测试固化了“名称必填”和旧 flex 面板。
- web 端加载 `lib/client.js`，不重建会看到旧 UI。

#### Change

- [ ] 更新 a22 创建工作群用例。
- [ ] 更新 a22 详情面板、分享、Stop、Usage、消息结构用例。
- [ ] 更新 a16 的 `MarkdownText` mock；若新增关闭等待，使用 `vi.waitFor`。
- [ ] 更新 i18n 中文条目。
- [ ] 运行测试、lint、i18n、build 检查。
- [ ] 重新生成 `client.js`。
- [ ] 进行 web 验收前运行 `node scripts/build-lib.mjs`。
- [ ] 更新本计划的 `Changed Files Tracking` 和 `Execution Log`。

#### Reason

现有测试和 bundle 仍对应旧行为；不更新无法证明新需求完成。

#### Risk

- `npm run typecheck` 的既有 Host Typert 失败可能掩盖本次 JS 变更问题；需单独报告。
- web profile 只有一个本地 Bot 时无法做原群聊并排对照；工作群主流程只需一个 Bot。
- `lib/client.js` 是 ignored 验证产物，不能混入提交。

#### Verification

```bash
cd application
npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts
npx vitest run integrations/workgroup/tests/a16-workgroup-interactions.spec.ts
node --test packages/bundle/ds-bot/test/i18n.test.js packages/bundle/ds-bot/test/workgroup-css.test.js
node scripts/build-client.mjs --check
npm run lint
npm run verify-client-ui-i18n
npm run typecheck
```

```bash
cd ..
git diff --check
```

构建提交产物：

```bash
cd application
node scripts/build-client.mjs
```

web 验收前：

```bash
cd application
node scripts/build-lib.mjs
```

启动 web（按项目现有命令）：

```bash
cd application
pnpm run start:web --no-open
```

web 验收至少覆盖：

- Bot-only + 空名称创建；
- Bot + 真人邀请 + 空名称创建；
- 名称留空生成非日期名称；
- 点击标题打开详情；
- 详情齿轮、分享、关闭；
- 设置 Back/Close；
- 活动任务 Stop；
- 消息 Markdown/lead 结构；
- 1280×820、929×917、深色/浅色、中文/英文、100%/125% 缩放；
- 原群聊并排对照（需要至少两个本地 Bot；若环境不满足，明确记录未执行）。

---

## 4. Changed Files Tracking

| File | Action | Change |
| ---- | ------ | ------ |
| `docs/plans/2026-10-18-workgroup-create-details-parity-implementation-plan.md` | Add | 本次正式执行计划与执行记录 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js` | Modify | 创建条件改为至少一个 Bot；空名称按成员静默生成；仅名称不可创建 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/index.js` | Modify | 详情/设置改为 `bt-panel`；宽度拖拽；关闭退场；分享对话 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/details.js` | Modify | 成员 Stop 映射任务取消；谁应答/权限/Usage；移除死 `usage` 参数 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/activity.js` | Modify | 导出 `isTaskActive`，任务卡和详情共用活动判断 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/thread.js` | Modify | 非本人消息 `bt-lead`；消息正文 `MarkdownText` |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/styles.js` | Modify | 工作群 surface 平移；面板拖拽态；附件 input 不拦截 composer；本人消息 Markdown 颜色 |
| `application/packages/bundle/ds-bot/src/client/i18n.js` | Modify | 新增创建、详情中文文案 |
| `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | Modify | 创建、面板、分享、Stop、详情说明、Markdown 结构测试 |
| `application/integrations/workgroup/tests/a16-workgroup-interactions.spec.ts` | Modify | 更新 Markdown mock，保持既有交互回归 |
| `application/packages/bundle/ds-bot/client.js` | Modify | 重新生成提交用浏览器 bundle |
| `application/packages/bundle/ds-bot/lib/client.js` | Modify | 仅 web 验证重建的 ignored 产物，不进入提交 |

说明：工作区仍包含本次开始前已有的未提交改动（`overlays.js`、`workgroup-pane.js`、`workgroup-sidebar.js`、`workgroup-status.js`、`workgroup-ui/settings.js`、`test/i18n.test.js`、旧计划文档等）。这些文件本轮未再修改，也不属于本次实际变更。

验证截图位于 `output/playwright/`：

- `workgroup-create-bot-only-2026-10-18.png`
- `workgroup-created-bot-only-2026-10-18.png`
- `workgroup-details-2026-10-18.png`
- `workgroup-settings-2026-10-18.png`
- `workgroup-bot-invite-failure-2026-10-18.png`
- `workgroup-markdown-message-2026-10-18.png`
- `workgroup-message-1280x820-2026-10-18.png`
- `workgroup-details-1280x820-2026-10-18.png`
- `workgroup-details-1280x820-final-2026-10-18.png`
- `workgroup-details-dark-2026-10-18.png`
- `workgroup-details-dark-125-2026-10-18.png`
- `workgroup-details-dragged-420-2026-10-18.png`

---

## 5. Verification Checklist

### 主流程

- [x] 三个创建入口保持同一创建面（a04 6/6）。
- [x] 选择一个 Bot、名称留空，创建按钮启用（a22 + web）。
- [x] 创建请求名称非空、不是日期名称、`botIds` 正确（a22；web 创建为 `你、Chief`）。
- [x] 创建成功后创建者是 owner，Bot 出现在成员列表（web 详情实测）。
- [x] 点击标题打开详情，再次点击关闭（a22 + web）。
- [x] 详情齿轮打开设置，Back 回详情，Close 关闭面板（a22 + web）。

### 关联流程

- [x] Bot + 真人邀请 + 空名称可以创建，邀请在房间创建后发出（a22；web 使用不存在的 user id 验证了房间先创建、邀请失败可见）。
- [x] 邀请失败时仍打开工作群，房间只创建一次（a22 + web）。
- [x] 详情分享按钮存在并复制当前工作群消息（a22 clipboard mock）。web 按钮可见，但 headless 浏览器未提供可验证的 clipboard 写入结果。
- [x] Bot 活动任务 Stop 调用 `onCancel(task)`，不调用本地 `stopMemberWork`（a22）。web 未创建活动任务，未做真实 Stop 点击。
- [x] 群记忆搜索、新增、修正、删除不受面板变化影响（既有 a16/a22 回归通过）。
- [x] 任务审批、取消、复核、分享仍调用原 Hub 动作（既有 a16 回归通过）。
- [x] 设置内名称、公告、成员、Bot、侧栏、解散/离开不变（a16 + web 设置页实测）。

### 边界情况

- [ ] 名称只有空白字符、Bot 显示名为空、自动名称超过 60 字符：代码路径存在，但未新增独立自动化用例。
- [x] 未选择 Bot，只填写名称，按钮禁用（a22）。
- [x] Hub 未配置/未登录/离线/重连/被拒绝时禁止创建（既有 a22 Hub 状态用例）。
- [ ] Bot 目录加载失败时错误可见：未新增独立用例。
- [ ] 窄窗口（小于 929px）未单独截图；1280×820 和 125% 已检查。
- [x] 剪贴板不可用时不崩溃（web 点击分享无异常；a22 mock 路径通过）。
- [x] 详情打开时任务完成或取消的既有任务卡交互仍通过 a16。

### Test

- [x] `a22-workgroup-ui.spec.ts`：32/32 通过。
- [x] `a16-workgroup-interactions.spec.ts`：20/20 通过。
- [x] 工作群客户端回归：11 个文件，130/130 通过。
- [x] `i18n.test.js`、`workgroup-css.test.js`：7/7 通过。
- [x] `verify-client-ui-i18n`：通过，1044 个 Client UI source file。

### Build

- [x] `node scripts/build-client.mjs --check`：`BUILD_OK`。
- [x] `node scripts/build-client.mjs`：已重新生成 `client.js`。
- [x] `node scripts/build-lib.mjs`：已重新生成 ignored 的 `lib/client.js`，用于 web 验收。

### Lint

- [ ] `npm run lint`：未通过，阻塞点是既有 Host Typert 的 `permission-presets/lib/types/types.d.ts` 路径问题，不是本次 JS 文件。
- [x] 变更文件定向 `run-oxlint.ts`：0 errors，2 个既有 warnings（`thread.js` 的字符串 spread、`create.js` 的既有模板表达式）。
- [x] `npm run verify-client-ui-i18n`：通过。
- [x] `git diff --check`：通过。

### Typecheck

- [x] `npm run typecheck` 已执行。
- [x] 结果仍为既有 Host Typert 失败（`permission-presets` 路径）；host compiler 和 host aggregate check 通过，client compiler gates 因依赖失败跳过。未声称 typecheck 通过。

### Web 验收

- [x] web 端使用真实临时 Hub 创建 Bot-only 工作群，名称为 `你、Chief`。
- [x] web 端创建 Bot + 邀请工作群；不存在的邀请对象返回 `404 NO_SUCH_USER`，房间已创建并打开，同时显示失败提示。
- [x] web 端检查详情、设置、Back、关闭、分享按钮、面板拖拽（320→420px）。
- [x] web 端检查消息 Markdown；`**bold** message` 渲染为 `<strong>bold</strong> message`，本人气泡文字颜色修复为白色。
- [x] 1280×820、深色、125% 缩放截图完成；英文界面和更窄窗口未验证。
- [ ] 原群聊并排对照未执行：当前 web profile 仍只有 Chief 一个本地 Bot，无法创建原群聊所需的管理员 + 成员组合。

---

## 6. Execution Log

### Step 1 Completed

- Modified:
  - `workgroup-ui/create.js`
  - `client/i18n.js`
  - `a22-workgroup-ui.spec.ts`
- Changes: 创建条件改为至少一个 Bot；空名称生成 `You, <Bot...>`；仅名称不可创建；无 Bot 提示改为先发布 Bot。
- Reason: 修复“选择 Bot 后创建按钮仍禁用”，并对齐本轮确认的最小创建集合。
- Verification: 先确认 4 个创建测试 RED；实现后 creation 用例 11/11 通过。

### Step 2 Completed

- Modified:
  - `workgroup-ui/index.js`
  - `workgroup-ui/styles.js`
  - `a22-workgroup-ui.spec.ts`
- Changes: 详情/设置改为 `bt-panel bt-wg-panel`；加入拖拽手柄、320–520px 宽度、关闭退场和 surface 平移。
- Reason: 对齐原群聊详情外部面板行为，消除既有的 flex 侧栏残余差异。
- Verification: 面板用例先 RED，后 GREEN；`a22` 29/29 通过。

### Step 3 Completed

- Modified:
  - `workgroup-ui/activity.js`
  - `workgroup-ui/details.js`
  - `workgroup-ui/index.js`
  - `client/i18n.js`
  - `a22-workgroup-ui.spec.ts`
- Changes: 分享对话；Bot 活动任务 Stop；谁应答/权限说明；Usage；移除死 `usage` 参数。
- Reason: 补齐原群聊详情的可见功能和 Stop 的工作群任务映射。
- Verification: 3 个新增用例先 RED；`a22` + `a16` 52/52 通过。

### Step 4 Completed

- Modified:
  - `workgroup-ui/thread.js`
  - `workgroup-ui/styles.js`
  - `a22-workgroup-ui.spec.ts`
  - `a16-workgroup-interactions.spec.ts`
- Changes: 非本人消息恢复 `bt-lead`；消息正文 `MarkdownText`；更新测试 primitive mock。
- Reason: 对齐原群聊消息结构，并修复本人 Markdown 颜色继承。
- Verification: 消息用例先 RED；`a22` + `a16` 52/52 通过。

### Step 5 Completed

- Modified:
  - `client.js`
  - `lib/client.js`（ignored）
  - 本计划文档
- Changes: 回归、bundle 构建、web 验收；修复 composer 附件 input 拦截点击和本人 Markdown 文字颜色。
- Reason: 完成执行计划的全部门禁与 visible web behavior。
- Verification:
  - 工作群客户端 11 文件 130/130。
  - i18n/CSS 7/7。
  - `build-client.mjs --check` BUILD_OK。
  - `verify-client-ui-i18n` 通过。
  - 变更文件定向 oxlint 0 errors。
  - web 真实 Hub 创建、详情、设置、分享按钮、拖拽、Markdown、深色和 125% 缩放已验证。
  - `npm run typecheck` 仍为既有 Host Typert 基线失败。

---

## 7. Plan Adjustment

### Adjustment 1: composer 附件 input 覆盖发送按钮

- 原计划：未包含 composer CSS 的点击层级检查。
- 新发现：web 实测中 `.bt-wg-attach-input` 使用 `inset:0` 覆盖 composer，拦截发送按钮点击。
- 为什么需要调整：不修复则消息无法通过鼠标发送，阻塞主流程和 Markdown web 验收。
- 新增修改范围：仅在已列入 Plan 的 `workgroup-ui/styles.js` 增加作用域规则，令附件 input 为 1px、`opacity:0`、`pointer-events:none`。

### Adjustment 2: 本人 Markdown 气泡颜色

- 原计划：消息正文改用 `MarkdownText`，但未说明 shell Markdown 的默认颜色。
- 新发现：`MarkdownText` 自带 `rgba(20,20,20,.6)`，覆盖 `.bt-ubody` 的白色文字，导致深色发送气泡不可读。
- 为什么需要调整：这是 Step 4 的直接视觉回归，必须修复后才能完成 web 验收。
- 新增修改范围：在 `workgroup-ui/styles.js` 让 `.bt-ubody` 内 markdown 继承气泡颜色和字号。

### Adjustment 3: 验证环境 Hub 地址覆盖

- 原计划：通过 `WORKGROUP_HUB_URL` 启动 web。
- 新发现：Host 优先读取持久化 `installation.json.hubUrl`，首次启动仍指向 `https://hub.example/api/v1`，导致状态为“已配置，尚未登录”。
- 为什么需要调整：需要临时把 Host state 指向临时 Hub，才能进行真实创建验收。
- 新增修改范围：仅临时修改本机 Host `installation.json`，验收后已恢复原值；未修改源码或提交环境配置。

### Adjustment 4: 基线门禁

- `npm run lint` 在 Host Typert 生成阶段因既有 `permission-presets` 路径失败；变更文件定向 oxlint 为 0 errors。
- `npm run typecheck` 同样因既有 Host Typert 失败；未修改无关配置，未声称通过。

---

## 8. Approval Gate

用户已批准 Coding。本次执行完成，等待验收确认；未提交、未推送。
