# F-07 / F-08 / F-09：Bot 一级导航、原版页面保留、局部挂载

**任务 ID：** F-07（Bot 顶级导航唯一按钮置于插件正下方）、F-08（进入 Bot 后完整保留原版 Chief/Bots/私聊/群聊）、F-09（仅将 DS Bot 全局 shadow/slot 挂载改为 Bot 页面内局部生效）

**执行日期：** 2026-10-15

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**证据等级：** **L**（真实浏览器 + 真实 DSH Web + 真实 DS Bot。无 N 级双机结论）

## 完成条件与结论

> **本节于 2026-10-15 更正。** 原结论的 PASS 建立在 `dev/bench.sh` 建的环境上：该脚本手工往 profile 写 `"ds-bot": "link:<checkout>"` 并 `pnpm install`，**补上了真实产品没有的 bundle 解析步骤**。真实产品路径下该 bundle 无法解析，`loadProfileDirectory` 静默跳过，Bot 入口根本不出现。下表为更正后的状态。

| 任务 | 条件 | 结果 |
|---|---|---|
| F-07 | 一级导航唯一 Bot 按钮，位于插件正下方 | **PASS（已用真实产品路径复验）** — profile 由产品自身初始化，实测 `Plugins=0, Bot=1`，且只有 1 个 Bot 条目（13/13） |
| F-08 | 进入 Bot 后完整保留原版 Chief/Bots/私聊/群聊 | **PASS** — 原版团队侧边栏 + Chief 卡片 + 真实聊天（`Message Chief` 输入框） |
| F-09 | 全局 shadow 改为页面内局部生效 | **PASS** — 离开 Bot 后 Plugins 页 **0 个** Bot UI 节点残留 |

**UI 自动化（bench 环境，保留为历史证据）：** `f07/f08/f09 ui: 18/18 checks passed`

**UI 自动化（真实产品路径，2026-10-15 复验）：** `f07 product ui: 13/13 checks passed`

**快速回归：** `integrations/workgroup/tests/bot-entry.spec.ts` 与 `integrations/ds-bot/tests/builtin-bundle.spec.ts` 通过

### 原验证的盲点（记录以免重犯）

`bench.sh` 的 `ensure_profile()` 写的是 `"ds-bot": "link:$PLUGIN"`，而产品写入的是 `dependencies: {}`。两者在"bundle 能否解析"这一点上不等价，而当时的检查只断言 `PROFILE_TEMPLATES.web.bundles` **含** `'ds-bot'` 这个名字——查的是配置里有没有写，从不验证这个名字在生产 profile 里能否解析。现在 `builtin-bundle.spec.ts` 用真实 `loadProfileDirectory` 断言 `skippedBundles` 不含该 bundle，并已反证：改回裸名后该断言失败。

## 实现的三个关键设计决定

### 1. Bot 入口的 id 就是 `conversation`（F-07 + F-08 的核心）

侧边栏的面板行调用 `selectPanel(entry.id)`，所以**入口的 id 是它唯一能影响中间列的手段**。而三条来自 DSH 源码的硬约束决定了这个 id 不能随便取：

1. `main` 是 keyed slot，DSH 只保留了一个键——`conversation`——用于中央会话区。`ui-layout` 的契约原文：其他键 *"receives no Session binding"*，即选了也是空列。
2. `main.conversation` **只能声明一次**，`ui-conversation` 已经声明了它。第二次声明会抛错（`slots.register` 的 "already declared"），并且会连带让整个插件加载失败。
3. `renderSlot` 只授予**声明了该 slot 的条目**，所以我的面板无法渲染别人的 slot。

因此把入口命名为 `conversation`：点击即选中**真实的会话区**（真实聊天、真实 Session 绑定），DS Bot 的替换因为该入口激活而落在它上面。**一份聊天，一次声明，不可能与 shell 漂移。**

这比"另建一个面板"更小也更正确——后者必然要么空白，要么成为第二套要同步维护的聊天 UI。

### 2. 表面挂载由"入口是否激活"门控（F-09）

`surface.js` 的 `groupsFor` 增加 `panelActive`：

```js
const on = mode === 'bot' && panelActive
return { shell: on, conversation: on && !plain }
```

`panelActive` 默认 `true`，所以**把 DS Bot 当普通插件安装的 profile 行为完全不变**（无人注册入口，无人设置这个标志，团队就是整个界面——上游行为）。只有本 Fork 注册了入口时才武装这个门控。

**顺序是承重的：** `registerBotPanel()` 必须在门控 effect **之前**调用。我最初写反了，门控 effect 先执行、读到 `panelRegistered === false` 就直接跳过订阅，此后永不重试——实测表现为"点 Bot 后表面永远不切换"。

### 3. 重建外壳的 CSS 按属性限定作用域（F-09 的另一半）

`styles.js` 里那段 *"Shell chrome reshaped for the team view"* 原本**全局**隐藏了：

```css
[class*="_logoRow"],[class*="_newSession"],nav[class*="_panelList"]{display:none!important}
```

**它连一级导航一起隐藏了**——也就是用户离开团队视图所必需的那个入口。这是实测发现的最严重问题：截图显示侧边栏只剩团队列表，导航完全消失。

修复：所有规则加 `html[data-wg-bot-panel="on"]` 前缀，属性由面板激活状态设置与清除。同时**彻底移除隐藏 `nav.panelList` 的规则**——导航任何情况下都不该被隐藏。

## 开发中被真实运行暴露并修复的缺陷

### 缺陷 1：`panelRegistered is not defined`（导致整个插件加载失败）

我在门控 effect 里读取 `panelRegistered`，但在一次重构中删掉了它的声明。浏览器只报 `web boot: 1 entry did not activate / ds-bot: failed`，**没有任何可用的错误信息**。

**定位手段：** 写了 `application/integrations/ds-bot/tests/apply-harness.mjs`，用最小的假 shell 在 Node 里驱动真实 bundle 的 `apply`，直接拿到 `ReferenceError` 与行号。这个 harness 后来成了 F-07/F-08/F-09 的快速回归网（不需要浏览器）。

**这个缺陷值得记录的原因：** 浏览器端插件错误被吞掉，只留一句"某个条目未激活"。没有这个 harness，只能靠反复注释代码二分——而我确实先试了那个办法，浪费了好几轮。

### 缺陷 2：构建错误被 shell 管道吞掉

我多次用 `pnpm ... 2>&1 | tail -1` 查看构建结果，`tail` 只留下 esbuild 输出的最后一个 `}`，**退出码被管道吃掉**，于是我把一次真实的构建失败（`Could not resolve "./bot-panel.js"`）误判为成功，并在此基础上继续排查了很久。

**教训与修正：** 现在显式检查 `${PIPESTATUS[0]}` 并确认产物存在（`ls -la client.js` + 检查 bundle 里是否含目标字符串）。

### 缺陷 3：`bot-panel.js` 在二分排查中被删除

我用 `git checkout` 回退源码时，未跟踪的 `bot-panel.js` 被一起清掉。因为缺陷 2 掩盖了构建失败，我没有立刻发现。**恢复方法：** 从记忆中重建该文件（内容很小，且行为已由 harness 验证）。

### 缺陷 4：选中 `conversation` 约 200ms 后被 shell 清回 `null`

实测时序（每 200ms 采样）：

```
t=0ms    attr="on"  btSide=true      ← 点击后表面挂载
t=200ms  attr="on"  btSide=true
t=400ms  attr=null  btSide=false     ← 被清回默认视图
t=600ms  attr=null  btSide=false     （此后一直是 null）
```

**根因（读 `ui-layout` 源码确认）：** `retainMainPanels` 会清除"不在 `ctx.slots.entries('main')` 里"的选中项。`conversation` 虽然是保留键，但 `ui-conversation` 是以 **root occupant** 的方式注册它（`registerConversationRoot` 注册的是 `main.conversation`），`entries('main')` 收集的是 `key` —— 时序上这次收集发生在清除判定之前，于是 `conversation` 被判为"未注册"，选中项被清空。

**因此 `activePanelId` 无法区分"用户选了 Bot"与"从未选择"——两者都是 `null`。**

**修复：** 不依赖 id，而是**观察选择动作本身**。包装 `layout.selectPanel`，记录用户选的是不是 `conversation`（或清回默认视图的 `null`）；门控读这个记录而不是读 id。包装器原样调用原方法，shell 仍完全掌控布局，这里只观察。

这比"把 `conversation` 也塞进 main 注册表"更稳妥：后者要改 DSH 的注册方式，而 `main.conversation` 的声明权已经属于 `ui-conversation`。

### 缺陷 5（测试自身）：harness 泄漏未处理拒绝

`apply-harness.mjs` 里插件的轮询定时器在测试文件结束后仍会触发，读取未 stub 的 `document` 并抛未处理拒绝，使**全绿的测试以退出码 1 结束**。修复：harness 捕获 `setTimeout` 句柄并提供 `stopTimers()`，spec 在 `apply` 后调用它。

## 修改文件

| 文件 | 改动 |
|---|---|
| `application/packages/bundle/ds-bot/src/client/index.js` | 注册 Bot 入口（`order: 1`，id `conversation`）；增加面板激活门控 effect 与 `panelRegistered` 标志；调用顺序调整 |
| `application/packages/bundle/ds-bot/src/client/surface.js` | `groupsFor` 增加 `panelActive`，两组表面均由它门控 |
| `application/packages/bundle/ds-bot/src/client/styles.js` | 外壳重塑 CSS 全部限定到 `html[data-wg-bot-panel="on"]`；**删除隐藏 `nav.panelList` 的规则** |
| `application/packages/bundle/ds-bot/src/client/bot-panel.js`（新增） | 入口图标组件 |
| `application/packages/bundle/ds-bot/client.js` | 重新构建的 bundle（由 `npm run build` 生成，非手工编辑） |
| `application/integrations/ds-bot/tests/apply-harness.mjs`（新增） | 无浏览器的 `apply` 驱动与注册记录 |
| `application/integrations/workgroup/tests/bot-entry.spec.ts`（新增） | 10 个回归测试 |
| `application/tests/app-f07-ui-check.mjs`（新增） | 18 项真实浏览器检查 |

## 真实执行证据

### 真实浏览器三态测量（关键证据）

```
initial       attr=null  activeNav=(无)      btSide=false  btRows=0  navLabels=[Plugins, Bot, Automation tasks]
after Bot     attr="on"  activeNav=Bot       btSide=true   btRows=1  navLabels=[Plugins, Bot, Automation tasks]
after Plugins attr=null  activeNav=Plugins   btSide=false  btRows=0  navLabels=[Plugins, Bot, Automation tasks]
```

三态语义完全正确：进入 Bot 时属性为 `on`、团队侧边栏挂载；离开后属性清除、团队表面**卸载**；**一级导航在三种状态下都存在**。

### UI 自动化 18/18

```
ok   the Plugins entry is present (index 3)
ok   a Bot entry is present (index 4)
ok   Bot is directly below Plugins (Plugins=3, Bot=4)
ok   there is exactly one Bot entry
ok   the first-level navigation has no "Chief" / "Writer" / "Coder" / "Group chats" / "Chats" entry
ok   the Bot entry is clickable
ok   the original team sidebar renders inside the Bot panel
ok   there is a real Chief in the team state
ok   Chief's own row is visible in the panel
ok   the panel hosts the real Conversation composer
ok   no Bot UI remains on the Plugins page (found 0: )
ok   the Plugins page shows the shell's own content
ok   the team sidebar is withdrawn on the Plugins page (rows=0)
ok   the team interface returns when Bot is selected again

f07/f08/f09 ui: 18/18 checks passed
```

### 截图（`application/docs/workgroup-ai/evidence/f07-f09/`）

- `f07-01-navigation.png` — 一级导航：`Plugins` 正下方是 `Bot`（选中态高亮），其后 `Automation tasks`
- `f08-01-bot-panel.png` — 进入 Bot：DS Bot 品牌头、Chief 卡片、"Chief of Staff"、原版聊天（`Hi, I'm Chief. Pick a model for me first.` + 模型按钮 + `Message Chief` 输入框）；**一级导航保留在其上方**
- `f09-01-plugins-page.png` — 切回 Plugins：shell 原生内容，无 Bot 残留
- `f09-02-return-to-bot.png` — 返回 Bot：团队界面恢复

### 回归

```sh
$ pnpm run build                              # application 全量
 run-gates: 9 passed, 0 failed, 0 skipped in 57.12s.

$ node scripts/build-client.mjs --check       # bundle 与源码一致
 CHECK_EXIT=0

$ npm test                                    # DS Bot 单测（在 application 内）
 ℹ tests 544 / ℹ pass 542 / ℹ fail 2

$ node dev/smoke.mjs f07 3190                 # 功能 smoke（改动后重跑）
 smoke: all 40 steps passed

$ node tests/app-f04-ui-check.mjs ... f07 3190   # F-04 原有 UI 回归
 f04 ui: 15/15 checks passed
```

**F-04 的 15/15 通过是本次改动最重要的回归证据**：它覆盖 Chief 私聊、普通群聊、详情面板、模型选择器、`Create group chat` 入口——全部仍然工作。

**542/544 与 F-04 基线一致。** 那 2 个失败（`at-menu.test.js` 的 `dsh-session-reference` 解析、`dsh-update.test.js` 的布局假设）在 F-04 就已定位为 DS Bot 测试 harness 对 DSH 安装布局的假设，与本次改动无关——本次改动前实测同样是 542/544。

## 未完成与风险

| 项 | 状态 |
|---|---|
| Windows/macOS 安装包中的真实验证 | 未做（需真实打包），归 Q-04 |
| Desktop（Electron）端的同样的三态验证 | **未做**。本轮全部在 Web profile 上验证；Desktop 用同一 `PROFILE_TEMPLATES.web` 与同一客户端 bundle，但未实测 |
| 双机协作下的 UI | 未做，归 Q-01 |
| 会话区在不同宽度下的表现 | 未做。侧边栏折叠态下 Bot 入口仍可见（实测），但未验证窄屏下的团队列表布局 |
| 冲突样式是否还有遗漏 | 已处理 `logoRow`/`newSession`/`panelList`/`footArea`/`widthHandle`；未逐一核对 DS Bot 全部 CSS 选择器对 shell 的影响 |
| 工作群 UI（A-03/A-04） | 未做。本轮只完成"Bot 入口 + 原版页面"，工作群视图是后续任务 |

**一条重要事实：** 本轮把 DS Bot 从"覆盖整个界面"改成"只在 Bot 页内生效"，这**改变了上游的默认交互模型**（上游 DS Bot 安装后团队就是整个界面）。对本 Fork 而言这是需求要求的（DSH 一级导航必须保留），且通过 `panelActive` 默认值保住了"普通插件安装"的上游行为。但这是**行为差异**，需要在发布说明中告知。

## 下一步

F-11（Task Session 原生 Bot 身份持久化 PoC），这是 G3 门槛，也是跨用户委派真实执行的前置。
