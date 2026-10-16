# Implementation Plan

> 本文件是 `docs/superpowers/plans/2026-10-16-desktop-hot-reload.md`（Mini Plan）的可执行版本。Mini Plan 保留为设计与取证记录，本文件是执行权威；两者冲突时以本文件为准，并在此登记差异。

## 修订记录

| 日期 | 修订 | 依据 |
| --- | --- | --- |
| 2026-10-16 | 新增 **Step 5**：交付新命令 `pnpm run dev:desktop:hmr`（桌面端热更新模式）；原 Step 5（端到端实测与文档回写）顺延为 Step 6；成功标准新增 **S7**；Changed Files 表新增两行 | 需求方要求"热更新桌面端必须有一个新的命令" |
| 2026-10-16 | Step 4 的 DS Bot 分类规则扩展：包根 `client.js` 归入浏览器侧（原规则误判为 Host 侧，导致默认命令下每次浏览器侧编辑都重启） | L 级实测发现（见下） |

### Plan Adjustment（第二次，2026-10-16）

**原计划**：Step 4 的 DS Bot 前置规则为 `src/client/**` → `client`，包内其余路径 → `restart`。

**新发现**：该规则把包根 `client.js` 一并判为 Host 侧，而 `client.js` 是 `build-client.mjs` 产出的浏览器半成品（`exports["./client"]` 指向它）。`dev:desktop:hot` 实测日志：

```
build-client: client.js rebuilt (1 changed file(s))
dev-desktop-hot: host-side change packages/bundle/ds-bot/client.js (DS Bot Host or shared half); restarting
```

于是默认命令下每次浏览器侧编辑都会完整重启，S2（浏览器侧零重启生效）不成立。`--hot-only` 不重启，掩盖了该缺陷。

**为什么需要调整**：产物与源码共用包根，仅按目录前缀无法区分；"浏览器半成品重建"正是热更新要覆盖的事件，必须归入 `client`。

**新增修改范围**：`classifySourceChange` 的 DS Bot 前置规则扩展为 `src/client/**` 或包根 `client.js` → `client`；`dev-desktop-hot.spec.ts` 增加对应断言。不新增抽象，其余路径判定不变。

### Plan Adjustment（第一次，2026-10-16）

**原计划**：只修 `dev:desktop:hot` 的三处静默失效（Steps 1–4），不新增命令入口。

**新发现（需求变更）**：热更新桌面端需要有**独立的新命令**，而不是依附于既有 `dev:desktop:hot`。既有 `dev:desktop:hot` 的语义是"全自动"——Host 侧改动会直接停壳重启，会打断正在进行的会话；而"热更新"本身（浏览器侧零重启替换）不需要也不应强制重启。

**为什么需要调整**：Host 半成品没有插件级热替换能力，因此"Host 改动要不要自动重启"是用户可感知的分叉。把两种语义拆成两条命令，比在一处隐式决定更可预期，也让新命令成为"热更新桌面端"的唯一明确入口。

**新增修改范围**：
- `application/package.json`：新增 `dev:desktop:hmr` 脚本（一行）。
- `application/scripts/dev-desktop-hot.ts`：新增 `--hot-only` 参数与 Host 改动的提示分支（不复制脚本、不新建第二个监督实现）。
- `application/scripts/dev-desktop-hot.spec.ts`：覆盖新参数的解析与未知选项拒绝。
- 既有 `dev:desktop:hot` 行为**保持不变**（默认仍自动重启）。

**语义对照**

| 命令 | 首次构建 | 启动桌面壳 | 浏览器侧改动 | Host 侧改动 | 适用 |
| --- | --- | --- | --- | --- | --- |
| `dev:desktop:hot`（既有） | 是（`--skip-build` 可跳过） | 是 | 零重启热替换 | 自动停壳重启 | 需要 Host 改动即时生效 |
| `dev:desktop:hmr`（新增） | 是（`--skip-build` 可跳过） | 是 | 零重启热替换 | **只提示不重启**（含可执行指引） | 不想被打断的长会话 |

## 1. Goal

### 本次修改目标

让"热更新桌面端"有一个独立命令，并让它真正实现"改源码即生效"。修掉三处静默失效，并交付新命令 `pnpm run dev:desktop:hmr`：

1. 浏览器侧（`packages/bundle/ds-bot/src/client/**`）：改动经重建 + HMR 广播 `rebuilt` 后在页面生效，**不重启 Electron**。
2. Host 侧（`packages/bundle/ds-bot` 除 `src/client` 外的一切、`integrations/workgroup/**`）：改动被正确识别；`dev:desktop:hot` 自动重启，`dev:desktop:hmr` 明确提示而不打断。
3. 消除 `lib/client.cjs` 这个无人读取的构建噪音。
4. 新增命令 `dev:desktop:hmr` 是"热更新桌面端"的入口，与 `dev:desktop:hot` 的差异只体现在 Host 改动的处置上。

### 不包含

- 不做 Host 插件级热重载（不触碰 Loader reload 语义、不改 Agent Loop）。
- **不新建第二个监督脚本**：新命令复用 `scripts/dev-desktop-hot.ts`（脚本名保持不变，避免重命名冲击既有 spec 与文档）。
- 不改打包与发布链路（`package:*`、`prepare:*`、`build-lib.mjs --check` 语义不变）。
- 不改 `exports` / `main` 指向源码（理由见 Mini Plan「被否决的替代方案」）。
- 不动 `server/`。
- 不重构现有 `dev-web.ts` / `dev-desktop-hot.ts` 的无关部分（不顺手格式化、不重命名既有导出）。
- 不改 `dev:desktop:hot` 的既有默认行为（默认仍自动重启，保证向后兼容）。

### 成功标准

| # | 标准 | 判定 |
|---|---|---|
| S1 | `dev:web` 不再把无 `tsconfig.json` 的 `dsh.client` 包交给 tsdown；`.dev-hot.log` 全日志无 `lib\client.cjs` 行 | 单机 + 日志证据 |
| S2 | 改 `src/client/i18n.js` → 日志出现 rebuilt + `browser-side change … no restart`，主进程未重启，UI 文案更新 | **L 级实测** |
| S3 | 改 `src/host/workgroup-hub.js` → 在 `dev:desktop:hot` 下重启，且 `cmp src/host/workgroup-hub.js lib/src/host/workgroup-hub.js` 一致 | **L 级实测** |
| S4 | 改 `integrations/workgroup/**` → 触发重启并生效 | **L 级实测** |
| S5 | `build-client.mjs --check` 与 `build-lib.mjs --check` 收工均退出码 0 | 单机 |
| S6 | 覆盖 S1–S4 的单测全绿，既有 `dev-web.spec.ts` 不回归 | 单测 |
| S7 | `pnpm run dev:desktop:hmr` 存在且可用：浏览器侧改动零重启生效；Host 改动只打印提示、壳保持存活；`--hot-only` 以外的选项行为与 `dev:desktop:hot` 一致 | **L 级实测** + 单测 |

未取得 S2/S3/S4/S7 的 L 级证据前，结论必须写 `NO-GO`。

---

## 2. Current Understanding

### 当前实现方式

`dev:desktop:hot`（`application/scripts/dev-desktop-hot.ts`）串三步：`build:artifacts` → 长驻 `dev:web --no-serve --skip-build`（客户端产物 watch）→ `start:desktop`（Electron），自身再轮询源码 mtime，改动分两类：`client` 不管、`restart` 则停壳 → `build:lib:host` → 重开壳。

`dev:web`（`application/scripts/dev-web.ts`）用 tsdown workspace watch + `tsc -b --watch` + `vite build --watch` 维护浏览器侧产物；`client-hmr` 插件 stat 轮询各 `dsh.client` 包的 `clientPath` 并发 SSE `rebuilt` 帧。

### 涉及模块

| 模块 | 路径 | 角色 |
|---|---|---|
| desktop 热循环 | `application/scripts/dev-desktop-hot.ts` | 源码轮询 + 分类 + 重启编排 |
| web 开发循环 | `application/scripts/dev-web.ts` | 客户端产物 watch 集合与阶段管理 |
| DS Bot 浏览器半成品构建 | `application/packages/bundle/ds-bot/scripts/build-client.mjs` | esbuild → 包根 `client.js` |
| DS Bot `lib/` staging | `application/packages/bundle/ds-bot/scripts/build-lib.mjs` | 渲染并写入 `lib/` 全树 |
| 包清单 | `application/packages/bundle/ds-bot/package.json` | `exports["./client"]`、`scripts` |
| 客户端产物解析 | `application/packages/client/modules/src/index.ts:828-850` | `clientPath = dirname(pkgPath) + exports["./client"]` |
| HMR 广播 | `application/packages/client/hmr/src/index.ts:55-110` | stat 三项变化 → `rebuilt` |
| HMR profile 挂载 | `application/packages/boot/app-boot/src/profile.ts:183-190`、`packages/bundle/web-app/cordis.patch.yml:218` | web profile 常驻 `client-hmr` + `@deepseek-ai/dsh-bot` |

### 数据流 / 调用链（修复前，缺陷所在）

```
Shell 页面加载 DS Bot 浏览器半成品
  packages/client/modules  → clientPath = packages/bundle/ds-bot/lib/client.js   ← 真正的加载目标
  packages/client/hmr      → 轮询同一 clientPath

dev:web 的 tsdown watch 集合 = discoverPluginDirs()（含 ds-bot，因它声明 dsh.client.platform=web）
  → tsdown 读 packages/bundle/ds-bot/tsdown.config.ts
  → 产出 lib/client.cjs                                                          ← 无读者（全仓 grep 零命中）

于是：改 src/client/** → 重写 lib/client.cjs → clientPath 未变 → 无 rebuilt → 页面不变
      改 src/host/**  → dev-desktop-hot 判为 'client'（缺 tsconfig.host.json → host face 为空集）→ 既不热更也不重启 → 永远跑旧快照
      改 integrations/workgroup/** → 不在 WATCHED_ROOTS → 连触发都没有
```

### 已确认的影响范围

- `lib/` 全树由包内 `build-lib.mjs` staging（`ENTRIES`：`index.js`、`web-search.js`、`client.js`、`src/host`、`src/shared`、`package.json`）；仓库构建（`build:lib:host` / `build:artifacts`）**不**跑它，`@deepseek-ai/dsh-bot` 被 `workspacePackageGlobs` 因缺 `tsconfig.json` 排除。
- `integrations/workgroup` 是 workspace 包，`@deepseek-ai/dsh-workgroup` 解析到它；`ds-bot/src/host/workgroup-hub.js` 跨包 import 其 `protocol/hub-client`、`client`、`bridge`。
- `integrations/ds-bot/` 是 13M 的 vendored upstream（含 `.dsh-test*` 残留），**不是** workspace 包，与本改动无关；监视范围不得整目录纳入 `integrations`。
- `packages/bundle/ds-bot/src/client` 的跨目录相对导入只有 `../shared/*`（已核实无其他越界导入），故浏览器侧的监视范围为 `src/client` + `src/shared`。
- `scripts/**/*.spec.ts` 被 vitest 收集；`packages/*/*/tests/**` 也会被收集，但 ds-bot 的测试目录是 `test/`（单数）且用 `node --test`，**不**进 vitest。
- 覆盖率门禁 `coverage.include` 仅 `packages/*/*/src/**`，本改动的脚本不在其中。

---

## 3. Implementation Steps

### Step 1 — `dev-web.ts` 拆分「tsdown 成员」与「自建浏览器半成品」

#### Target

- 文件：`application/scripts/dev-web.ts`
- 新增函数：`discoverSelfBuiltClientDirs(root?)`、`discoverBundledPluginDirs(root?)`、`selfBuiltWatchCommand(root, dir)`
- 修改：`main()`（约 383-431 行）的 watch 集合与诊断输出；顶部 `node:fs` import

#### Current Behavior

`discoverPluginDirs`（134 行）仅按 `dsh.client.platform === 'web'` 收集，返回 78 个目录（含 `packages/bundle/ds-bot`）。`main()` 把它们与 `discoverLibraryDirs()` 一起交给 `watchClientPlugins`，tsdown 由此为 ds-bot 产出 `lib/client.cjs`。诊断行只报总数。

#### Change

1. 顶部 import 扩为 `import { existsSync, globSync, readFileSync } from 'node:fs'`。
2. 在 `discoverLibraryDirs` 之后新增三个导出（保留上游 JSDoc 风格，标注 fork 归属）：

```ts
/**
 * Workgroup AI fork: list the client packages whose browser artifact is produced by their own
 * build script rather than by `tsc -b` plus tsdown. The predicate repeats the one
 * `scripts/workspace-package-globs.ts` applies to the bundling pass: a workspace member
 * shipping authored JavaScript has no `tsconfig.json`, so handing it to tsdown fails the whole
 * pass with "Cannot find entry". Measured on DS Bot, handing it over anyway silently produced a
 * second artifact (`lib/client.cjs`) that no loader reads, while the file the shell actually
 * loads — `exports["./client"]` — kept the previous build.
 * @param root - repository or fixture root passed to the discovery.
 * @returns workspace-relative package directories that own their browser build.
 */
export function discoverSelfBuiltClientDirs(root = repoRoot): string[] {
  return discoverPluginDirs(root).filter(dir => !existsSync(join(root, dir, 'tsconfig.json')))
}

/**
 * Client plugin directories the tsdown workspace pass may bundle: every browser half except the
 * self-built ones, whose own build script owns their watch stage.
 * @param root - repository or fixture root passed to the discovery.
 * @returns workspace-relative package directories for the tsdown workspace pass.
 */
export function discoverBundledPluginDirs(root = repoRoot): string[] {
  const selfBuilt = new Set(discoverSelfBuiltClientDirs(root))
  return discoverPluginDirs(root).filter(dir => !selfBuilt.has(dir))
}

/**
 * Resolve the command that watches one self-built package's browser half.
 * @param root - repository root.
 * @param dir - workspace-relative package directory.
 * @returns arguments for pnpm that start the package's own `build-watch` script.
 * @throws Error when the package declares no `name`, or no `build-watch` script.
 */
export function selfBuiltWatchCommand(root: string, dir: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    name?: string
    scripts?: Record<string, string>
  }
  if (manifest.name === undefined || manifest.name === '' || manifest.scripts?.['build-watch'] === undefined) {
    throw new Error(`dev-web: ${dir} ships its own browser half but declares no "build-watch" script; its sources would never reach the browser`)
  }
  return ['--filter', manifest.name, 'run', 'build-watch']
}
```

3. `main()` 改为：

```ts
  const pluginDirs = discoverPluginDirs()
  const bundledPluginDirs = discoverBundledPluginDirs()
  const selfBuiltDirs = discoverSelfBuiltClientDirs()
  const libraryDirs = discoverLibraryDirs()
  // 既有两条空集报错分支保持：pluginDirs.length === 0、libraryDirs.length === 0
```
随后把 `watchClientPlugins(repoRoot, [...pluginDirs, ...libraryDirs], …)` 改为
`watchClientPlugins(repoRoot, [...bundledPluginDirs, ...libraryDirs], …)`，并在其后为每个自建包起一个阶段：

```ts
  // A self-built browser half is watched by its own build script: the tsdown workspace pass
  // cannot consume it (missing entry) and, when handed over anyway, re-emits an artifact no
  // loader reads while the file `exports["./client"]` names stays at the previous build.
  for (const dir of selfBuiltDirs) {
    spawnStage(supervisor, `self-built client ${dir}`, 'pnpm', selfBuiltWatchCommand(repoRoot, dir), false)
  }
```
4. 诊断行改为分别报数并列出自建目录：

```ts
    console.log(
      `dev-web: watching ${String(bundledPluginDirs.length)} tsdown plugin packages,`
      + ` ${String(selfBuiltDirs.length)} self-built browser halves,`
      + ` and ${String(libraryDirs.length)} statically linked library packages`
      + …既有的 polling / shell dist / serving 片段…
      + ':\n  ' + [...bundledPluginDirs, ...selfBuiltDirs, ...libraryDirs].join('\n  '),
    )
```

#### Reason

切断「tsdown 为 ds-bot 产出无人读取的 `lib/client.cjs`」这条链，并把浏览器半成品的重建责任交给拥有它的构建脚本。

#### Risk

- 若 `discoverSelfBuiltClientDirs` 误纳其他包，会把它们的 HMR 断掉。当前判据实测只命中 `packages/bundle/ds-bot`（`node -e` 扫描 `dsh.client.platform==='web'` 且无 `tsconfig.json` 的包，唯一命中）。
- 新增阶段若退出会触发 `StageSupervisor.onStale` → 整个 `dev:web` 以 1 退出。这是期望行为（缺 watcher 会静默展示旧产物），但需在实测中确认 `build-watch` 不因首轮构建失败而退出。
- `spawnStage` 的 `local=false` 走 PATH 上的 `pnpm`；与既有 `vite build --watch` 阶段（同为 `'pnpm'` + `local=false`）一致。

#### Verification

- `cd application && pnpm vitest run scripts/dev-web.spec.ts` → 新旧用例全绿。
- `cd application && node -e "…discoverSelfBuiltClientDirs…"` → 输出 `['packages/bundle/ds-bot']`，`discoverBundledPluginDirs` 长度 = 78 − 1。
- 启动 `dev:web --no-serve --skip-build`，确认日志含 `1 self-built browser halves` 与 `self-built client packages/bundle/ds-bot`，且**不再**出现 `[@deepseek-ai/dsh-bot/client] lib\client.cjs`。

---

### Step 2 — `build-lib.mjs` 导出可复用的 `stageLib`

#### Target

- 文件：`application/packages/bundle/ds-bot/scripts/build-lib.mjs`
- 新增导出：`stageLib({ write })`；`--check` 主模块块改为复用它

#### Current Behavior

底部主模块块内联完成"渲染 → 断言 → 与磁盘全量比较 → 写/退出 1"；`writeLib`（101 行）无条件 `rmSync(LIB)` 后重写全部文件——每次调用都会刷新所有 mtime。

#### Change

```js
/**
 * Render `lib/`, write only what differs, and report the outcome.
 * @param options - `write: false` compares without touching disk.
 * @returns whether the tree differed and how many files it holds.
 */
export function stageLib({ write = true } = {}) {
  const next = buildLib()
  // `--check` proves the same invariant a write does: a stale tree that omits a file a staged
  // module reads must fail here, not in a browser that only says "did not activate".
  assertManifestRelativeReads(next)
  const committed = committedFiles().sort()
  const expected = [...next.keys()].map(file => `lib/${file}`).sort()
  const same = committed.length === expected.length
    && committed.every((file, index) => file === expected[index])
    && [...next].every(([target, contents]) => readFileSync(join(LIB, target)).equals(contents))
  if (same) return { changed: false, files: next.size }
  if (!write) return { changed: true, files: next.size }
  writeLib(next)
  return { changed: true, files: next.size }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = stageLib({ write: !process.argv.includes('--check') })
  if (process.argv.includes('--check') && result.changed) {
    console.error(`lib/ is stale: run \`npm run build\` in ${relative(process.cwd(), PLUGIN) || '.'} and commit the result`)
    process.exit(1)
  }
}
```

#### Reason

让 watch 循环复用同一次比较：内容相同就不落盘，避免"重写全部文件 → mtime 抖动 → HMR 误判"。

#### Risk

- `--check` 的失败文案与退出码必须与现状一字不差（已在 Change 中保持），否则 `dev/check.sh` 与 CI 的失败信息会漂移。
- `writeLib` 的 `rmSync` 语义保留（仅在有差异时执行），"清理陈旧文件"能力不变。

#### Verification

- `cd application/packages/bundle/ds-bot && node --test test/*.test.js` → 全绿（含新增用例）。
- `node scripts/build-lib.mjs --check` → 退出码 0；随后 `node scripts/build-lib.mjs && node scripts/build-lib.mjs --check` → 仍 0 且第二次无写入。

---

### Step 3 — `build-client.mjs` 新增 `--watch`

#### Target

- 文件：`application/packages/bundle/ds-bot/scripts/build-client.mjs`（新增 `watchClient`）
- 文件：`application/packages/bundle/ds-bot/package.json`（新增 `build-watch` 脚本）

#### Current Behavior

`build-client.mjs` 只有一次性 `bundleClient()` 与 `--check`；改动 `src/client/**` 后必须手工重跑 `npm run build`。

#### Change

1. 顶部 `node:fs` import 扩为 `import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs'`。
2. 末尾追加：

```js
/**
 * Build once — writing only what differs — then poll `src/client` and `src/shared` for edits and
 * repeat. The initial pass is what makes the dev loop self-bootstrapping: the shell loads
 * `lib/client.js`, which only this package's build stages.
 * @param options - polling interval, and the line sink for progress.
 * @returns a disposer that stops polling.
 */
export async function watchClient({ intervalMs = 500, log = console.log } = {}) {
  const { stageLib } = await import('./build-lib.mjs')
  const WATCHED = ['src/client', 'src/shared']

  const buildOnce = async (reason) => {
    const next = await bundleClient()
    if (readFileSync(OUTPUT, 'utf8') !== next) {
      writeFileSync(OUTPUT, next)
      log(`build-client: client.js rebuilt (${reason})`)
    }
    if (stageLib({ write: true }).changed) log(`build-client: lib/ staged (${reason})`)
  }

  const sourceStats = () => {
    const stats = new Map()
    for (const root of WATCHED) {
      for (const rel of globSync('**/*.js', { cwd: join(PLUGIN, root) })) {
        const absolute = join(PLUGIN, root, rel)
        stats.set(absolute, statSync(absolute).mtimeMs)
      }
    }
    return stats
  }

  await buildOnce('initial build')

  let seen = sourceStats()
  let building = false
  const timer = setInterval(() => {
    // A slow build must not queue behind itself and multiply its own cost.
    if (building) return
    const current = sourceStats()
    let changed = 0
    for (const [absolute, mtime] of current) if (seen.get(absolute) !== mtime) changed += 1
    seen = current
    if (changed === 0) return
    building = true
    void buildOnce(`${String(changed)} changed file(s)`)
      .catch(error => { log(`build-client: ${error instanceof Error ? error.message : String(error)}; still watching`) })
      .finally(() => { building = false })
  }, intervalMs)
  log(`build-client: watching ${WATCHED.join(', ')} every ${String(intervalMs)}ms`)
  return () => { clearInterval(timer) }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--watch')) {
  await watchClient()
}
```
3. `package.json` 的 `scripts` 中，`"build"` 之后插入 `"build-watch": "node scripts/build-client.mjs --watch"`。

#### Reason

`lib/client.js`（HMR 监视的 `clientPath`）只有这条 staging 路径会更新；watch 必须"重建 `client.js` + stage `lib/`"在同一次写里完成，否则两者会再次错位。

#### Risk

- 首轮 `buildOnce` 在 `client.js` 与源码不一致时会重写 committed 产物（当前工作区就是这种状态：`client.js` 887416B / 10-16 15:46，`lib/client.js` 853159B / 10-15 20:09）。这是 dev 循环的预期副作用，收工必须用 `--check` + `git diff --stat` 复核。
- 构建失败不得退出循环（失败一次就永久失效等于回到原缺陷）；已用 `.catch` + `finally` 保证。
- `globSync` 在该仓库 Node（实测 v26.7.0）可用；`node:fs` 的 `globSync` 在 Node 22+ 均可。

#### Verification

- `cd application/packages/bundle/ds-bot && node --test test/*.test.js` → 全绿。
- `node scripts/build-client.mjs --watch` 后台运行，改 `src/client/i18n.js` 一个值 → 输出 `client.js rebuilt (1 changed file(s))` 与 `lib/ staged (…)`；`cmp src/client/../client.js lib/client.js` 一致。
- `node scripts/build-client.mjs --check` → 退出码 0。

---

### Step 4 — `dev-desktop-hot.ts` 修正分类与监视范围，重启补 staging

#### Target

- 文件：`application/scripts/dev-desktop-hot.ts`
- 修改：`WATCHED_ROOTS`（37 行）、`classifySourceChange`（159 行）新增 `DS_BOT_ROOT` 前置规则、`restart()`（387 行）构建段
- 新增：`application/scripts/dev-desktop-hot.spec.ts`

#### Current Behavior

- `WATCHED_ROOTS` 不含 `integrations`。
- `classifySourceChange` 对 ds-bot 的 `src/host/**` 返回 `client`（该包无 `tsconfig.host.json` → `hostFaceFiles` 返回空集 → `member` 不在集合）。
- `restart()` 只跑 `build:lib:host`，随后直接 `start:desktop`。

#### Change

1. `WATCHED_ROOTS` 追加 `'integrations/workgroup'`（**不是** `'integrations'`：同级 `integrations/ds-bot` 是 13M 的 vendored upstream 副本，含 `.dsh-test*` 残留，整目录轮询会明显拖慢循环；`integrations/product` 只被 `apps/desktop/src` 引用，由已有的 `apps/desktop/src` 监视覆盖）。
2. `classifySourceChange` 最前面插入：

```ts
/** DS Bot's package root, whose two halves share one directory and one manifest. */
const DS_BOT_ROOT = 'packages/bundle/ds-bot/'
```
```ts
  // DS Bot's browser artifact is staged, not compiled, so the generic rule below cannot see the
  // split: the package has no `tsconfig.host.json`, which that rule reads as "no Host face", and
  // a Host edit is then served as browser-side and never applied. Everything under `src/client`
  // is the half the shell hot-swaps; the rest of the package (the Host modules staging mirrors
  // into `lib/src/host/**`, plus the shared modules both halves import) needs a restart.
  if (path.startsWith(DS_BOT_ROOT)) {
    return path.startsWith(`${DS_BOT_ROOT}src/client/`)
      ? { action: 'client', reason: 'DS Bot browser half' }
      : { action: 'restart', reason: 'DS Bot Host or shared half' }
  }
```
3. `restart()` 构建段在 `build:lib:host` 成功后追加 staging：

```ts
        // DS Bot's Host half is staged by its own script, which no repository build runs
        // (`build-lib.mjs` postdates the repository build graph). Skipping it restarts the shell
        // onto the previous `lib/` snapshot, which is the failure this loop exists to prevent.
        const staged = await runToCompletion(['exec', 'node', 'packages/bundle/ds-bot/scripts/build-lib.mjs'])
        if (requested !== undefined) return
        if (staged !== 0) {
          console.error(`dev-desktop-hot: DS Bot lib/ staging exited (code ${String(staged)}); the shell stays stopped until a new edit rebuilds it`)
          continue
        }
```
4. 新增 `application/scripts/dev-desktop-hot.spec.ts`（vitest 收集 `scripts/**/*.spec.ts`）：

```ts
import { describe, expect, it } from 'vitest'
import { classifySourceChange, isWatchableSource } from './dev-desktop-hot.ts'

const clientPackages = new Set(['packages/bundle/ds-bot', 'packages/client/modules'])
const hostFaces = new Map<string, Set<string> | undefined>([['packages/client/modules', new Set(['src/index.ts'])]])

describe('classifySourceChange', () => {
  it('keeps DS Bot browser sources on the HMR path', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/client/i18n.js', clientPackages, hostFaces).action).toBe('client')
  })

  it('restarts for DS Bot host and shared sources instead of treating them as browser-side', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/host/tools.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/src/shared/workgroup-session.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/index.js', clientPackages, hostFaces).action).toBe('restart')
  })

  it('restarts for the workgroup integration sources the DS Bot Host imports', () => {
    expect(classifySourceChange('integrations/workgroup/client/index.mjs', clientPackages, hostFaces).action).toBe('restart')
  })
})

describe('isWatchableSource', () => {
  it('accepts the .mjs modules integration packages ship', () => {
    expect(isWatchableSource('integrations/workgroup/policy/egress.mjs')).toBe(true)
  })
})
```

#### Reason

分类错误让 Host 改动完全不生效；监视范围缺 `integrations/workgroup` 让跨包依赖改动无反应；缺 staging 让重启后仍跑旧 Host 快照。

#### Risk

- 分类规则是"包级前置"，会先于 `HOST_ROOTS`/`CLIENT_ROOTS` 判定；`apps/**` 路径不受影响（前缀不匹配）。
- `runToCompletion(['exec', 'node', …])` 依 `pnpmInvocation` 解析（`npm_execpath` 必须是 pnpm 的 JS 入口）；若该形式在某些 shell 下解析异常，备选是主进程内 `await import()` 该脚本——但那会把 staging 放进监督进程，故优先前者。
- 新增 staging 阶段会让每次 Host 重启多一次全树渲染（当前 `lib/` 约 40 个文件），耗时可接受。

#### Verification

- `cd application && pnpm vitest run scripts/dev-desktop-hot.spec.ts` → 4 条断言组全绿。
- `pnpm vitest run scripts/dev-desktop-hot.spec.ts scripts/dev-web.spec.ts` → 两个 spec 同时通过（不依赖执行顺序）。

---

### Step 5 — 新增命令 `dev:desktop:hmr`（桌面热更新模式）

#### Target

- 文件：`application/package.json` — `scripts` 新增一行 `dev:desktop:hmr`
- 文件：`application/scripts/dev-desktop-hot.ts` — `DevDesktopHotArguments` 新增 `hotOnly`；`parseDevDesktopHotArguments` 接受 `--hot-only`；watcher 回调的 Host 分支按 `hotOnly` 分流；启动日志声明模式
- 文件：`application/scripts/dev-desktop-hot.spec.ts` — 覆盖参数解析与未知选项

#### Current Behavior

只有 `dev:desktop:hot`。脚本对 Host 侧改动的处置是**唯一**的：debounce 400ms 后停壳 → `build:lib:host` → staging → 重开壳。没有"只热更新、不重启"的入口；`parseDevDesktopHotArguments`（`dev-desktop-hot.ts:89-106`）只认 `--skip-build` 与 `--poll[=ms]`，遇到未知选项直接 `throw`。

#### Change

1. `application/package.json`，在既有 `dev:desktop:hot` 之后插入：

```json
    "dev:desktop:hmr": "tsx scripts/dev-desktop-hot.ts --hot-only",
```

2. `dev-desktop-hot.ts` 的 `DevDesktopHotArguments` 增加字段：

```ts
  /**
   * Keep the running shell alive when Host-side sources change: the browser half still
   * hot-swaps, and a Host edit only prints the command that applies it. `dev:desktop:hmr`
   * selects this; the plain loop restarts, because a Host edit that is never applied is the
   * failure this loop exists to catch.
   */
  readonly hotOnly: boolean
```
3. `parseDevDesktopHotArguments` 增加分支（放在 `--skip-build` 之后）：

```ts
    else if (arg === '--hot-only') hotOnly = true
```
并把函数返回值改为 `{ skipBuild, pollInterval, hotOnly }`。三处文本必须同步，否则 `--hot-only` 的发现路径只存在于文档里：

- 该函数的 `@returns` 说明；
- 未知选项分支抛出的 usage 串，改为
  `unknown option "${arg}"; usage: pnpm run dev:desktop:hot [--skip-build] [--poll[=ms]] [--hot-only]`；
- 文件头 `Usage:` 行：

```
 * Usage: `pnpm run dev:desktop:hot [--skip-build] [--poll[=ms]] [--hot-only]`.
 * `--hot-only` (`dev:desktop:hmr`) keeps the shell running on Host-side edits and prints the
 * command that applies them instead of restarting.
```
4. watcher 回调的 Host 分支分流（`dev-desktop-hot.ts` 中 `debounce` 那段）：

```ts
    console.log(`dev-desktop-hot: host-side change ${relativePath} (${decision.reason}); ${options.hotOnly ? 'not restarting (--hot-only)' : 'restarting'}`)
    if (options.hotOnly) {
      // A Host edit cannot hot-swap: the running shell already imported the staged
      // `lib/src/host/**` modules, and re-importing them would change Agent behavior mid-session.
      // Naming the restart command keeps the choice visible instead of silently serving stale
      // Host code. Staging alone is deliberately NOT offered as a remedy here: it writes artifacts
      // the live process never re-reads, which reads as "applied" while nothing changed.
      console.log('dev-desktop-hot: host-side edits need a restart; run `pnpm run dev:desktop:hot` to apply them (this shell keeps running until you do)')
      return
    }
```
5. 启动日志声明模式（`main()` 开头，与既有 `polling source trees` 日志并列）：

```ts
  console.log(`dev-desktop-hot: mode=${options.hotOnly ? 'hot-only (dev:desktop:hmr)' : 'restart (dev:desktop:hot)'}`)
```
6. `dev-desktop-hot.spec.ts` 追加：

```ts
import { parseDevDesktopHotArguments } from './dev-desktop-hot.ts'

describe('parseDevDesktopHotArguments', () => {
  it('defaults to restarting on Host edits', () => {
    expect(parseDevDesktopHotArguments([])).toEqual({ skipBuild: false, pollInterval: undefined, hotOnly: false })
  })

  it('selects the hot-only mode used by dev:desktop:hmr', () => {
    expect(parseDevDesktopHotArguments(['--hot-only']).hotOnly).toBe(true)
  })

  it('still accepts the existing options beside --hot-only', () => {
    expect(parseDevDesktopHotArguments(['--hot-only', '--skip-build', '--poll=250']))
      .toEqual({ skipBuild: true, pollInterval: 250, hotOnly: true })
  })

  it('rejects unknown options', () => {
    expect(() => parseDevDesktopHotArguments(['--hot'])).toThrow(/unknown option/)
  })
})
```

#### Reason

热更新与"改动自动重启"是两种不同意图：前者要求不打断在用会话，后者要求 Host 改动必须生效。Host 半成品没有插件级热替换，所以必须在入口处把选择交给使用者；新命令就是这个选择的具体形态。

#### Risk

- `--hot-only` 下 Host 改动**不会**生效，若使用者误以为它会生效，就会遇到"改了没反应"——这正是本方案要消灭的体验缺陷。缓解：改动被识别时打印明确指引（含可复制的命令），启动时也打印 `mode=`。
- 参数解析的 `toEqual` 断言会把对象新增字段变成显式失败点：这是有意的（未知字段/漏字段都会被测试抓到）。
- 既有 `dev:desktop:hot` 输出多一行 `mode=restart (dev:desktop:hot)`；对依靠日志 grep 的外部脚本可能有影响（当前仓库内无此类脚本，已核实）。

#### Verification

- `cd application && pnpm vitest run scripts/dev-desktop-hot.spec.ts` → 全部断言组绿。
- `cd application && pnpm run dev:desktop:hmr -- --skip-build`（需先有产物）→ 首行出现 `mode=hot-only (dev:desktop:hmr)`。
- 在 `hmr` 下改 `src/host/tools.js` → 输出 `host-side change …; not restarting (--hot-only)` 与指引两行，**且** Electron 进程未退出（可见窗口仍在）。
- 在 `hmr` 下改 `src/client/i18n.js` → 与 `hot` 模式一致地零重启生效（S7）。

---

### Step 6 — 端到端实测与文档回写

#### Target

- 文件：`Workgroup-AI/ENVIRONMENT_CHECKLIST.md`（新增"桌面热更新"一节：两条命令的语义对照表、预期日志、门槛）
- 文件：`Workgroup-AI/TASK_BOARD.md`（登记验收与残留风险）

#### Current Behavior

无热更新实测记录；`ENVIRONMENT_CHECKLIST.md` 未覆盖 `dev:desktop:hot`，也没有 `dev:desktop:hmr`。

#### Change

按下方 Verification 逐项实测并记录日志/证据路径；两份文档按现有条目风格追加，并明确写出"`--hot-only` 下 Host 改动不生效，须切 `dev:desktop:hot`"这一使用约束。

#### Reason

宪法与 `AGENTS.md` 第 12 条要求区分证据等级；S2/S3/S4 只有 L 级实测才能判定。

#### Risk

- 若 S2 未触发 `rebuilt`（HMR 只推 `graph` 未推 `rebuilt`），需回到方案层讨论是否把该包显式登记进 `packages/client/hmr` 的 watch 集合——属范围扩张，**必须暂停并走 Plan Adjustment**。
- 实测会重写 committed `client.js`；未复核不得提交。

#### Verification

1. `cd application && pnpm run dev:desktop:hot 2>&1 | tee .dev-hot.log`：启动阶段应出现 `self-built client packages/bundle/ds-bot` 与 `mode=restart (dev:desktop:hot)`，**不**出现 `lib\client.cjs`。
2. 改 `src/client/i18n.js` 的 `'Dissolve workgroup'` 中文值 → 期望（a）`client.js rebuilt` 与 `lib/ staged`；（b）`browser-side change … no restart`；（c）无第二次 `launching the Desktop shell`；（d）页面文案更新。证据存 `application/_shots/hot-reload-client-<ts>.png`。
3. 改 `src/host/workgroup-hub.js` 一条日志文案 → 期望 `host-side change … restarting` → `build:lib:host` → staging → `launching the Desktop shell`，且新文案可见；`cmp src/host/workgroup-hub.js lib/src/host/workgroup-hub.js` 一致。
4. 改 `integrations/workgroup/policy/egress.mjs` 的可观测输出 → 期望触发重启且生效。
5. `pnpm run dev:desktop:hmr` 重复第 2 步（应同样零重启生效），并在第 3 步场景下确认只提示、壳存活。
6. `node scripts/build-client.mjs --check && node scripts/build-lib.mjs --check` → 均退出码 0。

---

## 4. Changed Files Tracking

下表按 Coding 结束时的实际结果填写（非计划填写）。

| File | Action | Change |
| ---- | ------ | ------ |
| `application/package.json` | Modify | `scripts` 新增 `dev:desktop:hmr`（`tsx scripts/dev-desktop-hot.ts --hot-only`） |
| `application/scripts/dev-web.ts` | Modify | 新增导出 `discoverSelfBuiltClientDirs` / `discoverBundledPluginDirs` / `selfBuiltWatchCommand`；`main()` 用 `discoverBundledPluginDirs()` 替换 tsdown 集合、为自建包各起一个 `pnpm --filter … run build-watch` 阶段；诊断行拆成 tsdown / self-built / library 三段计数；`node:fs` import 增加 `existsSync` |
| `application/scripts/dev-web.spec.ts` | Modify | 新增两条用例：自建包与 tsdown 成员的划分（含 `--filter` 参数）、缺 `build-watch` 时抛错；import 增加三个新导出 |
| `application/scripts/dev-desktop-hot.ts` | Modify | `WATCHED_ROOTS` 增加 `integrations/workgroup`；新增 `DS_BOT_CLIENT_ARTIFACT`，`classifySourceChange` 前置 DS Bot 规则（`src/client/**` 与包根 `client.js` → client，其余 → restart）；`restart()` 在 `build:lib:host` 后追加 DS Bot `lib/` staging 并在失败时停壳；`DevDesktopHotArguments` 增加 `hotOnly`，解析器接受 `--hot-only` 并同步 usage 串；Host 改动在 hot-only 下打印指引不重启；启动打印 `mode=` |
| `application/scripts/dev-desktop-hot.spec.ts` | Add | 新建 spec：分类规则（浏览器侧 / 包根产物 / Host 与 shared / 跨包 integration / 声明式 host face）、`.mjs` 可见性、`--hot-only` 参数解析与未知选项拒绝，共 10 条 |
| `application/packages/bundle/ds-bot/scripts/build-lib.mjs` | Modify | 抽出并导出幂等 `stageLib({ write })`（渲染→断言→与磁盘比较，无差异不写盘）；`--check` 主模块块改为复用同一比较 |
| `application/packages/bundle/ds-bot/scripts/build-client.mjs` | Modify | 新增 `watchClient({ intervalMs, log })`：首轮构建 + 500ms mtime 轮询 `src/client`、`src/shared`，重建 `client.js` 并 `stageLib()`；`--watch` 主模块分支；`node:fs` import 增加 `globSync`/`statSync` |
| `application/packages/bundle/ds-bot/package.json` | Modify | `scripts` 新增 `build-watch`（`node scripts/build-client.mjs --watch`） |
| `application/packages/bundle/ds-bot/test/build-lib.test.js` | Add | 新建测试：`stageLib` 幂等（第二次 pass `.changed === false`） |
| `Workgroup-AI/ENVIRONMENT_CHECKLIST.md` | Modify | 新增"桌面端热更新"一节：两条命令语义对照、启动成功判据（含 `client.cjs` 必须为 0）、L 级实测结果表、`--hot-only` 使用约束、并行禁区 |
| `Workgroup-AI/TASK_BOARD.md` | Modify | 新增"2026-10-16 桌面端热更新"小节：三处静默失效与修复、验收结果与测试计数 |
| `Workgroup-AI/docs/plans/2026-10-16-desktop-hot-reload-implementation-plan.md` | Modify | 本文件：两次 Plan Adjustment、Step 5 新命令、本表与验证结论 |
| `Workgroup-AI/docs/superpowers/plans/2026-10-16-desktop-hot-reload.md` | Modify | 标注"执行权威已迁移"并链接本文档 |

**未实际改动**（计划中列出但执行后确认无需改）：

| File | 计划动作 | 原因 |
| ---- | -------- | ---- |
| `application/packages/bundle/ds-bot/client.js` | 预期被 dev 循环重写 | 实测中确被重写（19:45 探针验证），但复原后哈希回到基线 `e2ccfba4…`，`git status` 无改动，故不计入本次改动 |

`lib/` 全树仍被 `.gitignore` 忽略，不入库。

执行中每改一个文件即更新本表（含实际新增/遗漏项）。

## 5. Verification Checklist

**主流程**
- [x] `dev:desktop:hot` 冷启动成功，失败时日志能指出阶段与退出码
- [x] `dev:desktop:hmr` 冷启动成功，日志含 `mode=hot-only (dev:desktop:hmr)`
- [x] 浏览器侧改动零重启生效（S2），两条命令下表现一致
- [x] Host 侧改动在 `dev:desktop:hot` 下重启后生效且 `lib/` 与源码一致（S3）
- [x] Host 侧改动在 `dev:desktop:hmr` 下只提示、壳存活（S7）

**关联流程**
- [x] `integrations/workgroup/**` 改动触发重启并生效（S4）
- [x] `dev:web` 由循环以 `--no-serve --skip-build` 拉起时正常（实测日志：`tsx scripts/dev-web.ts --poll --no-serve --skip-build` + watching 计数行）
- [ ] `dev:desktop`（非 hot）未单独实测；`start:desktop` 在实测中被反复拉起且正常启动
- [x] `pnpm run` 列表里两条命令同时可见且互不覆盖

**边界情况**
- [x] `--poll=1000` 参数路径下自建 watcher 仍工作（`parseDevDesktopHotArguments(['--hot-only','--poll=1000'])` → `{skipBuild:false, pollInterval:1000, hotOnly:true}`）
- [x] `--hot-only` 与 `--skip-build`、`--poll=ms` 组合可用；未知选项（如 `--hot`）被拒绝
- [x] 自建包缺 `build-watch` 时报错而非静默（spec 覆盖）
- [x] 无 `tsconfig.json` 的包集合为空时集合划分正确（fixture 实测：`selfBuilt=[]`、`bundled=['packages/client/x']`，诊断行由模板推得 `0 self-built browser halves`）
- [x] 构建失败的恢复路径：watch 中一次构建失败后继续轮询

**浏览器侧"页面内生效"的证据边界（如实记录）**

实测取得的是 L 级的确证链条：`build-client` 重写 `client.js`（mtime/size 变化）→ 无重启 → HMR 轮询的正是该文件的 mtime/ctime/size。但 `client-hmr` 在**无异常时不打印日志**（只在 `ENOENT` 时置 dirty、其它错误 `logger.warn`），且本次未截图页面，因此"主进程画面上的中文文案确实变了"这一点**没有直接视觉证据**，仅有产物与日志证据。若要补足，需人工打开窗口改 `i18n.js` 并截图。

**Test**
- [x] `cd application && pnpm vitest run scripts/dev-web.spec.ts scripts/dev-desktop-hot.spec.ts` → 29/29
- [x] `cd application/packages/bundle/ds-bot && node --test test/*.test.js` → 624 pass / 1 fail（既有 `dsh-update` 项，与本改动无依赖关系）

**Build**
- [x] `cd application && pnpm run build:artifacts` 通过 → 7 门 PASS
- [x] `node scripts/build-client.mjs --check`、`node scripts/build-lib.mjs --check` 均 0

**Lint**
- [ ] `cd application && pnpm run lint` 未通过：**退出码 1，17 error 全部为基线既有**（未改动文件如 `client.js` 打包产物、`python-runtime-download.spec.ts`、`apps/desktop` 两个 spec 占多数）。本次改动**净新增 0 个**：`dev-desktop-hot.ts` 改动前后同为 6 个（同一组规则，逐行对应），我引入的第 7 个（多一处 `requested !== undefined` 触发 `no-unnecessary-condition`）已通过调整守卫位置消除；`build-lib.mjs` 唯一命中是未改动的 `cpSync` import 行。
- 结论：lint 不是可用的通过门槛（基线即失败），以"净新增为 0"作为本改动的判据。

**Typecheck**
- [x] `cd application && pnpm run typecheck` 通过 → 5 门 PASS

**收尾**
- [x] `git status` 中 `client.js` 无改动（探针重写后已复原至基线哈希 `e2ccfba4…`）；`lib/` 仍被忽略、未入库
- [x] `Changed Files Tracking` 表与实际改动一致
