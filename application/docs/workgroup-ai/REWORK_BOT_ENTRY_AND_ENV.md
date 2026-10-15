# 两项返工：Bot 入口真实可用性 与 环境变量完全独立

**任务 ID：** F-05（环境变量独立）、F-06/F-07（Bot 内置与一级入口）

**执行日期：** 2026-10-15

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）

**证据等级：** **L**（真实产品进程 + 真实浏览器 + 真实构建产物）

## 为什么返工

用户指出两点未做到。核实后**两点都成立**，且根因比表面更深：

1. **Bot 入口在真实产品中根本不出现。** 代码里 `order: 1` 让它在侧边栏排在 Plugins（0）与 Automation tasks（10）之间——位置逻辑没错——但 `ds-bot` 这个 bundle 名在真实 profile 里**无法解析**，`loadProfileDirectory` 对解析失败是**静默跳过**，整个插件不加载。
2. **环境变量与官方 DSH 大面积共用。** 只改了默认目录名，变量名本身仍是 `DSH_*`。

**原验证为什么没抓到：** F-07 当时跑在 `dev/bench.sh` 建的环境里，该脚本手工往 profile 写了 `"ds-bot": "link:<checkout>"` 并 `pnpm install`，**补上了一个真实产品没有的解析步骤**。我把"bench 通过"当成了"产品通过"。

## 一、Bot 入口

### 修复

| 改动 | 内容 |
|---|---|
| 迁入 workspace | `integrations/ds-bot/upstream/ds-bot` → `packages/bundle/ds-bot`，包名 `ds-bot` → `@deepseek-ai/dsh-bot`，版本对齐家族 `0.2.1-alpha.3` |
| 解析锚点 | `apps/cli/package.json` 声明依赖，使安装锚点可解析该 bundle |
| profile 模板 | `PROFILE_TEMPLATES.web.bundles` 由裸名 `'ds-bot'` 改为 `'@deepseek-ai/dsh-bot'` |
| 构建管线 | 新增 `packages/bundle/ds-bot/tsdown.config.ts`（该包是纯 JS，无 `lib/types` 入口）；`workspacePackageGlobs` 按 `tsconfig.json` 过滤，只选编译型包 |
| 发布布局 | `scripts/build-lib.mjs` 补齐 `lib/client.js` 与 `lib/package.json`，并新增 `assertManifestRelativeReads` 防止 `import.meta.url` 相对读取漂移 |

### 顺带修出的两个真实缺陷

**（a）`ctx.workgroupHub` 属性代理误用。** `src/client/index.js` 用 `ctx.workgroupHub` 读取一个**可选**服务（注释自己写明"`undefined` 是 local-only 安装，不是错误"）。cordis 的属性代理对未声明名会**直接抛错**：

```
Error: cannot get property "workgroupHub" without inject
```

后果是 Bot 入口在任何未配置 Hub 的安装上**整体加载失败**，页面停在 "Failed to load plugins"。项目自己的 `packages/AGENTS.md` 规定了正确写法（可选服务用 `ctx.get(name)`）。这是**真实产品缺陷**，与改名无关。

**（b）嵌套 `node_modules` 未被门禁排除。** `scripts/cordis-config-files.ts` 的 `exclude: ['node_modules/**']` 锚定在扫描根，匹配不到 `packages/bundle/ds-bot/dev/harness/node_modules/**`，导致上游安装产物被当成仓库配置参与校验。已改为 `**/node_modules/**`（该修正同时消除仓库内其它嵌套安装的同类漏网）。

### 决定性证据（真实产品路径，非 bench）

profile **完全由产品自己初始化**（`dependencies: {}`），无手工 link：

```sh
$ WORKGROUP_HOME=D:/tmp/wg-f07-final node --import tsx/esm apps/cli/src/bin.ts web --port 3416 --no-open
$ node tests/app-f07-product-ui-check.mjs <repo> <login-url> docs/workgroup-ai/evidence/f07-product

preview notice dismissed: false
first-level rows: ["Plugins","Bot","Automation tasks"]
ok   the Plugins entry is present (index 0)
ok   a Bot entry is present (index 1)
ok   Bot is directly below Plugins (Plugins=0, Bot=1)
ok   there is exactly one Bot entry (found 1)
ok   the first-level navigation has no "Chief" entry
ok   the first-level navigation has no "Writer" entry
ok   the first-level navigation has no "Coder" entry
ok   the first-level navigation has no "Group chats" entry
ok   the first-level navigation has no "Chats" entry
ok   the first-level navigation has no "Bots" entry
after Bot click: {"attr":"on","teamRows":0,"hasComposer":false}
ok   entering the Bot entry mounts the team surface (attribute set)
after Plugins click: {"attr":null,"navCount":3}
ok   leaving the Bot entry withdraws the team surface
ok   the first-level navigation is intact (3 rows)

f07 product ui: 13/13 checks passed
```

截图（`docs/workgroup-ai/evidence/f07-product/`）：

- `f07-product-navigation.png` — 一级导航 `Plugins → Bot → Automation tasks`
- `f07-product-bot-panel.png` — 进入 Bot：Chief 卡片、"Chief of Staff"、原版聊天（`Hi, I'm Chief. I don't have a model yet.`）、`Message Chief` 输入框；**一级导航仍在其上方**
- `f07-product-back-to-plugins.png` — 离开 Bot：团队表面卸载，导航完好

### 门禁（防止复发）

新增 `integrations/ds-bot/tests/builtin-bundle.spec.ts` 的解析断言：用真实 `loadProfileDirectory` 驱动一个与 Desktop 首启等价的 profile，断言该 bundle 出现在 `layers` 而非 `skippedBundles`。

**已反证有效**：临时把 `profile.ts` 改回裸名 `'ds-bot'`，该断言失败（`Tests 5 failed | 4 passed`）。

## 二、环境变量完全独立

### 规模

清点结果：**382 个 `DSH_*` 变量、5225 处**，其中 69 个被产品运行时代码读取。

### 改名

| 项 | 旧 | 新 |
|---|---|---|
| 数据根变量 | `DSH_HOME` | `WORKGROUP_HOME` |
| agents 根变量 | `DSH_AGENTS_HOME` | `WORKGROUP_AGENTS_HOME` |
| agents 默认目录 | `~/.agents` | `~/.workgroup-ai-agents` |
| 受管 shell 命名空间 | `DSH_ENV_PREFIX = 'DSH_'` | `'WORKGROUP_'` |
| 子 shell 秘密命名空间 | `$DSH_SECRET_<NAME>` | `$WORKGROUP_SECRET_<NAME>` |
| 全部其余变量 | `DSH_*` | `WORKGROUP_*`（826 文件 / 3943 处） |

**刻意保留**（改名的价值在于消除冲突，不在于统一字面量）：

- `DSH_` 被加入 `BOOTSTRAP_PREFIXES` 与 `LAUNCHER_OWNED_PREFIXES` 的**拒绝**列表——官方产品的变量不得被本产品当作自己的配置读取。
- 包名 `@deepseek-ai/dsh-*`、常量标识符 `DSH_HOME_ENV` / `DSH_ENV_PREFIX`（值已改，名字未改以免 churn 全部 import 点）、`.agents/notes/archived/`（仓库冻结的历史）。

### 打包身份

| 缺陷 | 修复 |
|---|---|
| `.env.windows.example` / `.env.macos.example` 里 `DSH_DESKTOP_APP_ID=com.deepseek.harness`（官方 appId，且**优先级高于** Fork 默认值） | 改为 `WORKGROUP_DESKTOP_APP_ID=ai.workgroup.workgroup-ai` |
| `localMacOSPackageEnvironment` 硬编码官方 appId | 改读 `PRODUCT_APP_ID` |

实测（`apps/desktop/scripts/electron-builder-config.mjs` 真实调用）：

```
appId        = ai.workgroup.workgroup-ai
productName  = Workgroup AI
protocols    = [{"name":"Workgroup AI","schemes":["wgai"]}]
artifactName = workgroup-ai-${version}-${os}-${arch}-unsigned.${ext}
SHARES_WITH_OFFICIAL         = false
SHARES_SCHEME_WITH_OFFICIAL  = false
SHARES_ARTIFACT_PREFIX       = false
```

新增两条门禁（`integrations/product/tests/identity.spec.ts`，已反证：把模板改回官方 appId 后断言失败）。

### 未改动（附理由，不当作已完成）

- **更新渠道名**（`nightly` / `latest`）：它是**官方更新协议的预发布开关**，改名后更新器无法工作。我曾误改为自定义渠道，已回退。
- **更新源站与路径前缀**（`https://download.deepseek.com`、`dsh-desk/...`）：这是真实存在的跨产品更新风险，但涉及 111 处测试断言与发布基础设施，**本轮未动**，见"未完成"。
- **`DSH_HARNESS`**：DS Bot 测试台指向 DSH checkout 的变量，已随包内改名一并处理。

## 复验：工作区变更后的重跑

首轮验证之后工作区又发生了变更（构建/测试基建的后续修补），因此重跑了全部受影响验证，**发现并修复了两个首轮漏掉的门禁失败**：

| 门禁 | 首轮状态 | 原因 | 修复 |
|---|---|---|---|
| `third-party-notices`（`scripts/gen-third-party-notices.spec.ts`） | **1 failed / 36 passed** | `browser-bundled-externals.ts` 对每个 `dsh.client` 包都真打包其 browser 入口；`react` 只装在 `packages/client/ui-chat/node_modules/`，从 ds-bot 解析不到，22 个 client 文件全部报错 | 把 `react` / `react-dom` 声明为 devDependencies（与仓库其它 client 包一致） |
| `doc-standard` | **1 failed** | 包迁入 `packages/` 后必须符合 README 骨架规范；DS Bot 的 README 是上游格式，缺 `## Table of Contents` 与 `## Dev Note` | 补齐两个骨架段 |

**首轮为什么会漏**：`verify-third-party-notices` **不在** `run-gates.ts` 里（grep 计数 0），所以 `hygiene` 的 18/2 看不到它；它由 vitest 车道的 `scripts/gen-third-party-notices.spec.ts` 断言，而首轮只跑了 `integrations` 车道。这是**验证覆盖面的缺口**，不是巧合。

复验结果：

```sh
$ pnpm vitest run scripts/gen-third-party-notices.spec.ts
Tests  37 passed (37)                                      # 修复前 1 failed | 36 passed

$ pnpm run verify-third-party-notices
gen-third-party-notices: THIRD_PARTY_NOTICES.md is up to date.   # EXIT=0

$ pnpm vitest run scripts/doc-standard.spec.ts
Tests  22 passed (22)                                      # 修复前 1 failed
```

### scripts 车道的其余失败均为既有环境问题

`pnpm vitest run scripts/` 在默认超时下报 33 项失败，降到 `--testTimeout=60000 --maxWorkers=4` 后为 17 项，逐个核实如下：

| 文件 | 本机结果 | 判定 |
|---|---|---|
| `scripts/local-bundle-registry.spec.ts` | 15 failed | **既有环境**：`capture('tar', ['-czf', <绝对路径>, '-C', <绝对路径>, ...])` 在本机 GNU tar 1.35 下退出码 2。该 spec 与实现**均未被我改动**，且其中 `WORKGROUP_`/`ds-bot` 字面量计数为 0 |
| `scripts/gen-dependency-catalog.spec.ts` | 1 failed | **既有环境**：断言 `npm config` 输出的 registry 设置，与本次改动零交集（同样两项计数为 0） |
| `client-build-environment.client.spec.ts`、`verify-application-entrypoints.spec.ts`、`compile-referenced-projects.spec.ts`、`run-gates.spec.ts`、`release/pack.spec.ts` 等 | 默认超时下失败 | **超时噪声**：单独运行或提高超时后全部通过（如 `client-build-environment` 的用例实际需 8637 ms，超过默认 5000 ms） |

## 验证约束（用户指令）

> **禁止把本项目任何插件或外部组件安装到本机已装的 DSH 应用；测试必须打开本项目应用进行。**

已遵守，并记录核查证据：

| 检查 | 结果 |
|---|---|
| `~/.dsh/profiles/desktop` 的 `ds-bot@0.1.5` | 来源 `git+https://github.com/Fei2411/DeepSeek-Bot.git`（**上游官方仓库**），安装于 10-14 20:46，**早于本次工作**；非本项目，也非迁移后的 `@deepseek-ai/dsh-bot` |
| `~/.dsh/profiles/workgroup` | 创建于 **10-13 21:28**，引用旧路径 `D:/code/ai/Workgroup-AI/code/...`，早于本次会话 |
| 是否含 `@deepseek-ai/dsh-bot` | **无** |
| 本次全部 `dsh` 启动 | 一律 `WORKGROUP_HOME=D:/tmp/wg-*`，**从不写 `~/.dsh`** |
| `~/.dsh` 在最后一次 UI 验证中被写入 | 仅 `sessions/--D-code-ai-DeepSeek-Bot--/`（**当前这段对话自身**的会话日志，由 DSH Desktop 写入）与 harness 诊断文件；本项目**结构上不可能**写它——它的数据根变量是 `WORKGROUP_HOME`，`DSH_HOME` 已被移出读取路径 |

UI 验证用的正是本项目应用本身：`WORKGROUP_HOME=<临时目录> node --import tsx/esm apps/cli/src/bin.ts web --port 3421 --no-open`，profile 由本项目自行初始化。

## 真实执行证据

```sh
$ pnpm run build
run-gates: 9 passed, 0 failed, 0 skipped in 73.46s.        # BUILD_EXIT=0

$ pnpm vitest run integrations
Test Files  13 passed (13)
     Tests  256 passed (256)

$ pnpm vitest run integrations/ds-bot/tests/builtin-bundle.spec.ts
Tests  9 passed (9)                                        # 含新增解析门禁

$ pnpm vitest run integrations/product
Tests  16 passed (16)                                      # 含新增身份门禁

$ pnpm vitest run scripts/verify-dsh-package-licenses.spec.ts
Tests  4 passed (4)

$ cd packages/bundle/ds-bot && npm test
ℹ tests 575 / ℹ pass 574 / ℹ fail 1                        # 与迁移前基线一致

$ pnpm run hygiene
run-gates: 18 passed, 2 failed, 0 skipped in 361.06s.      # 基线为 15 passed / 5 failed
```

### 门禁净改善：15 → 18 通过

我引入并已修复的 3 项：

- `application entrypoints` — `dev/logo.mjs` 未分类（已登记为 build-only 图形生成器）
- `DSH package licenses` — `@deepseek-ai/dsh-bot` 声明 Apache-2.0 而门禁要求 dsh 家族全 MIT。**这是真实的许可证合规问题**：DS Bot 是第三方代码，改成 MIT 会误述来源并丢失其许可要求的归属。已加**钉住上游许可**的豁免（比放行更强：许可值本身也被固定），并配 3 个规格测试
- `Cordis config`（我方部分）— 嵌套 `node_modules` 漏网，见上文缺陷（b）

### 剩余 2 项失败均为既有，与本轮无关

| 门禁 | 证据 |
|---|---|
| `vendor rescope` | 19 条残留，逐条核对**无一含 `ds-bot`/`workgroup`**；全部是 `schedule`/`docs`/`web-app` 等既有文件 |
| `Cordis config` | 仅剩 `apps/cli/tests/profiles/acp/cordis.yml: root must be a Loader entry array`，该文件未被本轮改动触及（`git status` 为空） |

另有一项既有失败已按官方机制修正：`no new unknown casts` 报告 `shell-env.spec.ts` 的指纹变化。核实为改名导致的**机械索引同步**（`HEAD` 版本第 186 行本就存在同一断言），用门禁自带的 `scanUnknownCasts` 刷新该文件条目，并断言**全仓断言总数不变（1362）**，因此不可能掩盖新增。

### DS Bot 单测的 1 项失败

`dsh-update.test.js > without a running version there is nothing to compare against`。测试注入 `current: null`，但 `currentDsh()` 会从 `process.argv[1]` 向上查找 `@deepseek-ai/` 包并读到实际版本，**覆盖了注入值**。这与迁移前基线完全相同（F-07 文档已记录），属测试基建对 DSH 安装布局的假设，**不记为本次通过**。

## 未完成与风险

| 项 | 状态 |
|---|---|
| 更新源站与路径前缀隔离 | **未做**。生产源仍为 `https://download.deepseek.com`，路径前缀仍为 `dsh-desk`。这是真实的跨产品更新风险，需要一并改 111 处测试断言与发布配置 |
| `desktop` 的 UI 三态验证 | **未做**。本轮在 Web profile 上验证；Desktop 用同一 `PROFILE_TEMPLATES.web` 与同一客户端 bundle，但未实测 |
| `dev/harness`（544MB）随包迁入 | 已随迁移进入 `packages/bundle/ds-bot/dev/harness`，未从 `tsdown` 聚合中排除前会拖慢门禁；当前已通过 `**/node_modules/**` 排除其内容 |
| 与官方 DSH 同时安装的双应用实测 | 未做（P 级，需两个真实安装包） |
| macOS 打包与双机协作 | 未做，分别归 Q-04 与 Q-01 |
| `dev/bench.sh` 路径假设 | 已随迁移失效（它假设 `PLUGIN` 在 checkout 顶层），本轮改用真实产品路径验证，**未修 bench 自身** |

## 下一步

1. 更新源隔离（改前缀与源站，同步 111 处断言）。
2. 桌面端三态验证。
3. 与官方 DSH 的双安装共存实测（P 级）。
