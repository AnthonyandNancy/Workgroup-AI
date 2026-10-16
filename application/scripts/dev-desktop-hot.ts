/**
 * The Desktop development loop in one command: build once, keep every
 * browser-side artifact rebuilding behind the Host's own HMR channel, and
 * restart the whole shell whenever host-side sources change.
 *
 * Stages, in order: the first build and launch — `pnpm run dev:desktop`, or
 * `pnpm run start:desktop` under `--skip-build` — then two long-lived stages
 * supervised here: `pnpm run dev:web --no-serve --skip-build` for the client
 * artifacts, and this script's own source watcher for restarts.
 *
 * Restart contract: a host-side edit stops the shell, runs
 * `pnpm run build:lib:host` (Host compilation, Host bundle, Desktop bundle),
 * and launches `pnpm run start:desktop` again. That triple is the Host half of
 * `build:artifacts`, so a restart never rewrites the browser-side artifacts
 * `dev:web` owns; running the full `build:artifacts` beside that watcher writes
 * the same `lib/` and `apps/web/dist/` trees, which `scripts/dev-web.ts`
 * documents as forbidden.
 *
 * Change classification is conservative: a path counts as a host-side change
 * unless the client build owns it and the owning package does not name it as
 * its host face. A wrong guess therefore costs a restart instead of silently
 * serving stale Host code.
 *
 * Usage: `pnpm run dev:desktop:hot [--skip-build] [--poll[=ms]]`.
 */
import { opendirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { discoverLibraryDirs, discoverPluginDirs } from './dev-web.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Repository root, the working directory of every supervised stage. */
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Source trees the restart watcher covers. `integrations/workgroup` rather than `integrations`:
 * its siblings are a vendored upstream checkout (with its own test residue) and a two-file
 * package the Desktop application source already covers.
 */
const WATCHED_ROOTS = ['apps/desktop/src', 'apps/desktop-host/src', 'apps/cli/src', 'apps/web', 'packages', 'vendor', 'native', 'integrations/workgroup']

/** Host-owned trees: an edit anywhere inside one restarts the shell. */
const HOST_ROOTS = ['apps/desktop/', 'apps/desktop-host/', 'apps/cli/']

/**
 * Trees the client build serves: vite rewrites the shell dist and the Host
 * reloads it, and the remaining top-level files there are build and test inputs
 * rather than Host runtime code.
 */
const CLIENT_ROOTS = ['apps/web/']

/** DS Bot's package root, whose two halves share one directory and one manifest. */
const DS_BOT_ROOT = 'packages/bundle/ds-bot/'

/** The staged browser artifact `exports["./client"]` names, living beside the Host modules. */
const DS_BOT_CLIENT_ARTIFACT = `${DS_BOT_ROOT}client.js`

/** Path segments that never carry watchable source. */
const IGNORED_SEGMENTS = new Set(['node_modules', 'lib', 'dist', '.git', '.desktop-build', 'coverage', 'snapshots', 'backups'])

/** Source extensions; anything else is an editor or tool byproduct. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.yaml', '.yml'])

/** Artifacts `dev:web --skip-build` and `start:desktop` require from a prior build. */
const REQUIRED_ARTIFACTS = ['apps/desktop/lib/main.js', 'apps/desktop-host/lib/index.js']

/** Quiet period after the last observed write before a restart starts. */
const RESTART_DEBOUNCE_MS = 400

/** Grace period between terminating a stage and forcing it. */
const STOP_GRACE_MS = 5_000

/** Polling interval selected by a bare `--poll`. */
const DEFAULT_POLL_INTERVAL = 500

/** One supervised long-lived child process. */
interface Stage {
  readonly name: string
  readonly child: ReturnType<typeof spawnPnpm>
}

/** Resolved `dev-desktop-hot` command line. */
export interface DevDesktopHotArguments {
  /** Skip the first build, reusing the artifact tree a prior build left. */
  readonly skipBuild: boolean
  /** Source-watcher polling interval in milliseconds; undefined selects the 500ms default. */
  readonly pollInterval: number | undefined
  /**
   * Keep the running shell alive when Host-side sources change. The browser half still
   * hot-swaps, and a Host edit only prints the command that applies it. `dev:desktop:hmr`
   * selects this; the plain loop restarts, because a Host edit that is never applied is the
   * failure this loop exists to catch.
   */
  readonly hotOnly: boolean
}

/** One classification decision, with the rule that produced it for diagnostics. */
export interface ChangeDecision {
  /** `client` leaves the running shell untouched; `restart` relaunches it. */
  readonly action: 'restart' | 'client'
  /** Rule that selected the action. */
  readonly reason: string
}

/**
 * Parse the script's command line.
 * @param argv - arguments after the script path.
 * @returns the resolved flags.
 * @throws Error when an option is unknown or `--poll` carries a non-positive or non-integer interval.
 */
export function parseDevDesktopHotArguments(argv: readonly string[]): DevDesktopHotArguments {
  let skipBuild = false
  let pollInterval: number | undefined
  let hotOnly = false
  for (const arg of argv) {
    // `pnpm run` forwards a `--` separator verbatim; it carries no meaning here.
    if (arg === '--') continue
    if (arg === '--skip-build') skipBuild = true
    else if (arg === '--hot-only') hotOnly = true
    else if (arg === '--poll' || arg.startsWith('--poll=')) {
      pollInterval = arg === '--poll' ? DEFAULT_POLL_INTERVAL : Number(arg.slice('--poll='.length))
      if (!Number.isInteger(pollInterval) || pollInterval <= 0) throw new Error(`dev-desktop-hot: invalid --poll interval "${arg}"`)
    } else {
      throw new Error(`dev-desktop-hot: unknown option "${arg}"; usage: pnpm run dev:desktop:hot [--skip-build] [--poll[=ms]] [--hot-only]`)
    }
  }
  return { skipBuild, pollInterval, hotOnly }
}

/**
 * Remove the comments a `tsconfig` may carry, since JSONC is not strict JSON.
 * The package-level host configurations this reads are small; a file this
 * cannot parse yields no host face and is then treated as host-side.
 * @param text - file contents.
 * @returns contents with block and line comments removed.
 */
function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
}

/**
 * List the files one client package declares as its Host face, relative to that
 * package directory. A package without the configuration has no Host face, so
 * every one of its sources is browser-side; a configuration whose `files` entry
 * is unusable is unknowable here and therefore conservative.
 * @param packageDir - repository-relative package directory.
 * @param cache - resolved answers, so each package is read at most once.
 * @returns host-face file paths, or undefined when the package must be treated as host-side.
 */
function hostFaceFiles(packageDir: string, cache: Map<string, Set<string> | undefined>): Set<string> | undefined {
  const cached = cache.get(packageDir)
  if (cached !== undefined || cache.has(packageDir)) return cached
  let files: Set<string> | undefined
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(join(repoRoot, packageDir, 'tsconfig.host.json'), 'utf8'))) as {
      files?: unknown
    }
    files = Array.isArray(parsed.files) && parsed.files.every(entry => typeof entry === 'string')
      ? new Set((parsed.files as string[]).map(entry => entry.replace(/^\.\//u, '')))
      : undefined
  } catch (error) {
    // A missing host configuration means the package has no Host face at all;
    // any other read or parse failure leaves the face unknown.
    files = (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : undefined
  }
  cache.set(packageDir, files)
  return files
}

/**
 * Decide what one changed repository source means for the running shell.
 * @param relativePath - repository-relative POSIX path.
 * @param clientPackages - package directories the client build owns.
 * @param hostFaces - resolved host-face file sets, keyed by package directory.
 * @returns the action and the rule that selected it.
 */
export function classifySourceChange(
  relativePath: string,
  clientPackages: ReadonlySet<string>,
  hostFaces: Map<string, Set<string> | undefined>,
): ChangeDecision {
  const path = relativePath.replace(/^\.\//u, '')
  // DS Bot's browser artifact is staged, not compiled, so the generic package rule below cannot
  // see the split: the package has no `tsconfig.host.json`, which that rule reads as "no Host
  // face", and a Host edit is then served as browser-side and never applied. Everything under
  // `src/client` is the half the shell hot-swaps; the rest of the package (the Host modules
  // staging mirrors into `lib/src/host/**`, plus the shared modules both halves import) needs a
  // restart.
  if (path.startsWith(DS_BOT_ROOT)) {
    // The package root holds the staged browser artifact `exports["./client"]` names, so a
    // rebuild of it is browser-side work: restarting for it would relaunch the shell on every
    // browser edit, which is the interruption the hot loop exists to avoid.
    return path === DS_BOT_CLIENT_ARTIFACT || path.startsWith(`${DS_BOT_ROOT}src/client/`)
      ? { action: 'client', reason: 'DS Bot browser half' }
      : { action: 'restart', reason: 'DS Bot Host or shared half' }
  }
  for (const root of CLIENT_ROOTS) {
    if (path.startsWith(root)) return { action: 'client', reason: 'browser-side tree' }
  }
  for (const root of HOST_ROOTS) {
    if (path.startsWith(root)) return { action: 'restart', reason: 'host application source' }
  }
  const parts = path.split('/')
  if (parts[0] === 'packages' && parts.length > 4 && parts[3] === 'src') {
    const packageDir = parts.slice(0, 3).join('/')
    if (!clientPackages.has(packageDir)) return { action: 'restart', reason: 'host-side package' }
    const files = hostFaceFiles(packageDir, hostFaces)
    if (files === undefined) return { action: 'restart', reason: 'undetermined host face' }
    const member = parts.slice(3).join('/')
    if (member.endsWith('.css')) return { action: 'client', reason: 'stylesheet' }
    return files.has(member)
      ? { action: 'restart', reason: 'declared host-face file' }
      : { action: 'client', reason: 'client-side package source' }
  }
  return { action: 'restart', reason: 'outside the client build' }
}

/**
 * Filter watcher notifications down to watchable source writes.
 * @param relativePath - repository-relative POSIX path.
 * @returns true when the path is a source file this loop reacts to.
 */
export function isWatchableSource(relativePath: string): boolean {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  if (name === '' || name.startsWith('.') || name.endsWith('~')) return false
  if (name.endsWith('.tsbuildinfo') || name.endsWith('.tmp')) return false
  if (relativePath.split('/').some(segment => IGNORED_SEGMENTS.has(segment))) return false
  const dot = name.lastIndexOf('.')
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot))
}

/**
 * Remove the Electron Node-mode override this hosting shell sets. Left in
 * place, `electron.exe` starts as a Node process and rejects every Chromium
 * switch the Desktop launcher passes, which is how the launcher fails here.
 * @returns the environment child stages inherit.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') Reflect.deleteProperty(environment, name)
  }
  return environment
}

/**
 * Terminate one supervised stage and everything it spawned. Windows needs the
 * tree kill: the launcher reaches Electron through pnpm and tsx, and Electron's
 * renderer processes outlive a signal aimed at the parent alone.
 * @param stage - supervised child process.
 * @returns Resolves after the process tree is gone or the grace period expired.
 */
async function stopStage(stage: Stage): Promise<void> {
  const { pid } = stage.child
  if (pid === undefined) return
  if (process.platform === 'win32') {
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false, stdio: 'ignore' })
  } else {
    stage.child.kill('SIGTERM')
  }
  const exited = await Promise.race([
    stage.child.then(() => true, () => true),
    new Promise<false>(resolve => { setTimeout(() => { resolve(false) }, STOP_GRACE_MS).unref() }),
  ])
  if (!exited) {
    console.error(`dev-desktop-hot: ${stage.name} did not exit within ${String(STOP_GRACE_MS)}ms; forcing it`)
    stage.child.kill('SIGKILL')
  }
}

/**
 * Start one pnpm script with inherited stdio, without the Electron Node-mode override.
 * @param args - arguments for pnpm, script first.
 * @returns the running child process.
 */
function spawnPnpm(args: readonly string[]) {
  const invocation = pnpmInvocation(args)
  return execa(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: childEnvironment(),
    extendEnv: false,
    reject: false,
  })
}

/**
 * Run one pnpm script to completion with inherited stdio.
 * @param args - arguments for pnpm, script first.
 * @returns the exit code, or null when a signal ended the child.
 */
async function runToCompletion(args: readonly string[]): Promise<number | null> {
  const result = await spawnPnpm(args)
  return result.exitCode ?? null
}

/**
 * Collect the watchable source files under one tree, pruning the directories
 * that hold build output and installed dependencies. Recursive `fs.watch`
 * cannot be used for these trees: registering it on Windows walks the whole
 * tree including every package's `node_modules`, which stalls the loop long
 * after the shell is running, and `readdirSync(..., { recursive: true })` pays
 * the same cost on every scan.
 * @param directory - absolute directory to walk.
 * @param out - accumulator receiving absolute file paths.
 * @param depth - remaining directory levels; undefined walks the whole tree.
 */
function collectSources(directory: string, out: string[], depth?: number): void {
  let handle: ReturnType<typeof opendirSync>
  try {
    handle = opendirSync(directory)
  } catch (error) {
    console.error(`dev-desktop-hot: cannot read ${directory} (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  try {
    let entry = handle.readSync()
    while (entry !== null) {
      if (!IGNORED_SEGMENTS.has(entry.name) && entry.name !== '.bin') {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (depth === undefined || depth > 0) collectSources(path, out, depth === undefined ? undefined : depth - 1)
        } else {
          const dot = entry.name.lastIndexOf('.')
          if (dot >= 0 && SOURCE_EXTENSIONS.has(entry.name.slice(dot))) out.push(path)
        }
      }
      entry = handle.readSync()
    }
  } finally {
    handle.closeSync()
  }
}

/**
 * Watch every covered source tree by polling their mtimes. The interval bounds
 * one scan; a scan over this repository's source trees costs roughly one
 * interval, so the effective detection latency is about twice the interval.
 * @param options - parsed command line.
 * @param onChange - called with each changed repository-relative path.
 * @returns a disposer that stops polling.
 */
function watchSources(options: DevDesktopHotArguments, onChange: (relativePath: string) => void): () => void {
  const interval = options.pollInterval ?? DEFAULT_POLL_INTERVAL
  const seen = new Map<string, number>()
  let scanning = false
  const scan = (): void => {
    // A slow scan must not queue behind itself and multiply its own cost.
    if (scanning) return
    scanning = true
    try {
      for (const root of WATCHED_ROOTS) {
        const files: string[] = []
        collectSources(join(repoRoot, root), files)
        for (const absolute of files) {
          // Report repository-relative paths: classifySourceChange expects
          // them, and a root-relative key collides across watched roots whose
          // leaf names coincide, making every scan report a false change.
          const relativePath = relative(repoRoot, absolute).split(sep).join('/')
          if (!isWatchableSource(relativePath)) continue
          let mtime: number
          try {
            mtime = statSync(absolute).mtimeMs
          } catch {
            continue
          }
          const previous = seen.get(absolute)
          seen.set(absolute, mtime)
          if (previous !== undefined && previous !== mtime) onChange(relativePath)
        }
      }
    } finally {
      scanning = false
    }
  }
  scan()
  const timer = setInterval(scan, interval)
  console.log(`dev-desktop-hot: polling source trees every ${String(interval)}ms`)
  return () => { clearInterval(timer) }
}

/**
 * Run the loop: first build and launch, client watcher, source watcher, then
 * shutdown on the first terminal signal or unexpected stage exit.
 * @param options - parsed command line.
 */
async function main(options: DevDesktopHotArguments): Promise<void> {
  const shutdown = Promise.withResolvers<number>()
  console.log(`dev-desktop-hot: mode=${options.hotOnly ? 'hot-only (dev:desktop:hmr)' : 'restart (dev:desktop:hot)'}`)
  let requested: number | undefined
  const requestShutdown = (code: number): void => {
    if (requested !== undefined) return
    requested = code
    shutdown.resolve(code)
  }

  const stages: Stage[] = []
  let restarting = false
  let queued = false
  let debounce: NodeJS.Timeout | undefined

  const spawnStage = (name: string, args: readonly string[]): Stage => {
    const child = spawnPnpm(args)
    stages.push({ name, child })
    void child.then(() => {
      // A stage this loop stopped on purpose must not end the loop.
      if (requested === undefined && !restarting) {
        console.error(`dev-desktop-hot: ${name} exited; stopping the loop`)
        requestShutdown(1)
      }
    }, () => {})
    return { name, child }
  }

  const startDesktop = (): void => {
    console.log('dev-desktop-hot: launching the Desktop shell')
    spawnStage('desktop', ['run', 'start:desktop'])
  }

  const restart = async (): Promise<void> => {
    if (restarting) {
      queued = true
      return
    }
    restarting = true
    try {
      do {
        queued = false
        const desktop = stages.findIndex(stage => stage.name === 'desktop')
        if (desktop >= 0) {
          const [stage] = stages.splice(desktop, 1)
          if (stage !== undefined) await stopStage(stage)
        }
        if (requested !== undefined) return
        const built = await runToCompletion(['run', 'build:lib:host'])
        if (built !== 0) {
          console.error(`dev-desktop-hot: build:lib:host exited (code ${String(built)}); the shell stays stopped until a new edit rebuilds it`)
          continue
        }
        // DS Bot's Host half is staged by its own script, which no repository build runs: the
        // staging script postdates the repository build graph. Skipping it restarts the shell
        // onto the previous `lib/` snapshot, which is the failure this loop exists to prevent.
        const staged = await runToCompletion(['exec', 'node', 'packages/bundle/ds-bot/scripts/build-lib.mjs'])
        if (requested !== undefined) return
        if (staged !== 0) {
          console.error(`dev-desktop-hot: DS Bot lib/ staging exited (code ${String(staged)}); the shell stays stopped until a new edit rebuilds it`)
          continue
        }
        startDesktop()
      } while (queued)
    } finally {
      restarting = false
    }
  }

  process.on('SIGINT', () => { requestShutdown(130) })
  process.on('SIGTERM', () => { requestShutdown(0) })

  if (!options.skipBuild) {
    const built = await runToCompletion(['run', 'build:artifacts'])
    if (built !== 0) {
      console.error(`dev-desktop-hot: build:artifacts exited (code ${String(built)}); fix the build before starting the loop`)
      process.exit(1)
    }
  }

  const missing = REQUIRED_ARTIFACTS.filter(path => {
    try {
      statSync(join(repoRoot, path))
      return false
    } catch {
      return true
    }
  })
  if (missing.length > 0) {
    console.error(`dev-desktop-hot: missing built artifacts ${missing.join(', ')}; rerun without --skip-build`)
    process.exit(1)
  }

  // The client watcher is incremental over the tree the first build left and
  // never bootstraps a missing one, so it always starts with `--skip-build`.
  spawnStage('client watcher', [
    'run', 'dev:web', '--no-serve', '--skip-build',
    ...options.pollInterval !== undefined ? [`--poll=${String(options.pollInterval)}`] : [],
  ])
  startDesktop()

  const clientPackages = new Set([...discoverPluginDirs(repoRoot), ...discoverLibraryDirs(repoRoot)])
  const hostFaces = new Map<string, Set<string> | undefined>()
  console.log(`dev-desktop-hot: ${String(clientPackages.size)} client-owned package directories stay on the HMR path`)

  const disposeWatchers = watchSources(options, relativePath => {
    if (!isWatchableSource(relativePath)) return
    const decision = classifySourceChange(relativePath, clientPackages, hostFaces)
    if (decision.action === 'client') {
      console.log(`dev-desktop-hot: browser-side change ${relativePath} (${decision.reason}); the client watcher owns it, no restart`)
      return
    }
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
    if (debounce !== undefined) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void restart()
    }, RESTART_DEBOUNCE_MS)
  })

  const exitCode = await shutdown.promise
  console.log('dev-desktop-hot: stopping the Desktop shell and the client watcher')
  if (debounce !== undefined) clearTimeout(debounce)
  disposeWatchers()
  for (const stage of [...stages].reverse()) await stopStage(stage)
  process.exit(exitCode)
}

if (import.meta.main) {
  let options: DevDesktopHotArguments
  try {
    options = parseDevDesktopHotArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  await main(options)
}
