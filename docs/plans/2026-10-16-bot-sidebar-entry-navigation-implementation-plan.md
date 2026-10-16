# Implementation Plan

> **For agentic workers:** 获得用户明确批准后，必须使用 `superpowers:executing-plans` 按步骤执行本计划；实现前使用 `superpowers:test-driven-development`，完成声明前使用 `superpowers:verification-before-completion`。每完成一个 Step，立即更新 Changed Files Tracking 与 Execution Log。
>
> **计划状态：已执行；核心交付已完成，未通过的全套门禁与既有基线见第 7 节。**

**Goal：** 完成 Workgroup AI 现有 Bot 一级入口的导航语义，使其稳定位于 Plugins 正下方，并正确区分原生 DSH Session 导航与 Bot 自有导航。

**Architecture：** 保留现有 `sidebar.panellist` 注册并复用 Shell 已有的 `conversation` 主面板；仅修正 DS Bot 自己的导航状态适配，让显式 Bot 选择进入 Bot mode、普通 DSH Session 不误入 Bot、Bot 内部 Session 切换持续保持 Bot 入口选中。使用真实 Web 组合测试验证，并重新生成已提交的浏览器产物。

**Tech Stack：** JavaScript/React Client plugin、Cordis slots、DSH layout/workspace services、Node test runner、Vitest、Playwright、pnpm、esbuild。

## Global Constraints

- 本应用是独立于官方 DSH 的 Workgroup AI；不得改变 `ai.workgroup.workgroup-ai`、`wgai`、`WORKGROUP_HOME` 与 `~/.workgroup-ai`。
- 只保留一个新增的一级 `Bot` 入口，并确保其紧随 Plugins；不得增加第二个主路由或侧栏入口。
- Chief、下属 Bot、私人聊天、普通群与工作群继续位于现有 DS Bot UI 内部。
- 不修改 `server/`、Hub 协议、持久化格式、DSH Agent Loop 或通用 Client slot/layout 契约。
- 不重构无关 DS Bot 代码，不改变普通群或工作群业务行为。
- 保留工作区中 `application/packages/bundle/ds-bot/package.json`、`scripts/build-client.mjs`、`scripts/build-lib.mjs` 和 `test/build-lib.test.js` 的既有未提交改动。
- 修改 DS Bot 核心 Client 源码或已提交生成产物前，先复制到项目根 `backups/2026-10-16-bot-sidebar-entry-navigation/`。
- 除非用户另行明确要求，否则不创建 Git commit。

---

## 1. Goal

### 本次修改目标

仓库当前已经通过 `sidebar.panellist`、`order: 1` 渲染 Bot 行。本任务不重复添加入口，而是补全其导航语义：只有显式 Bot 入口、既有 `BotReturn` 或 DS Bot 自有导航可以进入/保持 Bot surface；普通 DSH Session 导航不能误激活 Bot；进入 Bot 后切换 Bot 所属 Session 时，Bot 行持续显示 `aria-current="page"`。

### 不包含

- 不新建 Bot panel component、`main` key、route、service、package、process 或 server endpoint。
- 不修改 Plugins 的 `order: 0`、Schedules 的 `order: 10`、通用 panel 排序或 `conversation` 注册。
- 不处理 Hub 登录、工作群成员、消息、任务委派、审批、附件或 presence。
- 不重新设计 Bot 侧栏、图标、聊天、群聊、设置或账户菜单。
- 不清理无关注释、构建脚本、Host 生成文件或既有脏文件。

### 成功标准

1. Global panels 中 Plugins 后紧接 Bot，且不存在第二个 Bot 一级入口。
2. 普通 DSH New Session 或 Workspace Session 导航在尚未选择 Bot 时不激活 Bot surface。
3. 点击 Bot 复用现有 `conversation` 主面板；若本地持久化为 classic Agent mode，则切回 Bot mode 并显示 Bot UI。
4. 在 DS Bot 内打开 Chief、下属 Bot、Bot 所属 Agent Session、普通群或工作群后，Bot 行仍为 `aria-current="page"`。
5. 点击 Plugins 或 Schedules 后撤销 Bot shell/conversation replacements，并选择目标 panel。
6. Client 源码、根 `client.js` 与导出的 `lib/client.js` 字节一致；聚焦测试、Web replay、lint、typecheck 与 build check 没有新增失败。

---

## 2. Current Understanding

### 当前实现方式

- `application/packages/boot/app-boot/src/profile.ts` 已在 `PROFILE_TEMPLATES.web` 中包含 `@deepseek-ai/dsh-bot`；Desktop 通过 `apps/desktop/src/project-manager.ts` 复用该模板。
- `application/packages/bundle/ds-bot/cordis.patch.yml` 挂载 Host half；`package.json` 将 `lib/client.js` 暴露为 Browser half。
- `application/packages/bundle/ds-bot/src/client/index.js` 向 `sidebar.panellist` 注册 `id: 'conversation'`、`order: 1`、标签 `Bot` 和 `BotPanelIcon`。
- `ui-plugin-manager` 以 `order: 0` 注册 Plugins，Schedules 以 `order: 10` 注册；`ui-sidebar` 升序排序，因此当前视觉位置已经正确。
- `ui-conversation` 持有 `main` key `conversation`；`ui-layout` 维护 `activePanelId`；`AppFrame` 渲染 `activePanelId ?? 'conversation'`。
- DS Bot 当前包装 `layout.selectPanel()`，通过闭包变量 `botViewChosen` 更新 `surface.panelActive`，再由 `groupsFor()` 挂载或撤销 Bot shell/conversation groups。

### 数据流 / 调用链

```text
Web/Desktop profile
  -> @deepseek-ai/dsh-bot Host + Client bundle
  -> Client apply()
  -> sidebar.panellist { id: conversation, order: 1 }
  -> SidebarRoot PanelRow
  -> layout.selectPanel(panelId)
  -> layout.panelInfo.activePanelId
  -> AppFrame main entryKey
  -> DS Bot surface.panelActive
  -> surfaceGroups(shell, conversation)
```

Bot roster/chat 数据继续来自现有 Host `state` 调用，并保存在现有 `roster`、`ui`、`surface`、Session 与 Workspace sources 中；本任务不改变数据模型或 Host response。

### 已确认缺口

1. 包装器当前对所有 `selectPanel(null)` 都设置 `botViewChosen = true`；而 `ui-workspace.openSession()` 打开普通 DSH Session 时也使用 `null`，因此原生 Session 操作可能在未点击 Bot 时激活 Bot。
2. DS Bot 自己打开 Session 同样调用 `selectPanel(null)`；Bot surface 虽保持激活，但 `PanelRow` 只按 `activePanelId === 'conversation'` 判断选中，因此 Bot 行会丢失 `aria-current`。
3. `surface.mode` 持久化在 `ds-bot:surface`；值为 `agent` 时，点击 Bot 只标记 panel choice，不调用 `setSurface('bot')`，所以 `groupsFor()` 不挂载 Bot UI。
4. `botViewChosen` 附近的注释声称 `conversation` 不在 `main` registry 中，但当前 `ui-conversation` 实际已注册该 key。
5. DS Bot package test、integration test 与 Web e2e 均未覆盖该一级入口。

### 已确认影响范围

实现归属仍在 `application/packages/bundle/ds-bot`。唯一跨 package 写入是 `application/apps/web/tests` 下新增真实 Web 组合测试；`ui-sidebar`、`ui-layout`、`ui-workspace`、`ui-conversation`、boot、Desktop identity、home paths 与 `server/` 都只作为只读直接依赖。

---

## 3. Implementation Steps

### Step 1

#### Target

- Add：`application/apps/web/tests/bot-entry.e2e.ts`
- Add：`application/apps/web/tests/expected/bot-entry/navigation.expected.md`，在行为通过后由已审阅的稳定 ARIA 输出生成
- Modify：`application/packages/bundle/ds-bot/test/surface.test.js`
- 复用 `launchWebScaffold`、真实 Web profile composition、Playwright、`watchConsole` 与现有 snapshot mode helpers

#### Current Behavior

目前没有真实组合测试覆盖 Bot 行。通用 sidebar suite 只用 fixture panel 验证排序与选择机制；DS Bot 的 `surface.test.js` 覆盖 mode/plain，但没有显式固定 `panelActive: false`。

#### Change

新增零模型调用 Web e2e，使用以下 profile 启动 shipped base、Web bundle 与 DS Bot：

```ts
const scaffold = await launchWebScaffold({
  profile: { packages: [], bundles: ['@deepseek-ai/dsh-bot'] },
})
```

测试通过 Global panels 的可访问性接口执行以下断言：

```ts
const navigation = page.getByRole('navigation', { name: 'Global panels' })
const labels = await navigation.getByRole('button').evaluateAll(buttons =>
  buttons.map(button => button.getAttribute('aria-label')))
const pluginsIndex = labels.indexOf('Plugins')
expect(pluginsIndex).toBeGreaterThanOrEqual(0)
expect(labels[pluginsIndex + 1]).toBe('Bot')

const bot = navigation.getByRole('button', { name: 'Bot', exact: true })
expect(await bot.getAttribute('aria-current')).toBeNull()
await page.getByRole('button', { name: /New Session/i }).click()
await expect.poll(() => page.locator('html').getAttribute('data-wg-bot-panel')).toBeNull()

await bot.click()
await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')
await page.getByRole('region', { name: 'Bot list' }).waitFor()
await page.getByRole('region', { name: 'Bot list' }).getByRole('button').first().click()
await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')

await navigation.getByRole('button', { name: 'Plugins', exact: true }).click()
await page.locator('[data-plugin-panel]').waitFor()
expect(await bot.getAttribute('aria-current')).toBeNull()
await expect.poll(() => page.locator('html').getAttribute('data-wg-bot-panel')).toBeNull()
```

第二个全新 BrowserContext 在导航前写入现有持久化键，验证 Agent mode 下点击 Bot：

```ts
await context.addInitScript(() => { localStorage.setItem('ds-bot:surface', 'agent') })
await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
const bot = page.getByRole('navigation', { name: 'Global panels' })
  .getByRole('button', { name: 'Bot', exact: true })
await bot.click()
await page.getByRole('region', { name: 'Bot list' }).waitFor()
await expect.poll(() => bot.getAttribute('aria-current')).toBe('page')
```

使用 `captureStableAria()` 与 `compareOrRefreshGolden()` 捕获 Global panels ARIA tree；两个场景都注册 `saveFailureShot()`，关闭各自 BrowserContext，并断言 `watchConsole()` 没有 page errors 或 warnings。

向 `surface.test.js` 增加：

```js
test('an inactive Bot panel mounts neither group', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', panelActive: false }), {
    shell: false,
    conversation: false,
  })
})
```

#### Reason

当前源码已经显示 Bot 文字，仅断言入口存在无法证明需求。上述用例会在当前实现的 `null` 误激活、Bot 内导航丢失选中态、持久化 Agent mode 点击无效三个缺口上失败，从而建立实现前验收边界。

#### Risk

- Main Bot 初始化为异步；必须等待可访问的 `Bot list` region，不使用固定 sleep。
- 场景不得发起模型调用；意外 stream 应通过 scaffold 缺失 adapter 的路径显式失败。
- 普通 replay 验证不得刷新 expected output。

#### Verification

从 `application/` 执行：

```bash
WORKGROUP_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/bot-entry.e2e.ts
```

Step 2 前预期：FAIL，失败原因分别对应 native New Session 激活 `data-wg-bot-panel`、Bot Session 导航清除行选中态、Agent mode 点击后未出现 `Bot list`。

从 `application/packages/bundle/ds-bot/` 执行：

```bash
node --import ./test/harness-resolve.mjs --test test/surface.test.js
```

预期：PASS，包含新增 `panelActive: false` 回归用例。

---

### Step 2

#### Target

- Modify：`application/packages/bundle/ds-bot/src/client/index.js`
- 涉及状态/函数：`actions.openSession`、`actions.openAgentSession`、`actions.landOn`、`actions.setSurface`、`layout.selectPanel` wrapper、`layout.panelInfo` synchronization effect
- 编辑前备份：
  - `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/src/client/index.js`
  - `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/client.js`
  - `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/lib/client.js`

#### Current Behavior

`botViewChosen` 当前在 layout wrapper 附近声明，只根据请求的 panel ID 更新；显式 Bot 选择 `conversation` 与所有默认 Conversation reveal `null` 都被视为 Bot。Bot 自有 open 最终保留 `activePanelId: null`，而已保存的 `agent` surface mode 在 Bot 行点击时不会改变。

#### Change

将 `let botViewChosen = false` 移到 `actions` 对象之前的 apply-owned state，使 Bot 导航动作与 layout adapter 共享同一个所有者。

在每个 DS Bot 发起的 Workspace open 前明确记录 Bot destination：

```js
botViewChosen = true
expected = target
ctx.uiWorkspace.openSession(target)
```

`openAgentSession(sessionId)` 与 `landOn(...)` 使用对应顺序；不修改通用 Workspace 代码。

surface mode 切换时同步 layout choice：

```js
writeMode(mode)
surface.set(state => ({ ...state, mode }))
if (mode !== 'bot') {
  ctx.layout.selectPanel(null)
  return
}
ctx.layout.selectPanel(BOT_PANEL_ID)
```

Bot 选择后继续执行已有 home fallback。将当前 `layout.selectPanel` wrapper 改为：

```js
const wrapped = (panelId) => {
  if (panelId === BOT_PANEL_ID) {
    botViewChosen = true
    if (surface.getSnapshot().mode !== 'bot') actions.setSurface('bot')
  } else if (panelId !== null) {
    botViewChosen = false
  } else if (surface.getSnapshot().mode === 'agent') {
    botViewChosen = false
  }
  const target = panelId === null && botViewChosen ? BOT_PANEL_ID : panelId
  return original(target)
}
```

Bot 自有 `null` reveal 被归一化为 `conversation` 后，激活条件收紧为：

```js
const panelActive = botViewChosen && active === BOT_PANEL_ID
```

只更新同一区域注释，陈述当前事实：`ui-conversation` 注册 `conversation` main key；通用 Workspace 导航使用 `null`；DS Bot 把自己的 Conversation reveal 归一化以保持一级入口选中。`registerBotPanel()`、`BOT_PANEL_ID`、`order: 1` 与 `BotPanelIcon` 保持不变。

#### Reason

sidebar row 没有自定义 click callback，其 ID 必须继续使用真实 `conversation` main key。最小兼容修改应保留在 DS Bot 现有 layout adapter 中，因为只有这里同时知道导航是否由 Bot 发起以及当前 surface mode。

#### Risk

- wrapper 中调用 `setSurface('bot')` 会再次调用一次 `selectPanel(BOT_PANEL_ID)`；现有 same-mode early return 必须阻止无限递归。
- `setSurface('agent')` 必须先更新 `surface.mode` 再选择 `null`，使 wrapper 清除 `botViewChosen`，而不是映射回 Bot。
- Bot-owned Agent Session 仍需保留 `plain: true`：保留 Bot shell，仅撤销 conversation replacements。
- Plugins 与 Schedules 的原始 ID 必须原样交给原 layout service。

#### Verification

重新运行 Step 1 的 focused e2e。预期：全部行为断言通过；refresh mode 只产生新的 Global panels snapshot。

运行 DS Bot 全部现有测试：

```bash
node --import ./test/harness-resolve.mjs --test "test/*.test.js"
```

预期：PASS，且无既有 DS Bot 行为回归。

---

### Step 3

#### Target

- Modify：`application/packages/bundle/ds-bot/README.md`，仅 Summary 当前段落
- Modify（生成）：`application/packages/bundle/ds-bot/client.js`
- Modify（机械同步）：`application/packages/bundle/ds-bot/lib/client.js`
- Add（生成）：`application/apps/web/tests/expected/bot-entry/navigation.expected.md`
- 不修改当前已有改动的构建脚本，也不修改 `lib/` 下其他文件

#### Current Behavior

README 已说明 fresh install 在 sidebar 中有 Bot，但没有记录 Workgroup AI 一级位置及 native/Bot 导航区别；两个已提交 Client artifact 仍对应修改前源码。

#### Change

修改现有 Summary 句子：Workgroup AI 只注册一个 Bot 一级入口，紧随 Plugins；该入口复用 native Conversation，仅在 Bot 被选中时启用 Bot replacements。不得扩写安装步骤或其他 Workgroup 功能。

生成并同步 Browser artifact，不调用 `build-lib.mjs` 的写入路径：

```bash
node scripts/build-client.mjs
cp client.js lib/client.js
node scripts/build-client.mjs --check
node scripts/build-lib.mjs --check
```

生成一次预期 ARIA 输出：

```bash
WORKGROUP_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/bot-entry.e2e.ts
```

审阅生成 Markdown 后，用 `WORKGROUP_SNAPSHOT=replay` 重跑同一测试。

#### Reason

运行时导入 `lib/client.js`，而非 `src/client/index.js`；只改源码会使实际应用继续加载旧逻辑。当前状态文档必须匹配用户可见导航，可见 Client 变化需要 keyless assembled-Web expectation。

#### Risk

- `client.js` 为生成文件，不得手工修改两个生成副本。
- 既有构建脚本改动必须保持字节不变。
- refresh mode 只允许新增本任务 expectation；若改动其他 expected 文件，必须进入 Plan Adjustment。

#### Verification

- `build-client.mjs --check` 退出码为 `0`，无 stale-client 消息。
- `build-lib.mjs --check` 退出码为 `0`，无 stale-lib 消息。
- 两个 Client artifact 包含等价的生成导航逻辑。
- replay mode 读取但不重写 `navigation.expected.md`。

---

### Step 4

#### Target

- 不新增实现文件。
- 只验证 Changed Files Tracking 中的文件及其直接依赖。
- 使用实际结果更新本文档 Changed Files Tracking 与 Execution Log。

#### Current Behavior

调查基线曾通过 31 个相关 Vitest、`build-client --check` 与 `build-lib --check`；这些结果早于实现，不能作为完成证据。执行期间新增的 `apps/web/tsconfig.json` 排除项、Desktop profile 断言与 build-lib 内存快照隔离已完成并重新验证。

#### Change

最终生成 artifact 后执行 Section 5 的命令。检查最终 diff 是否越界、是否仍含失真注释、生成产物是否一致、已知脏文件是否被意外改动、e2e selector 是否验证用户可见行为而非偶然实现细节。

#### Reason

本任务同时涉及 source、runtime artifact 与 assembled UI，必须分别取得修改后的当前证据；只读源码不能证明应用实际加载和交互成功。

#### Risk

- 完整 Web replay 可能暴露无关既有失败；只能记录，不得顺手修改无关代码。
- Desktop packaging 与跨平台发布测试不在本窄范围内；未实际执行时不得宣称通过。

#### Verification

完成 Section 5 全部适用检查，并对本次 diff 做范围受限自检。当前 Harness 未提供独立 reviewer/subagent，因此除非后续明确提供能力，否则不创建新的 reviewer。

---

## 4. Changed Files Tracking

执行中每修改一个文件立即更新本表。若实现需要表外文件，先停止，记录 Plan Adjustment，并等待批准。

| File | Action | Reason |
| ---- | ------ | ------ |
| `docs/plans/2026-10-16-bot-sidebar-entry-navigation-implementation-plan.md` | Add | 正式执行计划、范围、追踪与日志 |
| `application/apps/web/tests/bot-entry.e2e.ts` | Add | 真实 Web 组合下验证顺序、激活、持久化 mode 与 panel 切换 |
| `application/apps/web/tests/expected/bot-entry/navigation.expected.md` | Add | 用户可见导航的稳定 keyless ARIA expectation |
| `application/packages/bundle/ds-bot/test/surface.test.js` | Modify | 固定 inactive-panel surface 行为 |
| `application/packages/bundle/ds-bot/src/client/index.js` | Modify | 修正 Bot/native 导航和 surface mode 状态转换 |
| `application/packages/bundle/ds-bot/README.md` | Modify | 记录当前一级 Bot 导航行为 |
| `application/packages/bundle/ds-bot/client.js` | Modify | 从修改后 Client source 重新生成 |
| `application/packages/bundle/ds-bot/lib/client.js` | Modify (ignored artifact) | 与根 Browser artifact 机械同步的运行时 export |
| `application/packages/bundle/ds-bot/package.json` | Modify | 发布 staged manifest 并保留既有 build-watch 改动 |
| `application/packages/bundle/ds-bot/scripts/build-lib.mjs` | Modify | 生成相对 staged manifest，并支持内存 tree 比较以隔离并发测试 |
| `application/packages/bundle/ds-bot/test/build-lib.test.js` | Modify | 覆盖 staged export、发布文件列表和无共享目录写入的幂等比较 |
| `application/apps/web/tsconfig.json` | Modify | 排除使用 host scaffold 的真实 Web e2e，保持 client typecheck 边界 |
| `application/apps/desktop/tests/profile-mcp.spec.ts` | Modify | 直接断言 Desktop profile 包含 DS Bot bundle |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/src/client/index.js` | Add | 核心 Client source 修改前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/client.js` | Add | 根 Browser artifact 修改前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/lib/client.js` | Add | 运行时 Browser export 修改前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/apps/web/tsconfig.json` | Add | Web TypeScript 配置修改前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/apps/web/tests/bot-entry.e2e.ts` | Add | Web e2e 首次扩展前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/apps/web/tests/bot-entry.e2e.before-agent-switch.ts` | Add | Web e2e 加入 Agent 反向切换断言前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/apps/web/tests/bot-entry.e2e.before-tripwire-move.ts` | Add | Web e2e 移动完整流程 tripwire 断言前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/apps/desktop/tests/profile-mcp.spec.ts.before-bot-assertion.ts` | Add | Desktop profile 测试加入 DS Bot 断言前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/application/packages/bundle/ds-bot/lib-package.json` | Add | staged manifest 单文件同步前备份 |
| `backups/2026-10-16-bot-sidebar-entry-navigation/docs/plans/2026-10-16-bot-sidebar-entry-navigation-implementation-plan.md` | Add | 最终执行记录修改前备份 |

---

## 5. Verification Checklist

### 主流程

- [x] Global panels 中 Plugins 后紧接 Bot。
- [x] 点击 Bot 后该行选中并出现 `Bot list` region。
- [x] Bot 自有 Session 导航后 Bot 行保持选中。
- [x] 点击 Plugins 或 Automation tasks（Schedules）后撤销 Bot panel activation，并打开目标 panel。

### 关联流程

- [x] native mode 下普通 DSH New Session 不进入 Bot。
- [x] 保存为 classic Agent mode 时，点击 Bot 能切回 Bot。
- [x] “Switch to classic Agent mode” 后 Bot panel/一级入口选中状态撤销，并显示 DS Bot return button；native Conversation body 未在本次 e2e 中单独断言。
- [ ] Bot-owned plain Agent Session 保留 Bot shell 与 native Conversation body 行为未单独覆盖。
- [ ] 展开和折叠 sidebar 均保留 Bot accessible name，布局稳定未单独覆盖。

### 边界情况

- [x] 未配置 Hub 时，本地 Bot 入口仍可用，focused e2e 不调用模型。
- [ ] 中文与英文 locale 的 accessible name 都是 `Bot`；本次 focused e2e 只验证 en-US。
- [ ] plugin teardown 恢复 `layout.selectPanel` 的独立断言未覆盖；focused e2e 验证了两组 context 的 console error/warning 为空。
- [ ] Plugins/Schedules 的顺序已由 golden 验证；analytics 行为未单独断言。
- [x] 未向 Workgroup AI 代码或测试数据引入官方 DSH identity/data root；identity 测试 16/16 通过。

### Test

从 `application/packages/bundle/ds-bot/`：

```bash
node --import ./test/harness-resolve.mjs --test "test/*.test.js"
```

从 `application/`：

```bash
pnpm exec vitest run packages/client/ui-sidebar/tests/panel-list.client.spec.tsx packages/boot/app-boot/tests/profile-sanitize.spec.ts integrations/product/tests/identity.spec.ts
WORKGROUP_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/bot-entry.e2e.ts
pnpm run test:gui
WORKGROUP_SNAPSHOT=replay pnpm run test:web
```

- [ ] 每条命令退出码为 `0`；聚焦与相关测试通过，但全套门禁存在既有/范围外失败，详见 Execution Log。

### Build

从 `application/packages/bundle/ds-bot/`：

```bash
node scripts/build-client.mjs --check
node scripts/build-lib.mjs --check
```

从 `application/`：

```bash
pnpm run build:artifacts
pnpm run build:check
```

- [x] `build-client.mjs --check`、`build-lib.mjs --check`、`build:artifacts`（7/7）与 `build:check`（2/2）退出码为 `0`；根 `client.js` 与 `lib/client.js` 字节一致。

### Lint

从 `application/`：

```bash
pnpm --filter @deepseek-ai/dsh-bot run lint
pnpm run lint
```

- [ ] 包级 lint 0 errors/18 warnings，通过；根级 lint 非零（961 errors/730 warnings），诊断主要来自既有仓库范围，交付文件仅有既有 warning，未新增硬错误。

### Typecheck

从 `application/`：

```bash
pnpm run typecheck
```

- [x] `pnpm run typecheck` 5/5 gate 通过。

### 最终 Diff Review

- [x] `git diff --check` 无 whitespace error。
- [x] 本次新增/修改文件均已列入 Changed Files Tracking；工作区其他既有脏文件未触碰。
- [x] `package.json`、`scripts/build-client.mjs` 与 `test/build-lib.test.js` 的既有改动保留；`scripts/build-lib.mjs` 与 `test/build-lib.test.js` 后续仅增加已批准的 staged manifest/快照隔离修正，详见 Plan Adjustment。
- [x] 未修改 `server/`、protocol、schema、通用 layout 或通用 sidebar source。

---

## 6. Plan Adjustment

### 2026-10-16：修复 staged manifest 的 Client export（已批准）

**原计划：** 真实 Web 组合直接通过 `profile: { packages: [], bundles: ['@deepseek-ai/dsh-bot'] }` 加载现有 DS Bot Host 与 Client，Step 1 预期首先暴露导航状态缺陷；`package.json`、`scripts/build-lib.mjs` 与 `test/build-lib.test.js` 作为既有无关改动保留且不修改。

**新发现：** DS Bot Host Loader entry 已启用并处于 ACTIVE，但它从 `lib/index.js` 启动后，ClientModules 读取最近的 `lib/package.json`。该 staged manifest 原样复制根 manifest，将 `./client` 继续声明为 `./lib/client.js`，于是 ClientModules 计算出不存在的 `lib/lib/client.js`，真实组合中的 Global panels 没有 Bot 行。Desktop 复用同一 Web 应用与 profile/client-module 装载链，因此原计划不能保证桌面端入口。

**调整原因：** 在浏览器 Client 未装载时，原计划对 `src/client/index.js` 的导航修改及其 e2e 均不可执行。必须先让 staged manifest 的 `./client` export 相对于 `lib/` 正确解析，并把该 invariant 纳入构建测试。

**新增修改范围：**

- Modify：`application/packages/bundle/ds-bot/package.json`，在保留既有 `build-watch` 改动的前提下确保 staged manifest 属于发布文件。
- Modify：`application/packages/bundle/ds-bot/scripts/build-lib.mjs`，在保留既有幂等 staging 改动的前提下为 `lib/package.json` 生成相对 `lib/` 的 Client export。
- Modify：`application/packages/bundle/ds-bot/test/build-lib.test.js`，在保留既有幂等测试的前提下增加 staged Client export 与目标文件存在性回归测试。
- Verify：真实 Web 组合的 Client graph 和 Global panels 包含唯一 Bot 行；Desktop profile 继续从包含 `@deepseek-ai/dsh-bot` 的 Web template 组合，并通过同一 Client graph 路径获得入口。

**审批状态：** 用户已明确回复“按推荐和plan继续”，批准上述调整。完成该前置修复后继续原 Step 1 至 Step 4，不改变原导航方案或其他架构。

---

## 7. Execution Log

### Step 1 Completed — 真实 Web 组合与 staged manifest 修复

- 先运行新增 `surface.test.js` 回归，inactive-panel 断言通过；真实 Web 组合初次在 `Plugins → Bot` 入口断言失败，定位为 staged `lib/package.json` 将 `./client` 错误保留为 `./lib/client.js`，导致 ClientModules 解析到不存在的 `lib/lib/client.js`。
- 按已批准 Plan Adjustment 修改 `package.json` 发布文件列表、`scripts/build-lib.mjs` staged manifest 生成及 `test/build-lib.test.js` export 回归；同步 `lib/package.json`（该运行时文件被 `.gitignore` 忽略并已备份）。
- `node --import ./test/harness-resolve.mjs --test test/build-lib.test.js`：4/4 通过；覆盖无共享 `lib/` 写入的内存快照幂等比较、staged `./client.js` export 和发布文件列表。
- Desktop profile 证据：`pnpm exec vitest run apps/desktop/tests/profile-mcp.spec.ts`：1/1 通过，profile layers 包含 `@deepseek-ai/dsh-bot`。

### Step 2 Completed — Bot/native 导航状态

- `src/client/index.js` 以 apply-owned `botViewChosen` 区分显式 Bot 导航、Bot-owned Session 和普通 native Conversation；`setSurface('agent')`/`setSurface('bot')` 同步 layout panel；inactive panel 不挂载 Bot groups。
- `test/surface.test.js` 的相关单测通过；`client.js` 重新生成，`lib/client.js` 机械同步。

### Step 3 Completed — 文档、golden 与真实组合

- README Summary 记录 Workgroup AI 只注册一个紧随 Plugins 的一级 Bot，复用 native Conversation，并仅在 Bot 选中时启用 replacements。
- `navigation.expected.md` 记录稳定 ARIA 顺序：Plugins、Bot、Automation tasks。
- `bot-entry.e2e.ts` 使用真实 Loader/profile 组合，现覆盖：唯一 Bot 行与顺序、native New Session 隔离、Bot-owned Session 选中状态、Plugins/Automation tasks 退出、保存为 agent mode 后点击 Bot，以及切回 classic Agent mode 后撤销 Bot surface；两组 BrowserContext 均无 page error/warning。
- `WORKGROUP_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/bot-entry.e2e.ts`：1/1 通过（最近一次 67.8s；包含 Automation tasks、classic Agent 反向切换和完整流程 tripwire）。

### Step 4 Completed — 最终验证与受限 review

- Build：`pnpm run build:artifacts` 7/7 gates 通过；`pnpm run build:check` 2/2 通过；最新 `pnpm run typecheck` 5/5 通过；`build-client.mjs --check`、`build-lib.mjs --check` 与 `cmp -s client.js lib/client.js` 通过。
- 相关 Vitest：sidebar/profile/identity/Desktop 4 files、32 tests 全部通过；identity 为 16/16，Desktop profile 为 1/1。
- 包级 lint：0 errors、18 warnings，通过。根级 lint 实际非零（961 errors、730 warnings）；筛查交付文件未发现新增硬错误，非零诊断来自仓库既有范围，未修复无关文件。
- DS Bot 串行全套：629 tests，628 pass、1 fail；唯一失败为未改动的 `test/dsh-update.test.js:124`，`current: null` 时读取最近 package manifest 版本（实际 `0.2.1-alpha.3`，期望 `null`）。并发运行曾因共享临时资源产生额外失败；build-lib 测试已改为内存快照比较，不再写共享 `lib/`。
- `pnpm run test:gui`：完整运行后非零，7 个范围外用例超时/打包失败；直接相关 `packages/client/ui-sidebar/tests/panel-list.client.spec.tsx` 通过。`WORKGROUP_SNAPSHOT=replay pnpm run test:web`：build 9/9 通过，但全套 Web 在 10 分钟上限前有范围外 `document-preview.e2e.ts` 失败并超时；未修改这些无关用例。Focused Bot e2e 在隔离运行中通过；一次并行运行的 `page.goto` 超时归因于资源竞争，未作为功能通过证据。
- `git diff --check` 通过；受限 review 覆盖 Client 状态机、staged manifest、build-lib 测试、Desktop profile、Web e2e、tsconfig 与生成 artifact。未发现 P0/P1/P2 功能缺陷；未运行真实 Desktop Electron 窗口/跨平台打包，Desktop 结论仅为 profile/composition 证据。

### 未解决风险与边界

- 全套 DS Bot、GUI、Web、根级 lint 仍有非零结果，不能宣称仓库全绿；这些失败均已定位到未改动的既有或范围外测试/规则。
- 本次 focused e2e 仅验证 en-US；Bot-owned plain Agent Session、sidebar 折叠/展开、独立 teardown disposer 和 analytics 仍未单独断言。
- 未执行真实 Desktop Electron runtime、Windows/macOS 安装包或跨电脑验证。

### 2026-10-16：执行期间追加的最小修正（用户已继续批准）

- `application/apps/web/tsconfig.json`：将 scaffold-based `bot-entry.e2e.ts` 加入排除清单；此前 `pnpm run typecheck` 因 host `Context` 依赖越出 client `rootDir` 失败，修改后 5/5 gate 通过。
- `application/apps/desktop/tests/profile-mcp.spec.ts`：增加 Desktop profile 包含 `@deepseek-ai/dsh-bot` 的直接断言，1/1 通过。
- `application/packages/bundle/ds-bot/scripts/build-lib.mjs` 与 `test/build-lib.test.js`：增加 `current` 内存快照参数；先观察到 stale 快照回归 RED（3 pass/1 fail），修正后 4/4 GREEN，消除并发 suite 写共享 `lib/` 的竞争。
- `application/apps/web/tests/bot-entry.e2e.ts`：增加 Automation tasks 退出和 classic Agent mode 反向切换断言；最新 focused replay 1/1 通过。

### Execution Result

核心交付满足 Implementation Plan 的 Bot 一级入口导航目标，Web 真实组合与 Desktop profile composition 证据通过；仓库级全套验证仍受既有/范围外非零门禁阻塞，按上文记录，未将其伪报为通过。
