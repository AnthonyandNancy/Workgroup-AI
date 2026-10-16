// Builds client.js, the browser half, from the modules in src/client.
//
//   node scripts/build-client.mjs           writes client.js
//   node scripts/build-client.mjs --check   exits 1 when client.js differs from a fresh build
//
// client.js is committed, so `link:` and git installs need no build step. dsh loads it as
// a classic script; the wrapper mirrors packages/client/tsdown.client.ts in
// deepseek-harness: `require` resolves the shell-seeded platform modules (react,
// react-dom, ui-primitives, ...), which therefore stay external.
import { globSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(PLUGIN, 'client.js')
const PLATFORM_MODULES = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']
// The loader matches a bundle's registration id against the package it mounted, so the id
// is read from the manifest rather than restated: renaming the package cannot silently
// leave a bundle the shell refuses to activate.
const PACKAGE_NAME = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8')).name

export async function bundleClient() {
  const result = await build({
    // Region comments name sources relative to the plugin, wherever the script runs from.
    absWorkingDir: PLUGIN,
    entryPoints: ['src/client/index.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    // Every source declaration ships, used or not, as in the hand-written bundle.
    treeShaking: false,
    // Readable for debugging in the browser: no minification, and Chinese text stays text.
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) throw new Error(`esbuild warnings:\n${result.warnings.map(warning => warning.text).join('\n')}`)
  return [
    '// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.',
    'window.__ModuleLoader__.load({',
    // The loader keys its table by the loaded package's name and rejects a script that
    // registers anything else, so this must stay equal to package.json `name`.
    `  id: ${JSON.stringify(PACKAGE_NAME)},`,
    '  factory: (require) => {',
    'const module = { exports: {} }',
    result.outputFiles[0].text.trimEnd(),
    // The loader gets a plain exports object tagged as a module, as the tsdown preset
    // emits, rather than esbuild's getter-based `__esModule` object.
    'return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: \'Module\' })',
    '  },',
    '})',
    '',
  ].join('\n')
}

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
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = await bundleClient()
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* missing counts as stale */ }
    if (current !== next) {
      console.error('client.js is stale: run `npm run build` in ds-bot and commit the result')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
  }
}
