# F-06：单一 Bot Host 内置/自动加载，不重复初始化

**任务 ID：** F-06

**执行日期：** 2026-10-15

**DSH 版本：** `dsh-v0.2.1-alpha.3`（SHA 见 UPSTREAM_LOCK.md）（含本任务补丁）

**DS Bot 版本：** `v0.1.5`（SHA 见 UPSTREAM_LOCK.md）

**证据等级：** **L**（本机真实进程 + 真实浏览器 UI + 真实 smoke）。

## 完成条件与结论

| 条件 | 结果 |
|---|---|
| 安装后即带 Bot，无需用户安装插件 | **PASS** — `@deepseek-ai/dsh-bot` 是 web profile 的默认 bundle |
| 只有一条挂载路径 | **PASS** — 只有 DS Bot 自身的 `cordis.patch.yml` 插入 host 行 |
| 冷启动无重复 Host | **PASS** — 冷启动后 Host 进程数 = 1 |
| 重启无重复 Host | **PASS** — 重启后 Host 进程数 = 1，且 stale lock 被新 Host 接管 |
| 内置后功能完整 | **PASS** — smoke 全 40 步通过 |

## 实现

只改一处：`application/packages/boot/app-boot/src/profile.ts` 的 `PROFILE_TEMPLATES.web.bundles`

```js
  web: {
    // Workgroup AI fork: DS Bot is a first-class part of this product, so it is a default
    // bundle of every base-backed surface rather than something the user installs. Listing
    // it here is what makes "install once, Chief is already there" true, and it keeps one
    // mount path: the bundle's own cordis.patch.yml inserts the host row, and no profile
    // adds a second one.
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-bot'],
  },
```

**为什么这就是全部改动：** DS Bot 的 `package.json` 已经声明了上游 bundle 契约（`dsh.bundle.patch: ./cordis.patch.yml`，且 `cordis.patch.yml` 用 `insert` 挂载 `id: bot / name: @deepseek-ai/dsh-bot`）。它本来就是合法 bundle，缺的只是"被产品默认选中"。Desktop 客户端的项目 profile 也来自 `PROFILE_TEMPLATES.web`（`apps/desktop/src/project-manager.ts` 的 `WEB_PROFILE = PROFILE_TEMPLATES.web`），所以这一处改动同时覆盖 Web 与 Desktop 两个面。

**桌面端的三条 project-metadata 写入路径**（`createRuntimeProjectMetadata`、`createDevelopmentProjectMetadata`、`createPluginProfile`）都通过 `[...WEB_PROFILE.bundles]` 展开同一模板，而不是各自罗列 bundle 名。测试固定了这一点：`spreads === 2`（另有一处 `initProfile` 调用传数组而非字面量）且**不存在** bundle 字面量数组，因此不会出现"开发态有 Bot、打包后没有"的漂移。

## 开发中修正的一个真实设计错误

我最初创建了 `packages/bundle/workgroup-bot`，把 DS Bot 作为依赖再由该 bundle 插入 host 行。**这会制造第二条挂载路径**——正是 F-06 明令禁止的情况，两个 host 挂在同一 `DSH_HOME` 上会争抢 `state.lock`，失败方降级为只读团队。该包已移入回收站，改为只让 DS Bot 自身作为 bundle。

## 真实执行证据

### 测试

```sh
$ pnpm vitest run integrations/ds-bot/tests/builtin-bundle.spec.ts   # 该 spec 现在断言 packages/bundle/ds-bot 的清单与 profile 模板
 Tests  8 passed (8)
```

覆盖：web 模板包含 `@deepseek-ai/dsh-bot` 且**恰好一次**；无 Bot UI 的面（acp/headless/sdk/sdk-minimal）与匿名 profile 默认**不含**它；DS Bot 包可解析且入口导出 `apply` 与 `inject`（违背则 Loader 会丢弃 namespace）；patch 中挂载 host 的行**只有一行**且 id 为 `bot`；桌面首启 profile 初始化后含且仅含一次；恢复流程 `disableAllPlugins()` 保留内置 Bot、清掉第三方 bundle；元数据写入点均为模板展开。另有一项解析门禁：用真实 `loadProfileDirectory` 驱动与 Desktop 首启等价的 profile，断言该 bundle 落在 `layers` 而非 `skippedBundles`（详见 F-07 文档的更正说明）。

### 冷启动（干净 `DSH_HOME`）

```
WEB_UP after 8s
dsh web: http://127.0.0.1:3183/?token=<masked>
冷启动后 $DSH_HOME/bot/ 出现: state.lock
Host 进程数: 1
```

### 重启（同一 `DSH_HOME`，且前一 Host 被强杀留下 stale lock）

```
WEB_UP after 7s
# 冷启动 #1  lock: pid 62224, token dadc0dbc-…  since 1791997709865
# 重启   #2  lock: pid 20020, token e3bcbb1f-…  since 1791997767650
Host 进程数: 1
state.json 保持: revision=1, bots=0, mainBotIds=0
```

pid 与 token 都变了、Host 数仍为 1，说明是**新的单一 Host 接管**，而不是两个 Host 并存。stale lock 被正确接管也是真实场景（强杀后重启）验证到的行为。

### 内置后功能完整（smoke，40 步）

```
smoke: all 40 steps passed
SMOKE_EXIT=0
```

含 Chief 初始化、创建下属 Bot、私人聊天、普通群聊、Bot 间接力、上下文分段与压缩、工作目录切换、主 Bot 角色、能力（MCP/技能）隔离、`Coder does not inherit Chief capabilities`。

### 一次真实的排查记录

首次 smoke 有 5 步失败（`Writer did not switch to a new part` 等）。根因是**我的 bench overlay 写成了空数组 `[]`**，缺少 `CONTEXT_WINDOW=100000` 与 `CHECK_RATIO=0.45`，导致 mock 模型的上下文窗口用默认值、分段阈值不达。补齐 overlay 并重置 bench 数据后 40/40 全过。**这是验证环境构造错误，不是产品缺陷。**

## 与 F-04 的关系

F-04 是"把 DS Bot 当插件装进 DSH 并跑通"（兼容基线）；F-06 是"把 DS Bot 变成产品自带"。F-04 的 bench profile 由我手工写了 `dependencies: { 'ds-bot': link:... }` 加 `bundles: [... , 'ds-bot']`；F-06 之后**产品模板本身就含该 bundle**，用户侧不再需要任何安装动作。2026-10-15 返工后该 bundle 的实名是 `@deepseek-ai/dsh-bot`（原为裸包名 `ds-bot`，真实产品路径无法解析）。

## 未完成与风险

| 项 | 状态 |
|---|---|
| Windows/macOS 安装包中内置 Bot 的实测 | 未做（需真实打包，归 Q-04） |
| 冷启动并发（同时开两个窗口）的实测 | 未做；DS Bot 的 `home-lock.js` 设计为第二个实例降级只读，本轮只验证了串行重启 |
| 已安装用户从旧 profile 升级 | 未做。已存在的 profile 其 `bundles` 数组仍写旧名 `ds-bot`，而模板已改为 `@deepseek-ai/dsh-bot`；旧名在新的安装锚点下解析失败，`loadProfileDirectory` 会静默跳过。需要迁移逻辑或用户重建 profile；**这是一个真实的上线风险**，归 H-13/Q-03 |

**升级风险说明：** 本轮只让**新建** profile 含 Bot。一个已经存在的 profile（用户先前手动建过）其 `dsh.profile.bundles` 保持原样，因此不会自动获得内置 Bot。DSH 在 `profile.ts` 中对 `RETIRED_BUNDLES` 有移出逻辑，但没有"补入新默认 bundle"的机制。

**2026-10-15 返工使该风险具体化：** 包名从裸名 `ds-bot` 改为 `@deepseek-ai/dsh-bot` 后，任何已存在的 profile 里那条旧记录都**不再能解析**，且失败是静默的（`skippedBundles`），表现为"升级后 Bot 入口消失"。真实产品需要一条 `ds-bot` → `@deepseek-ai/dsh-bot` 的重写迁移，本轮未实现。

## 下一步

F-07（Bot 顶级导航唯一按钮置于插件正下方），依赖 F-06。
