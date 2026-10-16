# 桌面客户端热更新启动：修改方案（`dev:desktop:hot`）

> **执行权威已迁移**：本文件是设计与取证记录。可执行版本见
> [`docs/plans/2026-10-16-desktop-hot-reload-implementation-plan.md`](../../plans/2026-10-16-desktop-hot-reload-implementation-plan.md)，
> 其中新增了 Step 5（交付新命令 `pnpm run dev:desktop:hmr`）。两者冲突时以执行文档为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `pnpm run dev:desktop:hot` 真正实现"改源码即生效"——改 DS Bot 浏览器侧源码零重启热替换，改 Host 侧源码重启后一定跑的是新代码，且不再产生无人读取的构建噪音。

**Architecture:** 现状把 DS Bot 的两半都接到错的产物上：Shell 通过 `exports["./client"] → ./lib/client.js` 读**包内 staging 副本**，而 `dev:web` 的 tsdown watch 只重写 `lib/client.cjs`（没有任何代码读它）；Host 半成品 `lib/src/host/**` 只在包自己的 `npm run build` 里 staging，仓库构建（`build:lib:host` / `build:artifacts`）不跑它。方案分三处收敛：①`dev:web` 认识"自带构建脚本的浏览器半成品包"并把它的构建脚本作为 watch 阶段启动；②该构建脚本新增 `--watch`，写包根 `client.js` 后同步 stage `lib/client.js`（HMR 监视的那份）；③`dev:desktop-hot` 把 ds-bot 的 Host 侧路径与 `integrations/**` 显式归为 restart，并在重启前补一次 staging。

**Tech Stack:** Node 24（`tsx` 脚本、`execa`、`node:test`/`vitest`）、esbuild、tsdown、Electron 壳 + `@deepseek-ai/dsh-client-hmr`。

## Global Constraints

- 只存在两个运行边界：`application/` 与 `server/`，不得新增第三项目。
- 不重写 DSH Agent Loop、不改上游语义；改动遵循"最小补丁 + 保留上游注释"（AGENTS.md 第 11 条）。
- 不得虚构测试成功：区分静态检查、mock、单机真实运行、打包/双机实测。本方案实施后 **必须** 补 L 级实测（见验收矩阵），静态分析不算通过。
- 修改重要文件前备份到 `Workgroup-AI/backups/`；禁止 `rm`/`del`/`Remove-Item`，需要删除时移入回收站。
- `packages/bundle/ds-bot/client.js` 是 **committed** 产物（`link:`/git 安装不做构建）；`lib/` 被 `application/.gitignore` 忽略。dev 循环允许重写 `client.js`，但收工前必须用 `--check` 恢复一致性。
- 客户端 UI 文案归 locale 所有（`packages/bundle/ds-bot/src/client/i18n.js` 的 `ZH` 字典）；本方案不新增面向用户的文案。

**已核实的前置事实（实施前勿重新论证）:**

| 事实 | 证据 |
|---|---|
| Shell 实际加载 DS Bot 浏览器半成品 `lib/client.js` | `packages/bundle/ds-bot/package.json` `exports["./client"]="./lib/client.js"`；`packages/client/modules/src/index.ts:850` `clientPath: join(dirname(pkgPath), clientRel)` |
| dev watcher 只重写 `lib/client.cjs` | `.dev-hot.log:894` `[@deepseek-ai/dsh-bot/client] lib\client.cjs 846.32 kB`；`packages/bundle/ds-bot/tsdown.config.ts:1-6` 自述"not part of the workspace build" |
| 全仓无任何代码引用 `lib/client.cjs` | `grep -rn "client\.cjs" packages apps scripts`（排除 `ds-bot/lib/`）零命中 |
| 三份产物已经不一致 | `cmp`：`client.js ≠ lib/client.js`；`src/host/workgroup-hub.js ≠ lib/src/host/workgroup-hub.js`；`src/host/tools.js == lib/src/host/tools.js`（时间戳：lib 快照 10-15 20:09，源码 10-15 14:49） |
| `lib/` 由包内脚本 staging，仓库构建不参与 | `packages/bundle/ds-bot/scripts/build-lib.mjs:101-107` `rmSync(LIB)` + 逐文件写入；`ENTRIES` 含 `client.js`、`index.js`、`web-search.js`、`src/host`、`src/shared` |
| 该包被 tsdown workspace 排除的判据是"无 `tsconfig.json`" | `scripts/workspace-package-globs.ts:22-30`（`existsSync(join(root, dir,'tsconfig.json'))`）；实测唯一命中：`packages/bundle/ds-bot` |
| ds-bot 仍被 `dev:web` 当作 tsdown workspace 成员 | `scripts/dev-web.ts:410` `watchClientPlugins(repoRoot, [...pluginDirs, ...libraryDirs])`；`discoverPluginDirs` 判据仅 `dsh.client.platform === 'web'` |
| 桌面壳内 HMR 通路已挂载 | `packages/boot/app-boot/src/profile.ts:189` web profile bundles 含 `@deepseek-ai/dsh-bot`；`packages/bundle/web-app/cordis.patch.yml:218` 常驻 `client-hmr`（"idle until a rebuild watcher actually rewrites client bundles"） |
| HMR 监视 `clientPath` 并按 stat 三项变化广播 `rebuilt` | `packages/client/hmr/src/index.ts:55-110`（`sameBundleStat` 比较 mtime/ctime/size）；浏览器端 `reload(id, rev)` |
| `classifySourceChange` 对 ds-bot 全部 src 判为 client | `scripts/dev-desktop-hot.ts`：`hostFaceFiles` 对缺 `tsconfig.host.json` 的包返回空集 → `member` 不在集合 → `action: 'client'`（缺文件走 ENOENT 分支） |
| watcher 不覆盖 `integrations/` | `WATCHED_ROOTS` 仅 `apps/desktop/src`、`apps/desktop-host/src`、`apps/cli/src`、`apps/web`、`packages`、`vendor`、`native` |

## 现状数据流（缺陷定位）

```
改 packages/bundle/ds-bot/src/client/*.js
  └─ dev:web 的 tsdown watch 重写 lib/client.cjs        ← 无任何读者
  └─ client-hmr 轮询 lib/client.js（clientPath）无变化   ← 不广播 rebuilt
  └─ dev-desktop-hot 判为 'client'，不重启               ← 浏览器看不到改动（静默失效）

改 packages/bundle/ds-bot/src/host/*.js
  └─ 同上判为 'client'，既不热更也不重启                 ← Host 逻辑永远停在旧快照（静默失效）

改 integrations/workgroup/**（Host 侧 import 的 workspace 源码）
  └─ 路径不在 WATCHED_ROOTS，连触发都没有                ← 静默失效
```

## 目标 / 非目标

**目标**
1. 浏览器侧（`src/client/**`、`src/shared/**` 的浏览器面）：源码变更 → 重建 → HMR 广播 `rebuilt` → 页面替换模块，**不重启 Electron**。
2. Host 侧（`src/host/**`、包根 `index.js`/`web-search.js`、`src/shared/**`、`integrations/**`）：源码变更 → 重启 Shell，且重启后加载的一定是刚 staged 的 `lib/`。
3. 消除 `lib/client.cjs` 噪音：自建包不再进入 tsdown workspace watch。

**非目标**
- 不做 Host 插件级热重载（`@deepseek-ai/dsh-bot` 的 Host 行不参与 HMR；本方案用重启解决，符合"隔离 Task Session / 不改 Agent Loop"约束）。
- 不改打包与发布链路（`package:*`、`prepare:*`、`build-lib.mjs --check` 的既有语义保持不变）。
- 不改 `exports`/`main` 指向源码（见"被否决的替代方案"）。

---

### Task 1: `dev:web` 识别"自建浏览器半成品"包，并把它从 tsdown 集合中剔除

**Files:**
- Modify: `application/scripts/dev-web.ts`（新增导出 + 调整 watch 集合与诊断）
- Test: `application/scripts/dev-web.spec.ts`

**Interfaces:**
- Produces:
  - `discoverPluginDirs(root?): string[]` —— 语义**不变**：所有 `dsh.client.platform === 'web'` 包目录（`classifySourceChange` 依赖它判"浏览器侧"）。
  - `discoverSelfBuiltClientDirs(root?): string[]` —— 新增：声明 `dsh.client.platform === 'web'` 且**没有** `tsconfig.json` 的包目录（其浏览器半成品由包自己的构建脚本产出）。
  - `discoverBundledPluginDirs(root?): string[]` —— 新增：`discoverPluginDirs` 去掉 `discoverSelfBuiltClientDirs`，即交给 tsdown workspace 的成员。
  - `selfBuiltWatchCommand(root, dir): readonly string[]` —— 新增：把包目录映射成 `pnpm --filter <包名> run build-watch` 的参数表（包名读自该包 `package.json` 的 `name`；缺 `build-watch` 脚本时抛错而不是静默跳过）。

**Consumes:** 无（首个任务）。

- [ ] **Step 1: 写失败测试**

在 `application/scripts/dev-web.spec.ts` 末尾追加用例；`mkdtempSync`/`mkdirSync`/`writeFileSync`/`tmpdir`/`join` 中该文件尚未导入的，合并进**顶部既有的 import 语句**（该文件已有 `describe`/`expect`/`it` 与 `node:fs`、`node:os`、`node:path` 的导入，重复 import 同名绑定会直接导致语法错误）：

```ts
import { discoverBundledPluginDirs, discoverPluginDirs, discoverSelfBuiltClientDirs, selfBuiltWatchCommand } from './dev-web.ts'

function writePackage(root: string, dir: string, manifest: Record<string, unknown>, files: string[]): void {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  for (const file of files) writeFileSync(join(root, dir, file), '')
}

describe('self-built browser halves', () => {
  it('separates packages that ship their own client build from tsdown workspace members', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-web-self-built-'))
    writePackage(root, 'packages/plain/web', { name: '@x/plain', dsh: { client: { platform: 'web' } } }, ['tsconfig.json'])
    writePackage(root, 'packages/bundle/self', { name: '@x/self', dsh: { client: { platform: 'web' } }, scripts: { 'build-watch': 'node build.mjs --watch' } }, [])

    expect(discoverPluginDirs(root)).toEqual(['packages/bundle/self', 'packages/plain/web'])
    expect(discoverSelfBuiltClientDirs(root)).toEqual(['packages/bundle/self'])
    expect(discoverBundledPluginDirs(root)).toEqual(['packages/plain/web'])
    expect(selfBuiltWatchCommand(root, 'packages/bundle/self')).toEqual(['--filter', '@x/self', 'run', 'build-watch'])
  })

  it('refuses a self-built package that declares no watch script', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-web-no-watch-'))
    writePackage(root, 'packages/bundle/self', { name: '@x/self', dsh: { client: { platform: 'web' } } }, [])
    expect(() => selfBuiltWatchCommand(root, 'packages/bundle/self')).toThrow(/build-watch/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd application && pnpm vitest run scripts/dev-web.spec.ts -t "self-built browser halves"`
Expected: FAIL —— `discoverSelfBuiltClientDirs is not a function`（导出尚不存在）。

- [ ] **Step 3: 实现**

在 `application/scripts/dev-web.ts` 的 `discoverPluginDirs` 之后加入（保留上游注释风格，标注 fork 归属）：

```ts
/**
 * Workgroup AI fork: list the client packages whose browser artifact is produced
 * by their own build script rather than by `tsc -b` plus tsdown. The predicate is
 * the same one `scripts/workspace-package-globs.ts` applies to the bundling pass:
 * a workspace member shipping authored JavaScript has no `tsconfig.json`, so
 * handing it to tsdown fails the whole pass with "Cannot find entry" — and, as
 * measured on DS Bot, when it is handed over anyway the pass silently writes a
 * second artifact (`lib/client.cjs`) that no loader reads while the file the
 * shell actually loads (`exports["./client"]`) stays stale.
 * @param root - repository or fixture root passed to the discovery.
 * @returns workspace-relative package directories owning their browser build.
 */
export function discoverSelfBuiltClientDirs(root = repoRoot): string[] {
  return discoverPluginDirs(root).filter(dir => !existsSync(join(root, dir, 'tsconfig.json')))
}

/**
 * Client plugin directories the tsdown workspace may bundle: every browser half
 * except the self-built ones, whose watch stage their own build script owns.
 * @param root - repository or fixture root passed to the discovery.
 * @returns workspace-relative package directories for the tsdown workspace pass.
 */
export function discoverBundledPluginDirs(root = repoRoot): string[] {
  const selfBuilt = new Set(discoverSelfBuiltClientDirs(root))
  return discoverPluginDirs(root).filter(dir => !selfBuilt.has(dir))
}

/**
 * Resolve the watch command one self-built package runs for its browser half.
 * @param root - repository root.
 * @param dir - workspace-relative package directory.
 * @returns arguments for `pnpm` that start that package's `build-watch` script.
 * @throws Error when the package declares no `name` or no `build-watch` script.
 */
export function selfBuiltWatchCommand(root: string, dir: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    name?: string
    scripts?: Record<string, string>
  }
  const script = manifest.scripts?.['build-watch']
  if (manifest.name === undefined || manifest.name === '' || script === undefined || script === '') {
    throw new Error(`dev-web: ${dir} ships its own browser half but declares no "build-watch" script; its sources would never reach the browser`)
  }
  return ['--filter', manifest.name, 'run', 'build-watch']
}
```

> 同时把 `dev-web.ts` 顶部的 fs import 扩为 `import { existsSync, globSync, readFileSync } from 'node:fs'`。

在 `main()` 里把传参改为：

```ts
  const pluginDirs = discoverPluginDirs()
  const bundledPluginDirs = discoverBundledPluginDirs()
  const selfBuiltPluginDirs = discoverSelfBuiltClientDirs()
  const libraryDirs = discoverLibraryDirs()
  if (bundledPluginDirs.length === 0) { /* 既有报错分支保持 */ }
  if (libraryDirs.length === 0) { /* 既有报错分支保持 */ }

  // tsdown's workspace pass must not be handed a package that ships authored
  // JavaScript: it fails the whole pass on a missing entry, and DS Bot's
  // tsdown config (kept only for the notices walk) would otherwise re-emit
  // `lib/client.cjs`, a file no loader reads. Those packages get one watch
  // stage each, next to the tsdown watchers.
  const bundles = await watchClientPlugins(repoRoot, [...bundledPluginDirs, ...libraryDirs], options.pollInterval)
  for (const dir of selfBuiltPluginDirs) {
    spawnStage(supervisor, `self-built client ${dir}`, 'pnpm', selfBuiltWatchCommand(repoRoot, dir), false)
  }
```

诊断行同步更新为：`dev-web: watching {bundledPluginDirs.length} tsdown plugin packages, {selfBuiltPluginDirs.length} self-built browser halves, and {libraryDirs.length} statically linked library packages …`，并把两个目录清单打印出来（沿用现有 `for (const dir of ...) console.log('  ' + dir)` 形式）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd application && pnpm vitest run scripts/dev-web.spec.ts`
Expected: PASS（含既有用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add application/scripts/dev-web.ts application/scripts/dev-web.spec.ts
git commit -m "fix(dev-web): watch self-built browser halves instead of re-emitting lib/client.cjs"
```

---

### Task 2: `build-client.mjs` 支持 `--watch`，并在同一次写入里 stage `lib/client.js`

**Files:**
- Modify: `application/packages/bundle/ds-bot/scripts/build-client.mjs`
- Modify: `application/packages/bundle/ds-bot/scripts/build-lib.mjs`（导出 staging 入口）
- Modify: `application/packages/bundle/ds-bot/package.json`（新增 `build-watch` 脚本）

**Interfaces:**
- Consumes: Task 1 的 `selfBuiltWatchCommand`（它调用 `pnpm --filter @deepseek-ai/dsh-bot run build-watch`）。
- Produces:
  - `stageLib({ write = true }): { changed: boolean; files: number }` —— 从 `build-lib.mjs` 导出；渲染 `lib/` 全树、与磁盘比较，只有内容不同才落盘（`--check` 复用同一比较）。
  - `build-watch` 脚本：轮询 `src/client/**` 与 `src/shared/**`，重建包根 `client.js` 后调用 `stageLib()`。

- [ ] **Step 1: 写失败测试（比较语义）**

在 `application/packages/bundle/ds-bot/test/build-lib.test.js` 追加（该包用 `node --test`）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stageLib } from '../scripts/build-lib.mjs'

test('stageLib is idempotent: a second pass finds nothing to write', () => {
  // The first pass may or may not write, depending on the tree the checkout
  // carries; the contract this test pins is that staging twice in a row never
  // rewrites bytes, which is what keeps a watch loop from waking HMR by itself.
  stageLib({ write: true })
  assert.equal(stageLib({ write: true }).changed, false, 'a second staging pass must not rewrite identical bytes')
  assert.equal(stageLib({ write: false }).changed, false, '--check agrees with the tree just written')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd application/packages/bundle/ds-bot && node --test test/build-lib.test.js`
Expected: FAIL —— `stageLib` 未导出（`SyntaxError`/`undefined is not a function`）。

- [ ] **Step 3: 实现 `stageLib`**

在 `application/packages/bundle/ds-bot/scripts/build-lib.mjs` 中，把底部主模块块改为复用同一比较：

```js
/** Render `lib/`, write only what differs, and report what happened. */
export function stageLib({ write = true } = {}) {
  const next = buildLib()
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

> `--check` 的失败信息与退出码保持原样，只是共用一次比较。

- [ ] **Step 4: 实现 `--watch`**

在 `application/packages/bundle/ds-bot/scripts/build-client.mjs` 末尾追加（复用同文件既有的 `bundleClient`；`node:fs` 的 `globSync` 在 Node 22+ 可用，避免 `readdir` 递归选项与 `parentPath` 的版本差异）：

```js
/**
 * Build once — writing only what differs — then poll `src/client` and `src/shared`
 * for edits and repeat. The initial pass is what makes the dev loop
 * self-bootstrapping: the shell loads `lib/client.js`, which only this package's
 * build stages, and no repository build runs it.
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

> 要求：①首轮显式构建保证 `lib/` 存在（`stageLib` 与 `client.js` 比较都只在字节不同时写盘，所以重复启动不抖动 HMR）；②任何一次构建失败必须打印并继续轮询，不得退出——否则"改源码无反应"会以另一种形式重现；③`.catch` 挂在 `buildOnce` 上，`finally` 复位 `building`，不允许异常把循环卡死。
>
> 该文件顶部现有的 `import { readFileSync, writeFileSync } from 'node:fs'` 需扩为 `import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs'`。

- [ ] **Step 5: 增加包脚本**

在 `application/packages/bundle/ds-bot/package.json` 的 `scripts` 中，`build` 之后插入：

```json
    "build-watch": "node scripts/build-client.mjs --watch",
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd application/packages/bundle/ds-bot && node --test test/*.test.js`
Expected: PASS；随后手工验证一次热路径：

```bash
cd application/packages/bundle/ds-bot
node scripts/build-client.mjs --watch &   # 后台
# 改 src/client/i18n.js 的任一 ZH 值，观察：
#   build-client: client.js rebuilt (1 source file(s))
#   build-client: lib/ staged
node scripts/build-client.mjs --check      # 期望退出码 0（client.js 与 src 一致）
```

- [ ] **Step 7: 提交**

```bash
git add application/packages/bundle/ds-bot/scripts/build-client.mjs \
        application/packages/bundle/ds-bot/scripts/build-lib.mjs \
        application/packages/bundle/ds-bot/package.json \
        application/packages/bundle/ds-bot/test/build-lib.test.js
git commit -m "feat(ds-bot): watch the browser half and stage lib/ in one pass"
```

---

### Task 3: `dev:desktop-hot` 正确分类 DS Bot 两半与 `integrations/`

**Files:**
- Modify: `application/scripts/dev-desktop-hot.ts`
- Test: `application/scripts/dev-desktop-hot.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `build-watch`（由 `dev:web` 阶段的 `self-built client` 进程启动），Task 1 的 `discoverPluginDirs` 语义不变。
- Produces:
  - `classifySourceChange` 新增前置规则 `DS_BOT_SPLIT`：`packages/bundle/ds-bot/src/client/**` → `client`；`packages/bundle/ds-bot/**`（其余，含 `src/host`、`src/shared`、`index.js`、`web-search.js`）→ `restart`；`integrations/**` → `restart`。
  - restart 序列：`build:lib:host` → `node packages/bundle/ds-bot/scripts/build-lib.mjs` → `start:desktop`。

- [ ] **Step 1: 写失败测试**

新建 `application/scripts/dev-desktop-hot.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { classifySourceChange, isWatchableSource } from './dev-desktop-hot.ts'

const clientPackages = new Set(['packages/bundle/ds-bot', 'packages/client/modules'])
const hostFaces = new Map<string, Set<string> | undefined>([['packages/client/modules', new Set(['src/index.ts'])]])

describe('classifySourceChange', () => {
  it('keeps DS Bot browser sources on the HMR path', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/client/i18n.js', clientPackages, hostFaces).action).toBe('client')
  })

  it('restarts for DS Bot host sources instead of treating them as browser-side', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/host/tools.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/src/shared/workgroup-session.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/index.js', clientPackages, hostFaces).action).toBe('restart')
  })

  it('restarts for the workgroup integration sources the plugin imports', () => {
    expect(classifySourceChange('integrations/workgroup/client/index.mjs', clientPackages, hostFaces).action).toBe('restart')
  })
})

describe('isWatchableSource', () => {
  it('accepts .mjs under integrations', () => {
    expect(isWatchableSource('integrations/workgroup/policy/egress.mjs')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd application && pnpm vitest run scripts/dev-desktop-hot.spec.ts`
Expected: FAIL —— 2 条 DS Bot 断言失败（`src/host/tools.js` 与 `src/shared/workgroup-session.js` 当前被判为 `client`）。另两条现在就会通过（`integrations/**` 与 `index.js` 落到默认的 `restart` 分支，`.mjs` 已在 `SOURCE_EXTENSIONS` 内），它们的作用是钉住"修好之后不被回退"，因此必须一并保留。

- [ ] **Step 3: 实现分类与监视范围**

在 `application/scripts/dev-desktop-hot.ts` 中：

```ts
/** Source trees the restart watcher covers. */
const WATCHED_ROOTS = ['apps/desktop/src', 'apps/desktop-host/src', 'apps/cli/src', 'apps/web', 'packages', 'vendor', 'native', 'integrations']

/**
 * DS Bot's two halves live in one package whose browser artifact is staged
 * rather than compiled: `src/client` is rebuilt and hot-swapped, everything
 * else under the package (the Host modules the staged `lib/src/host/**` mirrors,
 * plus the shared modules both halves import) is Host code that needs a restart.
 * Without this rule the package's missing `tsconfig.host.json` reads as "no Host
 * face", so a Host edit is treated as browser-side and never applied at all.
 */
const DS_BOT_ROOT = 'packages/bundle/ds-bot/'
```

并在 `classifySourceChange` 的最前面（早于 `CLIENT_ROOTS`/`HOST_ROOTS`/packages 分支）插入：

```ts
  if (path.startsWith(DS_BOT_ROOT)) {
    return path.startsWith(`${DS_BOT_ROOT}src/client/`)
      ? { action: 'client', reason: 'DS Bot browser half' }
      : { action: 'restart', reason: 'DS Bot Host or shared half' }
  }
```

- [ ] **Step 4: 让重启补一次 staging**

把 `restart()` 中的构建段改为：

```ts
        const built = await runToCompletion(['run', 'build:lib:host'])
        if (requested !== undefined) return
        if (built !== 0) {
          console.error(`dev-desktop-hot: build:lib:host exited (code ${String(built)}); the shell stays stopped until a new edit rebuilds it`)
          continue
        }
        // DS Bot's Host half is staged by its own script, which no repository
        // build runs (`build-lib.mjs` predates the staging seam). Without this,
        // restarting after a `src/host` edit reloads the previous snapshot.
        const staged = await runToCompletion(['exec', 'node', 'packages/bundle/ds-bot/scripts/build-lib.mjs'])
        if (requested !== undefined) return
        if (staged !== 0) {
          console.error(`dev-desktop-hot: DS Bot lib/ staging exited (code ${String(staged)}); the shell stays stopped`)
          continue
        }
        startDesktop()
```

> 用 `pnpm exec node …`（经 `pnpmInvocation`）而不是 `node` 直接调用，保持与现有阶段一致的解析方式；若 `pnpm exec` 不可用，退化为主进程 `spawn(process.execPath, [...])`，实现时二选一并写进注释。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd application && pnpm vitest run scripts/dev-desktop-hot.spec.ts scripts/dev-web.spec.ts`
Expected: PASS。

- [ ] **Step 6: 提交（含当前未追踪的脚本）**

```bash
git add application/scripts/dev-desktop-hot.ts application/scripts/dev-desktop-hot.spec.ts application/package.json
git commit -m "fix(dev-desktop-hot): restart DS Bot Host edits and watch integrations/"
```

---

### Task 4: 端到端实测与文档回写

**Files:**
- Modify: `Workgroup-AI/ENVIRONMENT_CHECKLIST.md`（新增"桌面热更新"一节：命令、预期日志、门槛）
- Modify: `Workgroup-AI/TASK_BOARD.md`（登记本次改动的验收项与残留风险）

**Interfaces:**
- Consumes: Task 1–3 的全部产出。
- Produces: L 级实测记录（日志 + 截图路径），供验收引用。

- [ ] **Step 1: 冷启动基线**

```bash
cd application
pnpm run dev:desktop:hot 2>&1 | tee .dev-hot.log
```
Expected（启动阶段）：`dev-desktop-hot: launching the Desktop shell`、`dev-web: watching … 1 self-built browser halves …`、`self-built client packages/bundle/ds-bot`，且**不再**出现 `[@deepseek-ai/dsh-bot/client] lib\client.cjs`。

- [ ] **Step 2: 浏览器侧热更新（不重启）**

改 `packages/bundle/ds-bot/src/client/i18n.js` 的一个 ZH 值（例如 `'Dissolve workgroup'` 的中文），保存后观察：
- 日志出现 `self-built client packages/bundle/ds-bot: client.js rebuilt` 与 `lib/ staged`；
- 日志出现 `dev-desktop-hot: browser-side change … the client watcher owns it, no restart`；
- Shell 主进程未被结束（无 `launching the Desktop shell` 第二次输出）；
- 页面文案在数秒内变为新值（HMR 广播 `rebuilt`）。

证据：日志片段 + DevTools/截图（存 `application/_shots/`，命名 `hot-reload-client-<ts>.png`）。

- [ ] **Step 3: Host 侧重启生效**

改 `packages/bundle/ds-bot/src/host/workgroup-hub.js` 里一条日志文案，保存后观察：`host-side change … restarting` → `build:lib:host` → `DS Bot lib/ staging` → `launching the Desktop shell`；随后确认新文案确实出现（证明 staged `lib/src/host/**` 与源码一致，可用 `cmp src/host/workgroup-hub.js lib/src/host/workgroup-hub.js` 复核）。

- [ ] **Step 4: 集成侧生效**

改 `application/integrations/workgroup/policy/egress.mjs` 的可观测注释或日志，确认触发重启且生效（证明 `integrations/` 已进入监视范围）。

- [ ] **Step 5: 收工一致性**

```bash
cd application/packages/bundle/ds-bot
node scripts/build-client.mjs --check
node scripts/build-lib.mjs --check
```
Expected: 两条均退出码 0（若 `client.js` 因 dev 循环被重写，需 `git diff --stat` 复核并决定是否提交该 committed 产物）。

- [ ] **Step 6: 回写文档并提交**

```bash
git add Workgroup-AI/ENVIRONMENT_CHECKLIST.md Workgroup-AI/TASK_BOARD.md
git commit -m "docs: record the desktop hot-reload loop and its verified levels"
```

---

## 验收矩阵

| 项 | 判定方式 | 等级 | 通过条件 |
|---|---|---|---|
| 分类正确性 | `scripts/dev-desktop-hot.spec.ts` | 静态/单测 | 4 条断言全绿 |
| 自建包识别 | `scripts/dev-web.spec.ts` | 静态/单测 | 新用例全绿，既有用例不回归 |
| 产物一致 | `build-client.mjs --check`、`build-lib.mjs --check` | 单机 | 退出码 0 |
| 浏览器侧热更新 | Task 4 Step 2 | **L 级实测** | 无重启、日志命中、UI 变更可见 |
| Host 侧生效 | Task 4 Step 3 | **L 级实测** | 重启后新行为可见且 `cmp` 一致 |
| 集成侧生效 | Task 4 Step 4 | **L 级实测** | 触发重启并生效 |
| 无噪音产物 | `.dev-hot.log` | 单机 | 全日志无 `lib\client.cjs` 行 |

未取得 L 级证据前，结论必须写 `NO-GO`，并注明"仅静态分析"。

## 风险与未决

1. **HMR 监视路径的实证强度**：`clientPath` 取自 `exports["./client"]` 的静态推导（已读源码确认），但"重写 `lib/client.js` 必然触发 `rebuilt` 而非仅 `graph`"尚属推断；Task 4 Step 2 是它的判定实验，若未触发则改为在 `packages/client/hmr` 的 watch 集合中显式登记该包（属范围扩张，需先回到方案层讨论）。
2. **`lib/` 全树重写带来的 mtime 抖动**：`stageLib` 已加"内容相同不落盘"守卫；若 HMR 仍误判，则把 staging 收窄为只写 `lib/client.js` 与 `lib/src/**`（牺牲"清理陈旧文件"语义）。
3. **`client.js`（committed）在 dev 期间被改写**：属预期，收工用 `--check`/`git diff` 复核；不允许在未复核的情况下提交。
4. **轮询成本**：`globSync` 每轮枚举 `src/client` 与 `src/shared` 下全部 `.js`（当前约 60 个文件），500ms 一轮远低于 `dev-desktop-hot` 自身对 `packages/` 的扫描成本；若实测占用明显，改为复用 `dev-desktop-hot.ts` 的 `collectSources` 目录栈遍历并以 `fs.watch` 触发。
5. **未做**：打包后（`package:win:x64` / `package:mac:arm64`）路径验证；双机 E2E；`server/` 侧未涉及。

## 被否决的替代方案

- **把 `exports["./client"]`/`main` 指向包根源码**（让 Shell 直接读 `src/`）：Host 侧确实可行（包根 `index.js` 的 `./src/host/*.js` 正好解析到源码），但会绕过 `lib/` 发布布局，与 `check-workspace-constraints.ts:182` 对 `lib/**` 的发布约束冲突，且打包路径共用同一清单。改动面与风险都大于"dev 阶段补一次 staging"。
- **让 tsdown 直接产出 loader-wrapper 格式的 `lib/client.js`**：`client.js` 的 `window.__ModuleLoader__.load({ id, factory })` 包装由 esbuild 脚本手写（`build-client.mjs:42-56`），tsdown 无法产出等价字节；双写会产生第二权威源，违背单一来源。
- **Host 插件级热重载**：需要 Loader 级 reload 语义与 Session 隔离复核，超出"热更新启动"的最小范围，且触及 AGENTS.md 第 8/9 条约束。

## 回滚

- 新增能力全部由脚本内常量与 `build-watch` 脚本构成，回滚 = `git revert` 上述四个提交；`lib/` 与 `client.js` 可随时用 `node scripts/build-lib.mjs` / `node scripts/build-client.mjs` 重生成。
- 备份要求：修改 `application/scripts/dev-web.ts`、`application/scripts/dev-desktop-hot.ts`、`application/packages/bundle/ds-bot/package.json` 前，各复制一份到 `Workgroup-AI/backups/2026-10-16-hot-reload/`。
