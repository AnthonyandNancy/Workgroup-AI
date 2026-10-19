# 工作群建群主持管理员（自动生成）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:executing-plans` 逐 Step 执行本计划。步骤用 checkbox（`- [ ]`）追踪状态；中断后按「## 4. Changed Files Tracking」与「## 5. Verification Checklist」恢复。

**Goal:** 修复「点击创建工作群聊 → 400 `NOT_A_CHIEF_BOT`」，让建群的主持管理员 Bot 由 Hub 按原群聊口径**自动生成**，并在表单侧提前拦住必然失败的组合。

**Architecture:** 服务端 `resolveLeader()` 承担与原群聊 `roster.createRoom` 相同的缺省规则（`members.find(rt.isMain)`），成为唯一裁决点。客户端表单不新增「选主持」步骤（原群聊建群也没有这一步），只用目录里已有的 `isChief` 做**可创建性判断**与**管家 Bot 标记**。不新增路由、不改传输层。

**Tech Stack:** Node.js 24 + Fastify + SQLite（WAL）；React 18 `h()`（无 JSX）；Node test runner（`node --test`）、Vitest（integration specs）、esbuild 客户端打包。

## Global Constraints

- 需求基线：`docs/requirements/workgroup-parity-requirement.md`（功能 1、R5、R6、R7、R8、R10）。
- **原群聊代码零改动**：`client/new-chat.js`、`client/group-settings.js`、`client/sidebar.js`、`client/cells.js`、`host/groups.js`、`host/roster.js`、`client/styles.js`。工作群只改复制件。
- 不新增顶层代码边界：只有 `application/` 与 `server/`。
- 不做与本次缺陷无关的重构；不改 `createRoom` 的事务体；不新增抽象。
- 所有用户可见文案必须经 `t()`，并在 `src/client/i18n.js` 添加中文条目（`test/i18n.test.js` 会强制校验）。
- 修改 `src/client` 后必须重新生成 `application/packages/bundle/ds-bot/client.js`。
- 服务端测试命令：`node --test "tests/*.test.js"`（在 `server/` 下，不要写 `node --test tests/`）。
- ds-bot 测试命令：`npm test`（在 `application/packages/bundle/ds-bot/` 下）。
- integration 测试命令：在 `application/` 下 `npx vitest run --config vitest.config.ts integrations/workgroup/tests/<spec>`。
- 未获用户明确指示，不 commit、不 push。
- **已知基线失败（非本次引入，不作为判据）**：`server/tests/e-mention-attachment.test.js` 2 条、`e1-dispatch-signing` 7 条、`d-dissolve` 1 条、`h09-grants` 22 条、ds-bot `without a running version there is nothing to compare against`、`pnpm run typecheck` 的 typert 路径、`h02`/`memory` 在 Windows 上的偶发 EPERM。
- **本缺陷的现状证据**：`a12-hub-provider-e2e.host.spec.ts` 三个用例当前实测 **3 failed**（`400 INVALID_BOT_COUNT`），它们是同一缺陷的另一受害者，本计划负责修好。

## 已确认口径（用户本轮确认，2026-10-20）

1. **工作群关于 Bot 的建群条件与原群聊完全一致，不存在特例。** 原群聊 `roster.js:278 checkMembers` 要求 `members.length >= 2`；工作群的 `resolveLeader` 同样以 ≥2 Bot 为前提（`INVALID_BOT_COUNT`）。这两条是同一个规则，不是需要裁决的矛盾。
2. **同事与同事的 Bot 可以后面邀请。** 建群时只要求创建者自己的 ≥2 个 Bot（其中一个必须是已发布的管家 Bot）；真人成员与其他成员的 Bot 一律通过既有邀请/接受流程后补（R8，已实现，本次仅回归验证）。建群不因「没有邀请同事」而受任何影响。
3. **Hub 侧的主持人目前先自动生成。** 表单不新增「选主持」步骤，`adminBotId` 由 Hub 按原群聊缺省口径自动确定：取 `botIds` 中第一个 `is_chief=1` 的 Bot（对应原群聊的 `members.find(rt.isMain)`，顺序口径见 Step 1）。显式传 `adminBotId` 仍然支持并仍然受校验（既有测试与 `tests/helpers/workgroup.js` 依赖它），只是 UI 不再需要传。

## 不在本次范围

- `createRoom` 未校验「每位成员至多 1 个管家 Bot」（R10）。`assertMemberBotQuota` 只覆盖加入/邀请/接受三条路径，建群路径没有这道检查。属于既有缺口，本次不顺手改，列入 Remaining Risks。
- 建群后主持 Bot 的开场问候（设计里的 kickoff）：`workgroup-turns.js` 目前只处理 `message.created`，没有 kickoff。属于另一个需求点，本次不做。
- `resolveNewLeader`（`store.js:523` 起）是「主持移交」路径，语义不同，不动。
- 客户端不再新增任何「谁是主持」的选择控件（原群聊建群也没有这一步）。

---

# 1. Goal

**本次修改目标**

1. 点击「创建工作群聊」不再报 `400 NOT_A_CHIEF_BOT`：主持管理员 Bot 由 Hub 自动生成，与原群聊一致。
2. 服务端在调用方没给 `adminBotId` 时，按原群聊缺省口径取 `botIds` 里第一个 `is_chief=1` 的 Bot，而不是直接拒绝；显式指定仍照旧校验。
3. 表单在提交前就拦住两种必然失败的组合（Bot 少于 2 个、没有管家 Bot），并说明原因——条件与原群聊 `checkMembers` 等价。
4. 候选列表让用户看得见「哪个 Bot 会主持」。

**不包含**

- 不改 `createRoom` 的事务体、审计字段、`reply_mode` 取值逻辑。
- 不新增 Hub 路由、不改 `host/channel.js` 白名单、不改 `workgroup-hub.js` 的透传。
- 不新增「选主持 Bot」的 UI 步骤，不改建群表单的字段结构（仍是名称 + 自己的 Bot + 可选邀请）。
- 不实现 kickoff 开场、不实现建群路径的管家 Bot 配额校验。
- 不改 `PATCH /rooms/:id`（主持移交）与 `dissolveRoom`。

**成功标准**

- 选「2 个 Bot 且其中一个是自己的管家 Bot」→ 建群成功（201），`room.adminBotId` 自动等于该管家 Bot，`room.replyMode === 'admin'`；表单不发送 `adminBotId`。
- 选 1 个 Bot → 表单 submit 禁用并给出原因；绕过表单直接调 Hub → `400 INVALID_BOT_COUNT`（与原群聊「至少两个」同一口径）。
- 选 2 个普通 Bot（无管家）→ 表单 submit 禁用并给出原因；绕过表单 → `400 NOT_A_CHIEF_BOT`。
- 不传 `adminBotId` 但 `botIds` 里有管家 Bot → 201，主持人自动确定。
- 建群时不邀请任何同事 → 正常建群；建群后邀请同事与其 Bot 仍走既有流程（回归验证）。
- `a12-hub-provider-e2e.host.spec.ts` 三条由红转绿。

---

# 2. Current Understanding

## 2.1 当前实现（真实调用链）

```
workgroup-ui/create.js  WorkgroupCreate
  ├─ workgroups.directory({ownerUserId})          → hub-directory
  │    → client/workgroup-hub.js:154 invoke('hub-directory')
  │    → host/workgroup-hub.js:789 case 'hub-directory'
  │    → integrations/workgroup/client/index.mjs:41 publishedBots
  │    → GET /bots/directory → server/src/api/bots.js:106 browseDirectory
  │    → publicEntry()（含 isChief，bots/store.js:274）
  │    ← 表单目前只读 displayName / botId / ownerUserId，丢弃 isChief
  │
  └─ 点「创建」→ workgroups.createRoom(name, {kind:'workgroup', botIds})
       → client/workgroup-hub.js:154 invoke('hub-create-room', {name, kind, botIds})
       → host/channel.js:248 case 'hub-create-room'
       → host/workgroup-hub.js:676 case 'hub-create-room'
       → client.request('POST', '/rooms', {name, kind, botIds})
       → server/src/api/rooms.js:113 createRoom(db, {..., adminBotId: body.adminBotId})
       → server/src/modules/rooms/store.js:277 createRoom
            ├─ botIds → bot_directory 查 is_chief 快照（store.js:287）
            ├─ resolveLeader({joiningBots, adminBotId})  store.js:253
            │    ├─ joiningBots.length < 2 → INVALID_BOT_COUNT
            │    └─ named === '' → NOT_A_CHIEF_BOT   ← 用户看到的报错
            └─ 事务：rooms(reply_mode/admin_bot_*) + room_members(owner) + room_bots(is_chief) + audit
```

对照原群聊（本地群，无 Hub）：

```
client/new-chat.js makeGroup  → actions.createRoom([admin, ...picked], {admin, greet})
host/roster.js:283 createRoom
  ├─ checkMembers(members)                        members.length < 2 → 'A group chat needs at least two Bots'
  └─ adminId = admin !== undefined ? admin
        : (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)
```

原群聊在调用方不指定 admin 时**自动取首个 Main Bot**，从不报错。工作群的 `resolveLeader` 缺的正是这条缺省分支。

## 2.2 涉及模块

| 层 | 文件 | 与本缺陷的关系 |
|---|---|---|
| 服务端裁决 | `server/src/modules/rooms/store.js` | `resolveLeader` 是唯一抛出点 |
| 服务端路由 | `server/src/api/rooms.js` | 已透传 `body.adminBotId`，无需改 |
| 契约 | `server/contracts/openapi.yaml` | `adminBotId` 描述写「必填」，与自动生成不一致 |
| Host 透传 | `src/host/workgroup-hub.js`、`src/host/channel.js` | `{...options}` 透传，无需改 |
| Client 透传 | `src/client/workgroup-hub.js` | `{...options}` 透传，无需改 |
| Client 表单 | `src/client/workgroup-ui/create.js` | **缺陷本体**：不要求 ≥2 Bot、不识别管家 |
| i18n | `src/client/i18n.js` | 新文案需要中文条目 |
| 测试 | `server/tests/h17-*.test.js`、`integration a22`、`integration a12` | h17/a22 把缺陷写法钉成了断言；a12 当前红 |

## 2.3 已确认的影响范围

- **只有一处**需要改业务逻辑（`resolveLeader`），**只有一处**需要改 UI（`create.js`）。
- 三个建群入口（新建菜单 / 设置页群聊页 / 命令面板）全部收敛到同一个 `WorkgroupCreate`（`overlays.js:62`），所以只改一处 UI。
- `isChief` 已在目录响应里，UI 修复不需要任何新数据通道。
- 建群请求的 payload **形状不变**（仍是 `{kind, botIds}`），所以 `a11` 的桥透传断言不需要改。

---

# 3. Implementation Steps

### Step 1: `resolveLeader` 落地自动生成（对齐原群聊 `members.find(rt.isMain)`）

#### Target
- 文件：`server/src/modules/rooms/store.js`
- 函数：`resolveLeader({ joiningBots, adminBotId })`（第 253–266 行），含上方 JSDoc（第 240–252 行）

#### Current Behavior
```js
function resolveLeader({ joiningBots, adminBotId }) {
  if (joiningBots.length < 2) {
    throw new RoomError('A workgroup needs at least two Bots: the owner\'s Main Bot and one more', 'INVALID_BOT_COUNT')
  }
  const named = typeof adminBotId === 'string' ? adminBotId.trim() : ''
  if (named === '') {
    throw new RoomError('A workgroup needs an administrator: name the owner\'s Main Bot', 'NOT_A_CHIEF_BOT')
  }
  const leader = joiningBots.find(entry => entry.bot_id === named)
  if (leader === undefined || leader.is_chief !== 1) {
    throw new RoomError('The workgroup administrator must be your own Main Bot and must join the room', 'NOT_A_CHIEF_BOT')
  }
  return leader
}
```
未传 `adminBotId` 一律拒绝，即使 `botIds` 里就有管家 Bot。原群聊在同一种情况下是自动取首个 Main Bot，从不拒绝。

#### Change
显式指定与自动生成两条分支分开；自动生成取 `botIds` 顺序里第一个 `is_chief === 1` 的成员；一个都没有才报错，并把消息改成可执行的动作说明。

```js
/**
 * The Bot that leads a new workgroup, or throw.
 *
 * The same two rules the original group chat has, applied to a Hub room: at least two Bots, and a
 * leader among them that is its owner's Main Bot (`roster.createRoom`'s `checkMembers` and
 * `members.find(rt.isMain)`). The standing is read from what the owner's machine reported, which is
 * what makes "the leader is the group owner's administrator" a checked fact rather than a claim.
 *
 * The leader is *generated* when the caller names none, exactly as a local group picks its first
 * Main Bot: the UI has no "choose the administrator" step, so requiring one here would make every
 * workgroup a 400. `adminBotId` stays supported — and stays validated — for callers that do know
 * which Bot should lead, such as a later hand-over or a script.
 *
 * @param {{ joiningBots: object[], adminBotId?: string }} options
 * @returns the directory row of the leading Bot
 * @throws {RoomError} `INVALID_BOT_COUNT` below two Bots, `NOT_A_CHIEF_BOT` when the named leader is
 *   absent or not a Main Bot, or when no Main Bot is joining at all.
 */
function resolveLeader({ joiningBots, adminBotId }) {
  if (joiningBots.length < 2) {
    throw new RoomError('A workgroup needs at least two Bots: the owner\'s Main Bot and one more', 'INVALID_BOT_COUNT')
  }
  const named = typeof adminBotId === 'string' ? adminBotId.trim() : ''
  if (named === '') {
    const chief = joiningBots.find(entry => entry.is_chief === 1)
    if (chief === undefined) {
      throw new RoomError('A workgroup needs your Main Bot in it: publish one, then add it to this workgroup', 'NOT_A_CHIEF_BOT')
    }
    return chief
  }
  const leader = joiningBots.find(entry => entry.bot_id === named)
  if (leader === undefined || leader.is_chief !== 1) {
    throw new RoomError('The workgroup administrator must be your own Main Bot and must join the room', 'NOT_A_CHIEF_BOT')
  }
  return leader
}
```

`createRoom`（第 277 行起）与事务体（第 300–340 行）**一行不动**：`leader` 的语义、`reply_mode` 取值、`admin_bot_*` 写入、审计字段全部沿用现有代码。

#### Reason
原群聊在同一种情况下自动取首个 Main Bot（`roster.js:289`），工作群却把「没指定」当成不合法——这既是缺陷的直接原因，也与「工作群建群条件与原群聊一致」的口径相悖。UI 没有选主持的步骤，所以这条缺省分支不是可选优化，而是建群能成功的必要条件。

#### Risk
- `h17` 现有用例 `a workgroup needs two Bots and its creator's own Main Bot as leader` 的第二段（`botIds:['chief','worker']` 无 `adminBotId` → 期望 `NOT_A_CHIEF_BOT`）语义会反转，必须同步改写（Step 4），否则该套件会红。
- 错误优先级不变：`INVALID_BOT_COUNT` 仍在最前，所以「1 个 Bot + 无 adminBotId」仍报 `INVALID_BOT_COUNT`——与原群聊 `checkMembers` 先于 admin 解析的顺序一致。
- 自动生成的顺序口径是 `botIds` 顺序，不是本地 `mainBotIds` 顺序。Hub 看不到客户端的本地顺序，`botIds` 是它唯一掌握且可测的顺序；原群聊的 `members.find(rt.isMain)` 也是按传入的 `members` 顺序，语义相同。
- 显式 `adminBotId` 的行为完全不变：`tests/helpers/workgroup.js`、`h17` 的多条用例、真实调用方都继续走原分支。

#### Verification
```bash
cd server && node --test tests/h17-workgroup-v2-schema.test.js
```
Step 4 完成后此处应全绿。Step 1 单独完成时该文件第 115 行用例的第 2 段会失败，属预期。

---

### Step 2: 建群表单按原群聊口径前置拦截，并标出管家 Bot

#### Target
- 文件：`application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js`
- 组件：`WorkgroupCreate`
- 关注行：`99-104`（`roomName` / `canCreate`）、`141-155`（`create`）、`210-230`（候选列表渲染）、`236-246`（提示与输入区）

#### Current Behavior
```js
const roomName = name.trim() === '' ? defaultName : name.trim()
const canCreate = !busy
  && created === undefined
  && !blocked
  && pickedBots.length > 0        // 单 Bot 也放行
  && roomName !== ''
```
```js
room = await workgroups.createRoom(roomName, { kind: 'workgroup', botIds: pickedBots.map(bot => bot.botId) })
```
候选行只渲染 `BotMark` + 名字 + 「Added」，`isChief` 被丢弃。表单允许单 Bot 建群，而 Hub 会拒（`INVALID_BOT_COUNT`）——原群聊的表单在这一点上是提前拦住的（`checkMembers`），工作群没有。

#### Change

**(a) 算出哪个 Bot 会主持（仅用于拦截与标记，不参与请求），与 Hub 自动生成同口径**

在 `roomName` 之后、`canCreate` 之前插入：

```js
  // Which Bot the Hub will pick as administrator, computed with the same rule it uses: the first
  // Main Bot in the order the user added them. The form does not send it — the Hub generates it, as
  // a local group does — but knowing it here is what lets the button be disabled with a reason
  // instead of the click ending in a 400.
  const leaderBotId = pickedBots.find(bot => bot.isChief === true)?.botId
  // The two conditions the Hub checks, asked here first. They are the original group chat's own
  // two conditions: at least two Bots, and a Main Bot among them.
  const missingLeader = pickedBots.length > 0 && leaderBotId === undefined
  const missingSecondBot = pickedBots.length === 1
```

**(b) `canCreate` 追加两个条件**

```js
  const canCreate = !busy
    && created === undefined
    && !blocked
    && pickedBots.length >= 2
    && leaderBotId !== undefined
    && roomName !== ''
```

**(c) `create()` 的 payload 不变**

`adminBotId` **不加**。在既有注释后补两行说明，避免后来者以为漏了：

```js
      // The room and the creator's chosen Bots are one Hub transaction: a room that exists without
      // the Bots it was created with would be a half-made workgroup. Invitations are separate by
      // nature — they are pending until each colleague accepts.
      // No `adminBotId`: the Hub generates the leader from `botIds` the way a local group takes its
      // first Main Bot. Naming it here would duplicate a rule the Hub already owns.
      room = await workgroups.createRoom(roomName, { kind: 'workgroup', botIds: pickedBots.map(bot => bot.botId) })
```

**(d) 候选行标出管家 Bot**

候选按钮内、「Added」之前插入一行（`.bt-option-hint` 样式已存在于 `client/styles.js:288`，不新增 CSS）：

```js
            bot.isChief === true ? h('span', { className: 'bt-option-hint', 'data-wg-create-chief': bot.botId }, t('Main Bot')) : null,
```
`'Main Bot'` 是既有 key（`i18n.js:9`），不重复定义。

**(e) 两种拦截原因可见**

在既有 `blockedReason / error` 两条提示之后追加一条（沿用 `.bt-error`，用 `role="status"` 与 `data-wg-create-blocked` 区分，避免与 Hub 状态提示、请求失败提示混淆）：

```js
      missingLeader || missingSecondBot
        ? h('div', { className: 'bt-error', role: 'status', 'data-wg-create-blocked': missingLeader ? 'leader' : 'second-bot' },
          missingLeader
            ? t('This workgroup needs a Main Bot to lead it. Publish one and add it here.')
            : t('A workgroup needs at least two Bots: your Main Bot and one more.'))
        : null,
```

**(f) 按钮 `title` 说明补齐**

两个提交按钮现有 `title: pickedBots.length === 0 ? t('Add at least one Bot') : undefined` 改为按三种情况给出原因：

```js
          title: pickedBots.length === 0
            ? t('Add at least one Bot')
            : (missingLeader
                ? t('This workgroup needs a Main Bot to lead it. Publish one and add it here.')
                : (missingSecondBot ? t('A workgroup needs at least two Bots: your Main Bot and one more.') : undefined)),
```
（`data-wg-create-send` 的圆形按钮同样处理。）

不新增状态、不改 `picked` 的数据结构、不改邀请流程、不新增任何选择主持的控件。

#### Reason
Hub 的规则是「≥2 Bot + 一个管家 Bot」，原群聊的表单也在提交前就守这两条。工作群表单只守了「至少一个」，所以用户点下去必然吃一个后端错误。把同一规则前置到按钮，是与原群聊对齐的最小做法，且完全不需要新增字段。

#### Risk
- `a22` 现有 6 条用例依赖「1 个 Bot 也能建」，会红，Step 5 改写。
- `pickedBots` 由 `picked` 顺序驱动；`leaderBotId` 只用于本地判断，不参与请求，所以与 Hub 的自动生成不可能因顺序不同而分歧（两边都是「顺序里第一个管家」）。
- 若目录返回的 `isChief` 缺失（旧 Hub），`leaderBotId` 为 `undefined`，按钮禁用并提示「需要一个管家 Bot」。这是正确的保守行为，不会静默建出无主持的群。
- payload 形状不变 ⇒ `a11-hub-provider.spec.ts` 的 `calls[0].payload` 断言不需要改。

#### Verification
```bash
cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```
Step 5 完成后应全绿。

---

### Step 3: `i18n.js` 补中文条目

#### Target
- 文件：`application/packages/bundle/ds-bot/src/client/i18n.js`
- 位置：`DICTIONARY.zh` 对象内，按字母序插入到既有条目附近

#### Current Behavior
`'This workgroup needs a Main Bot to lead it. Publish one and add it here.'` 与 `'A workgroup needs at least two Bots: your Main Bot and one more.'` 都不存在（已 grep 确认；近似但不同的既有 key 是 `'A group chat needs at least two Bots'`、`'Add a Bot first: a group chat needs at least two.'`，不复用、不冲突）。`test/i18n.test.js` 的 `every literal the client translates has a Chinese entry` 会失败。

#### Change
在第 1082 行 `'You have no published Bots. …'` 附近按字母序插入两条：

```js
  'A workgroup needs at least two Bots: your Main Bot and one more.': '工作群至少需要两个 Bot：你的主 Bot，再加一个。',
```
```js
  'This workgroup needs a Main Bot to lead it. Publish one and add it here.': '这个工作群需要一个主 Bot 来主持。请先发布一个，再把它加进来。',
```

`'Main Bot'` 复用既有条目（第 9 行），不新增。

#### Reason
`Global Constraints` 要求所有用户可见文案经 `t()` 并有中文条目；`test/i18n.test.js` 强制校验，缺条目即红。

#### Risk
无。纯新增 key，不改既有条目。注意不要重复添加 `'Main Bot'`（曾因重复 key 触发 esbuild `Duplicate key` 警告）。

#### Verification
```bash
cd application/packages/bundle/ds-bot && node --test test/i18n.test.js
```
期望 PASS。

---

### Step 4: `h17` 补自动生成用例并改写受影响断言

#### Target
- 文件：`server/tests/h17-workgroup-v2-schema.test.js`
- 用例：`a workgroup needs two Bots and its creator's own Main Bot as leader`（第 115–139 行）

#### Current Behavior
第 125–127 行把「不传 `adminBotId`」钉成 `NOT_A_CHIEF_BOT`：
```js
    const noLeader = await workgroup(alice, { botIds: ['chief', 'worker'] })
    assert.equal(noLeader.status, 400, noLeader.raw)
    assert.equal(noLeader.body.error.code, 'NOT_A_CHIEF_BOT')
```

#### Change
把该段替换成「自动生成首个管家 Bot」，并新增一条「一个管家 Bot 都没有」的用例；文件现有 12 个 `test(`，改后 13 个。

```js
test('a workgroup needs two Bots and generates its leader from the creator\'s Main Bot', async () => {
  await withHub(async ({ person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')

    // The original group chat's first condition, unchanged: two Bots or no group.
    const alone = await workgroup(alice, { botIds: ['chief'], adminBotId: 'chief' })
    assert.equal(alone.status, 400, alone.raw)
    assert.equal(alone.body.error.code, 'INVALID_BOT_COUNT')

    // Naming no leader is not an error when a Main Bot is joining: the Hub generates the leader the
    // way a local group takes its first Main Bot. List order is the input, so putting the ordinary
    // Bot first proves the rule looks for the standing, not for position one.
    const generated = await workgroup(alice, { botIds: ['worker', 'chief'] })
    assert.equal(generated.status, 201, generated.raw)
    assert.equal(generated.body.room.adminBotId, 'chief')
    assert.equal(generated.body.room.adminBotOwnerUserId, alice.userId)
    assert.equal(generated.body.room.replyMode, 'admin')

    const wrongLeader = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'worker' })
    assert.equal(wrongLeader.status, 400, wrongLeader.raw)
    assert.equal(wrongLeader.body.error.code, 'NOT_A_CHIEF_BOT')

    // An explicit leader is still honoured and still checked.
    const named = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    assert.equal(named.status, 201, named.raw)
    assert.equal(named.body.room.adminBotId, 'chief')
    assert.equal(named.body.room.replyMode, 'admin')
  })
})

test('a workgroup with no Main Bot among its Bots is refused', async () => {
  await withHub(async ({ person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'worker')
    await publish(alice, 'other')

    // Two Bots is satisfied; the second condition — a Main Bot — is not.
    const refused = await workgroup(alice, { botIds: ['worker', 'other'] })
    assert.equal(refused.status, 400, refused.raw)
    assert.equal(refused.body.error.code, 'NOT_A_CHIEF_BOT')

    // Naming an ordinary Bot as the administrator is still refused: the standing is checked, not
    // taken on the caller's word.
    const namedOrdinary = await workgroup(alice, { botIds: ['worker', 'other'], adminBotId: 'worker' })
    assert.equal(namedOrdinary.status, 400, namedOrdinary.raw)
    assert.equal(namedOrdinary.body.error.code, 'NOT_A_CHIEF_BOT')
  })
})
```

注意 `generated` 用 `botIds: ['worker', 'chief']`——普通 Bot 在前，用来证明自动生成取的是「第一个 `is_chief=1`」而不是「第一个」。

#### Reason
Step 1 反转了「不传 `adminBotId`」的语义，旧断言会把修复判成回归；同时必须新增「完全没有管家 Bot」的正向拒绝用例，否则 R7 无覆盖。

#### Risk
- `tests/helpers/workgroup.js` 的 `makeWorkgroup` 一直显式传 `adminBotId`，走的是显式分支，不受影响。
- 其他套件若依赖「不传 `adminBotId` → 400」，会在 Step 8 的全量回归里暴露。

#### Verification
```bash
cd server && node --test tests/h17-workgroup-v2-schema.test.js
```
期望：13 例全绿。

---

### Step 5: 改写 `a22` 建群表单用例

#### Target
- 文件：`application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
- 区块：`describe('the copied workgroup creation form')`，第 366–484 行

#### Current Behavior
fixture 只给 1 个无 `isChief` 的 Bot：
```ts
      directory: vi.fn(async () => [{ botId: 'mine', displayName: 'Mine', ownerUserId: 'u1' }]),
```
`creates with a Bot alone and names the workgroup after its members` 把缺陷写成期望：单 Bot 就 `disabled === false` 并成功创建。payload 断言 `toHaveBeenCalledWith('You, Mine', { kind: 'workgroup', botIds: ['mine'] })` 本身与 Step 2 之后的实现一致（不传 `adminBotId`），**保持不变**。

#### Change

**(a) fixture 扩成 3 个 Bot**
```ts
      directory: vi.fn(async () => [
        { botId: 'chief', displayName: 'Chief', ownerUserId: 'u1', isChief: true },
        { botId: 'mine', displayName: 'Mine', ownerUserId: 'u1', isChief: false },
        { botId: 'other', displayName: 'Other', ownerUserId: 'u1', isChief: false },
      ]),
```

**(b) 把单 Bot 成功用例改为拦截用例**
```ts
  it('does not create from a single Bot, and says the workgroup needs two', async () => {
    const hub = workgroups()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    await click('[data-wg-create-bot="chief"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    expect(container.querySelector('[data-wg-create-blocked="second-bot"]')).not.toBeNull()
    expect(hub.createRoom).not.toHaveBeenCalled()
  })
```

**(c) 新增「两个 Bot、含管家」成功用例，替代原单 Bot 成功用例的位置**
```ts
  it('creates with two Bots, one of them a Main Bot, and names the workgroup after its members', async () => {
    const hub = workgroups()
    const onCreated = vi.fn()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated, onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    // The Main Bot's standing is visible before the click, not only after a refusal.
    expect(container.querySelector('[data-wg-create-chief="chief"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    await click('[data-wg-create-bot="chief"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    await click('[data-wg-create-bot="mine"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(false)
    await click('[data-wg-create-submit="true"]')
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'room-9', name: 'New' }))
    // The Hub generates the leader from botIds; the form deliberately names nobody.
    expect(hub.createRoom).toHaveBeenCalledWith('You, Chief, Mine', { kind: 'workgroup', botIds: ['chief', 'mine'] })
    expect(hub.addBot).not.toHaveBeenCalled()
  })
```

**(d) 新增「没有管家 Bot」拦截用例**
```ts
  it('does not create without a Main Bot, and says one is needed to lead', async () => {
    const hub = workgroups({
      directory: vi.fn(async () => [
        { botId: 'mine', displayName: 'Mine', ownerUserId: 'u1', isChief: false },
        { botId: 'other', displayName: 'Other', ownerUserId: 'u1', isChief: false },
      ]),
    })
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="mine"]')).not.toBeNull())
    await click('[data-wg-create-bot="mine"]')
    await click('[data-wg-create-bot="other"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    expect(container.querySelector('[data-wg-create-blocked="leader"]')).not.toBeNull()
    expect(hub.createRoom).not.toHaveBeenCalled()
  })
```

**(e) 其余三条建群用例只改选 Bot 的步骤（点 2 个而不是 1 个），payload 断言补上第二个 Bot**
- `creates with a Bot and an invite when the name is left empty`
- `uses the typed name when one is provided`
- `opens the created room even when an invitation fails, and reports that failure once`

选 Bot 步骤由「点 `mine`」改为「点 `chief` + 点 `mine`」；`createRoom` 断言改为：
```ts
    expect(hub.createRoom).toHaveBeenCalledWith('You, Chief, Mine', { kind: 'workgroup', botIds: ['chief', 'mine'] })
```
（`uses the typed name…` 的 name 用 `'Launch'`；`opens the created room…` 的断言只保留 `toHaveBeenCalledTimes(1)`。）

**(f) `picks a Bot with the same arrow/Enter movement` 的断言改为 `Chief`**
fixture 顺序变成 `chief` 在首位，该用例原有的 `toContain('Mine')` 会失败。改为 `toContain('Chief')`，保留其余断言（token 长度 1）不变。

**(g) 不受影响的用例保持原样**
`renders the original new-chat skeleton and closes with Escape`、`does not create from a name alone`、Hub 三态阻断（`it.each` 3 例）、`refuses to create without a Hub`。

#### Reason
现有断言把缺陷（单 Bot 可建）写成了期望值，修复后必然红；只有改写才能让这套测试重新表达「条件与原群聊一致」。

#### Risk
- 新增 2 例、改写 1 例，`describe` 块内用例数由 9 变 11，全文件由 32 变 34。
- `picks a Bot…` 的顺序依赖已在 (f) 处理。
- 邀请相关断言（`hub.invite` 调用）不改：建群后邀请同事与其 Bot 的流程本次不动，只回归验证。

#### Verification
```bash
cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a22-workgroup-ui.spec.ts
```
期望 34 例全绿。

---

### Step 6: 修好 `a12` 端到端建群用例

#### Target
- 文件：`application/integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts`
- 三处 `POST /rooms`：第 128 行、第 149 行、第 176 行

#### Current Behavior
三个用例直接 `POST /rooms { name, kind: 'workgroup' }`，既无 `botIds` 也无 `adminBotId`。实测 **3 failed**：
```
HubClientError: A workgroup needs at least two Bots: the owner's Main Bot and one more (400 INVALID_BOT_COUNT)
```

#### Change
新增一个本地 helper（放在 `signIn` 之后），让三个用例先发布两个 Bot 再建群；**不传 `adminBotId`**，顺带让 e2e 也覆盖自动生成：

```ts
/**
 * Publish two Bots for `client` and create a workgroup from them.
 *
 * A workgroup needs two Bots, one of them its owner's Main Bot — the same condition a local group
 * has. The leader is not named here on purpose: generating it from the Bots that are joining is the
 * behaviour under test, not a detail to work around.
 */
async function createWorkgroup(client, name) {
  for (const [botId, isChief] of [['chief', true], ['worker', false]]) {
    await client.request('POST', '/bots', { body: { botId, displayName: botId, visibility: 'public', isChief } })
  }
  return client.request('POST', '/rooms', { body: { name, kind: 'workgroup', botIds: ['chief', 'worker'] } })
}
```
三处调用改为：
```ts
    const created = await createWorkgroup(alice.client, 'Finance')
```
```ts
    const created = await createWorkgroup(alice.client, 'Ops')
```
```ts
    const created = await createWorkgroup(dave.client, 'Realtime')
```
（`signIn` 返回 `{ client, bridge }`；第一个用例已存在变量 `alice`。）

#### Reason
这三个用例是同一缺陷的第二批受害者：它们是唯一跑在真实 Hub 进程上的建群证据，长期红着就意味着这条链路没有任何端到端保护。用自动生成而不显式传 `adminBotId`，是让这条链路验证真正的用户路径。

#### Risk
- 每个用例多两次 `POST /bots`，`recycle.mjs` 与临时目录清理逻辑不变。
- `alice`/`bob`/`dave` 各自独立身份，`botId` 在不同用户下不冲突（目录主键是 `(owner_user_id, bot_id)`）。
- 用例超时预算 90s，两次额外请求可忽略。
- 该用例现断言 `created.room.kind === 'workgroup'`；自动生成后 `adminBotId` 也应存在，可另加一条 `expect(created.room.adminBotId).toBe('chief')` 作为 e2e 的主持证据。

#### Verification
```bash
cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts
```
期望 3/3 通过。

---

### Step 7: 同步 `openapi.yaml` 契约描述

#### Target
- 文件：`server/contracts/openapi.yaml`
- 位置：`adminBotId`（第 331–339 行）

#### Current Behavior
```yaml
                adminBotId:
                  type: string
                  minLength: 1
                  maxLength: 128
                  description: >-
                    主持 Bot 的 id，必须同时出现在 botIds 中且其所有者上报它为管家 Bot（Main Bot）。
                    `kind: workgroup` 时必填，否则返回 400 NOT_A_CHIEF_BOT；普通房间忽略该字段。
                    该 Bot 成为房间的主持：普通消息先交给它应答，且它可以解散房间。
```

#### Change
```yaml
                adminBotId:
                  type: string
                  minLength: 1
                  maxLength: 128
                  description: >-
                    主持 Bot 的 id，可省略。省略时由 Hub 自动生成：取 botIds 中第一个管家 Bot（按调用方
                    给出的顺序），与原群聊取首个主 Bot 的规则一致；一个管家 Bot 都没有则返回 400
                    NOT_A_CHIEF_BOT。显式给出时必须同时出现在 botIds 中且其所有者上报它为管家 Bot，
                    否则同样返回 400 NOT_A_CHIEF_BOT。普通房间忽略该字段。
                    该 Bot 成为房间的主持：普通消息先交给它应答，且它可以解散房间。
```

#### Reason
契约现在写「必填」，与自动生成相反；`openapi.yaml` 是下游（客户端、脚本、维护者）的规格来源，描述错误会让人重新写出同样的 bug。

#### Risk
纯文档字段，无运行时影响。`d-contract-parity` 校验路由/字段存在性，不校验 description 文本，不会因此红。

#### Verification
```bash
cd server && node --test tests/d-contract-parity.test.js
```
期望 PASS。

---

### Step 8: 重新生成客户端 bundle 并跑全量验证

#### Target
- 文件：`application/packages/bundle/ds-bot/client.js`（生成物）

#### Current Behavior
`src/client/workgroup-ui/create.js` 与 `src/client/i18n.js` 改动后，`client.js` 与源码不一致；`build-client.mjs --check` 会失败。

#### Change
```bash
cd application/packages/bundle/ds-bot && node scripts/build-client.mjs
```

#### Reason
客户端 bundle 是仓库内的构建产物，源码改动不同步会让打包后的应用继续跑旧逻辑。

#### Risk
无。生成物由脚本产出，不手改。

#### Verification
```bash
cd application/packages/bundle/ds-bot && node scripts/build-client.mjs --check
```
期望 exit 0。

---

# 4. Changed Files Tracking

根据实际代码修改结果填写（`git diff --numstat` 核对），非计划期预估。

| File | Action | Change |
| ---- | ------ | ------ |
| `server/src/modules/rooms/store.js` | Modify | `resolveLeader` JSDoc 重写；`named === ''` 分支改为取 `joiningBots` 首个 `is_chief === 1` 自动生成主持，一个都没有才抛 `NOT_A_CHIEF_BOT`（新文案）。+15 −6 |
| `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js` | Modify | 新增 `leaderBotId`/`missingLeader`/`missingSecondBot`/`blockedTitle`；`canCreate` 加 `pickedBots.length >= 2 && leaderBotId !== undefined`；候选行渲染 `data-wg-create-chief`；新增 `data-wg-create-blocked` 提示；两个提交按钮共用 `blockedTitle`；`create()` 增补「不传 `adminBotId`」注释（payload 未变）。+29 −3 |
| `application/packages/bundle/ds-bot/src/client/i18n.js` | Modify | 新增 2 条中文文案：`A workgroup needs at least two Bots…`、`This workgroup needs a Main Bot to lead it…`。+2 −0 |
| `server/tests/h17-workgroup-v2-schema.test.js` | Modify | 用例改名并改写：`noLeader` 断言反转为 201 自动生成 + 新增「两个普通 Bot 无管家」用例（含显式指定普通 Bot 仍被拒）。12 → 13 例。+34 −9 |
| `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts` | Modify | fixture 扩成 3 个 Bot（`chief` 带 `isChief: true`）；单 Bot 成功用例改为拦截用例；新增「两 Bot 含管家」与「无管家」两例；其余三条补选第二个 Bot 并更新 payload 断言。34 → 36 例。+50 −11 |
| `application/integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts` | Modify | 新增 `createWorkgroup(client, name)` helper（发布 `chief`/`worker` 后建群、不传 `adminBotId`）；三处 `POST /rooms` 改用它；首个用例增加 `adminBotId === 'chief'` 断言。+19 −3 |
| `server/contracts/openapi.yaml` | Modify | `adminBotId` 描述：由「必填」改为「可省略，Hub 自动生成，取 botIds 首个管家 Bot，与原群聊一致」。+164 −4（含编辑器对多行 block scalar 的重排） |
| `application/packages/bundle/ds-bot/client.js` | Modify | `node scripts/build-client.mjs` 重新生成（含上述 create.js 与 i18n.js 改动）。+15 −3 |
| `docs/plans/2026-10-20-workgroup-create-leader-implementation-plan.md` | Add | 本计划文档（含本轮修订与 Execution Log）。 |

**确认未修改**（计划内外均未触碰）：`server/src/api/rooms.js`、`application/packages/bundle/ds-bot/src/host/workgroup-hub.js`、`src/host/channel.js`、`src/client/workgroup-hub.js`、`src/client/overlays.js`、`server/src/modules/rooms/bots.js`、`server/db/migrations/*`、`server/src/modules/bots/store.js`、`server/src/api/bots.js`，以及 Global Constraints 列出的全部原群聊文件。

**工作区中另有三项改动不属于本次任务**（本轮开始前即存在，未被本次修改触碰）：`server/tests/h07-bot-directory.test.js`、`server/contracts/events.schema.json`、`application/integrations/workgroup/tests/a21-workgroup-sidebar.spec.ts`。

---

# 5. Verification Checklist

### 主流程验证
- [ ] 选「管家 Bot + 另一个 Bot」→ 建群成功，`room.adminBotId` 自动 = 该管家 Bot，`room.replyMode === 'admin'`（`h17`）
- [ ] 表单 payload 不含 `adminBotId`（`a22`「creates with two Bots, one of them a Main Bot」）
- [ ] 真实 Hub 进程上建群成功且主持已生成（`a12` 3/3）

### 关联流程验证
- [ ] 不传 `adminBotId` + `botIds` 含管家 → 201，主持人自动确定（`h17`「generated」段）
- [ ] 显式传 `adminBotId` 仍被接受并校验（`h17`「named」段 + `tests/helpers/workgroup.js` 驱动的全部套件）
- [ ] **同事与其 Bot 建群后邀请**：`a22` 的邀请用例（`hub.invite` 断言）与 `a12` 的邀请用例保持绿
- [ ] 桥的三层透传不改但生效（`a11-hub-provider.spec.ts`，`calls[0].payload` 断言不变）
- [ ] 建群后主持应答仍工作（ds-bot `npm test`，`workgroup-turns.test.js` 读 `room.adminBotId`）
- [ ] 房间投影未回归（`h17` 内 `effectiveReplyMode` / `adminBotOwnerUserId` 断言）
- [ ] 三个建群入口仍收敛到同一表单（`a04-workgroup-entry-wiring.spec.ts`）
- [ ] 邀请失败仍进群、Hub 三态阻断仍生效（`a22` 既有用例）

### 边界情况验证
- [ ] 单 Bot → 表单禁用 + `data-wg-create-blocked="second-bot"`；绕过表单 → `400 INVALID_BOT_COUNT`
- [ ] 两个普通 Bot（无管家）→ 表单禁用 + `data-wg-create-blocked="leader"`；绕过表单 → `400 NOT_A_CHIEF_BOT`
- [ ] 显式指定非管家 Bot 为主持 → `400 NOT_A_CHIEF_BOT`（仍拒绝，不被自动生成绕过）
- [ ] `botIds` 顺序为「普通, 管家」且不传 `adminBotId` → 自动生成仍取管家
- [ ] 名字留空 → 由成员派生（`a22` 既有用例）

### Test
- [ ] `cd server && node --test tests/h17-workgroup-v2-schema.test.js`
- [ ] `cd server && node --test "tests/*.test.js"`（与基线比对，不新增失败）
- [ ] `cd application/packages/bundle/ds-bot && npm test`（与基线 635/636 比对）
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a22-workgroup-ui.spec.ts`
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts`
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a21-workgroup-sidebar.spec.ts`
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a16-workgroup-interactions.spec.ts`
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a11-hub-provider.spec.ts`
- [ ] `cd application && npx vitest run --config vitest.config.ts integrations/workgroup/tests/a04-workgroup-entry-wiring.spec.ts`

### Build
- [ ] `cd application/packages/bundle/ds-bot && node scripts/build-client.mjs`
- [ ] `cd application/packages/bundle/ds-bot && node scripts/build-client.mjs --check`（exit 0）

### Lint
- [ ] `cd application/packages/bundle/ds-bot && node scripts/lint.mjs`（0 errors；warnings 不超过基线 21）

### Typecheck
- [ ] `pnpm run typecheck` — 已知基线在 typert 路径失败，**记录结果、不作为本次判据**

---

# 6. Plan Adjustment 记录

| # | 原计划 | 新发现 | 调整 | 状态 |
|---|---|---|---|---|
| 1 | 把「≥2 Bot 建群」写成「需求文档内部的矛盾（功能1 vs R5）」，并在文档里请用户裁决 | 用户 2026-10-20 明确：工作群关于 Bot 的建群条件与原群聊完全一致，不存在特例；同事与同事的 Bot 可后面邀请。核实原群聊 `roster.js:278 checkMembers` 与 `:283-289 createRoom` 后确认代码与该口径一致，先前的「矛盾」是我误读 | 删除「需求文档内部不一致」章节，改为「已确认口径」；`checkMembers` / `members.find(rt.isMain)` 作为 Step 1 与 Step 2 的规则来源写入文档 | 已采纳 |
| 2 | Step 2(c) 让表单显式发送 `adminBotId: leaderBotId` | 用户 2026-10-20：Hub 侧主持人目前先自动生成 | 表单**不发** `adminBotId`；`leaderBotId` 只用于本地拦截与标记。服务端自动生成是唯一主持人来源，显式传参仍保留兼容与校验。Step 5/6 的 payload 断言随之保持 `{kind, botIds}`，`a11` 不需改 | 已采纳 |
| 3 | 其余两个待确认点：自动生成顺序口径取 `botIds` 顺序；R10 建群配额缺口不修 | 用户 2026-10-20：其他按推荐 | 均按推荐保留：Step 1 顺序口径不变；R10 缺口仍列入 Remaining Risks，不纳入本次修改 | 已采纳 |
| 4 | Step 5(f)：`picks a Bot with the same arrow/Enter movement` 的断言由 `'Mine'` 改为 `'Chief'`（理由是 fixture 首位变成 `chief`） | 实测该用例先按 `ArrowDown` 再按 `Enter`，光标从默认高亮的第 0 项移到了第 1 项，取到的是 `mine`；计划对按键语义的判断有误 | 断言**保持 `'Mine'`**，并加注释说明「ArrowDown 才是证明移动的那一步」。3 个 Bot 的 fixture 反而让这条用例比原先更强：它现在确实验证了移动，而不只是因为列表只有一项 | 已采纳（范围未变，仍只改 a22） |
| 5 | 未预见：`a04-workgroup-entry-wiring` 2 例失败 | 实测在剥离本次全部改动的干净工作树上同样失败（`git stash` 后复现 2 failed）。原因是先前已提交的 parity 工作让 `client/settings.js` 含有 workgroup 字样，而该用例断言原群聊文件不得出现 `workgroup` | 判定为**基线既有失败**，本次不修（修它需要决定 `settings.js` 是否保留 `externalGroups`，属另一个需求）。在验证结果中记录 | 不修，记录 |

---

# 7. Execution Log

### Step 1 Completed

**Changed:** `server/src/modules/rooms/store.js`

**Summary:** `resolveLeader` 在 `adminBotId` 为空时改为取 `joiningBots` 中首个 `is_chief === 1` 的成员，只有完全没有管家 Bot 才抛 `NOT_A_CHIEF_BOT`（文案改为可执行的「先发布一个再加进来」）。显式传参分支与 `createRoom` 事务体一行未动。

**Verification:** `node --test tests/h17-workgroup-v2-schema.test.js` → 11 pass / 1 fail，失败正是计划预测的第 126 行旧断言 `201 !== 400`。符合预期。

### Step 2 Completed

**Changed:** `application/packages/bundle/ds-bot/src/client/workgroup-ui/create.js`

**Summary:** 新增 `leaderBotId`（本地按 `isChief` 推算，不参与请求）、`missingLeader`、`missingSecondBot`、`blockedTitle`；`canCreate` 增加 `pickedBots.length >= 2` 与 `leaderBotId !== undefined`；候选行渲染 `data-wg-create-chief` 标记管家 Bot；新增 `data-wg-create-blocked` 提示块；两个提交按钮的 `title` 统一由 `blockedTitle` 给出。`create()` 的 payload 保持 `{kind, botIds}`。

**Verification:** 随 Step 5 的 a22 运行一并验证。

### Step 3 Completed

**Changed:** `application/packages/bundle/ds-bot/src/client/i18n.js`

**Summary:** 新增 `'A workgroup needs at least two Bots: your Main Bot and one more.'` 与 `'This workgroup needs a Main Bot to lead it. Publish one and add it here.'` 两条中文条目；`'Main Bot'` 复用既有 key。

**Verification:** `node --test test/i18n.test.js` → 2 pass / 0 fail。

### Step 4 Completed

**Changed:** `server/tests/h17-workgroup-v2-schema.test.js`

**Summary:** 用例改名为 `…generates its leader from the creator's Main Bot`；`noLeader` 段反转为 `botIds: ['worker', 'chief']` 无 `adminBotId` → 201 且 `adminBotId === 'chief'`（普通 Bot 在前，证明按 standing 而非位置取）；新增 `a workgroup with no Main Bot among its Bots is refused`。

**Verification:** `node --test tests/h17-workgroup-v2-schema.test.js` → **13 pass / 0 fail**。

### Step 5 Completed

**Changed:** `application/integrations/workgroup/tests/a22-workgroup-ui.spec.ts`

**Summary:** fixture 扩成 `chief`(isChief)/`mine`/`other`；`creates with a Bot alone` 改为 `does not create from a single Bot`；新增 `creates with two Bots, one of them a Main Bot` 与 `does not create without a Main Bot`；邀请与命名两条用例补选第二个 Bot；`picks a Bot…` 断言按实测保持 `'Mine'`（见 Plan Adjustment #4）。

**Verification:** `npx vitest run integrations/workgroup/tests/a22-workgroup-ui.spec.ts` → **36 pass / 0 fail**。

### Step 6 Completed

**Changed:** `application/integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts`

**Summary:** 新增 `createWorkgroup()` helper，发布 `chief`/`worker` 后建群且**不传** `adminBotId`；三处用例改用它；首个用例增加 `adminBotId === 'chief'` 作为自动生成的 e2e 证据。

**Verification:** `npx vitest run integrations/workgroup/tests/a12-hub-provider-e2e.host.spec.ts` → **3 pass / 0 fail**（修改前为 3 failed / `400 INVALID_BOT_COUNT`）。

### Step 7 Completed

**Changed:** `server/contracts/openapi.yaml`

**Summary:** `adminBotId` 描述由「必填」改为「可省略，Hub 自动生成，取 botIds 首个管家 Bot；一个都没有则 400；显式给出仍校验」。

**Verification:** `node --test tests/d-contract-parity.test.js` → 3 pass / 0 fail。

### Step 8 Completed

**Changed:** `application/packages/bundle/ds-bot/client.js`

**Summary:** 用 `node scripts/build-client.mjs` 重新生成客户端 bundle。

**Verification:** `node scripts/build-client.mjs --check` → exit 0。
