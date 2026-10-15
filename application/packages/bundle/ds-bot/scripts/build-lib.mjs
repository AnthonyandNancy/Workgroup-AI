// Stage the Host half of the bundle into lib/, laid out exactly as the package
// exports it.
//
//   node scripts/build-lib.mjs           writes lib/
//   node scripts/build-lib.mjs --check   exits 1 when lib/ differs from a fresh build
//
// The Host half is plain JavaScript whose modules import each other, and whose
// peers (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`)
// resolve from the dsh profile that loads the plugin. So there is nothing to
// bundle: the files are copied with their relative structure intact, which is
// what keeps `import './src/host/x.js'` working from `lib/index.js`. The one
// generated artifact is the declaration pair the workspace manifest policy
// requires; `types/index.d.ts` is its authored source.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB = join(PLUGIN, 'lib')

/** Host-side files published under `lib/`, paired with the path they publish as. */
const ENTRIES = [
  ['index.js', 'index.js'],
  ['web-search.js', 'web-search.js'],
  // The browser half is built by `build-client.mjs` into the package root and is committed
  // there, because `link:` and git installs load it without running a build. The package's
  // `./client` export resolves under `lib/`, so the same bytes are also staged here.
  ['client.js', 'client.js'],
  ['src/host', 'src/host'],
  ['src/shared', 'src/shared'],
  // `src/host/*.js` reads its own package metadata as `new URL('../../package.json',
  // import.meta.url)`, which resolves to the package root from `src/host/` but to `lib/` from
  // `lib/src/host/`. The manifest is copied to where those modules actually look for it;
  // `assertManifestRelativeReads` below keeps that from silently drifting.
  ['package.json', 'package.json'],
]

/** Recursively collect `{ relative, absolute }` for every file under one source directory. */
function filesUnder(root, prefix = '') {
  const found = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...filesUnder(root, next))
    else if (entry.isFile()) found.push(next)
  }
  return found
}

/**
 * Render the complete `lib/` tree in memory, so `--check` compares bytes rather
 * than timestamps.
 * @returns relative output path to contents, both as buffers.
 */
export function buildLib() {
  const files = new Map()
  for (const [source, target] of ENTRIES) {
    const absolute = join(PLUGIN, source)
    if (source.endsWith('.json') || source.endsWith('.js')) {
      files.set(target, readFileSync(absolute))
      continue
    }
    for (const file of filesUnder(absolute)) files.set(`${target}/${file}`, readFileSync(join(absolute, file)))
  }
  files.set('types/index.d.ts', readFileSync(join(PLUGIN, 'types', 'index.d.ts')))
  return files
}

/**
 * Every `import.meta.url`-relative path the staged modules read, resolved from their published
 * location, asserted to exist inside the rendered tree.
 *
 * Staging moves each module one level deeper, so a path written against the source layout can
 * point somewhere else once published. The failure is silent at build time and surfaces only as
 * a plugin entry that "did not activate", which is why it is checked here instead of trusted.
 * @param files - Rendered `lib/` tree, keyed by published relative path.
 * @throws If a relative read resolves outside the tree or names a file the tree omits.
 */
function assertManifestRelativeReads(files) {
  const pattern = /new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g
  for (const [target, contents] of files) {
    if (!target.endsWith('.js')) continue
    for (const match of contents.toString('utf8').matchAll(pattern)) {
      const relativeRead = match[1]
      // Only in-package reads are this script's business; a URL with a scheme is not a path.
      if (/^[a-z][a-z0-9+.-]*:/i.test(relativeRead) || relativeRead.startsWith('//')) continue
      const resolved = posix.normalize(posix.join(posix.dirname(target), relativeRead))
      if (resolved.startsWith('..')) {
        throw new Error(`lib staging: ${target} reads ${relativeRead}, which escapes the package`)
      }
      if (!files.has(resolved)) {
        throw new Error(
          `lib staging: ${target} reads ${relativeRead} (resolves to ${resolved}), which lib/ does not contain; `
          + 'add it to ENTRIES so the published module finds it',
        )
      }
    }
  }
}

/** Write one rendered tree to `lib/`, removing files a previous build left behind. */
function writeLib(files) {
  assertManifestRelativeReads(files)
  rmSync(LIB, { recursive: true, force: true })
  for (const [target, contents] of files) {
    const destination = join(LIB, target)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
  }
}

/** Every file currently in `lib/`, as relative POSIX paths. */
function committedFiles() {
  try {
    return filesUnder(LIB).map(file => `lib/${file}`)
  } catch {
    // A missing lib/ counts as stale, as it does for client.js.
    return []
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = buildLib()
  // `--check` proves the same invariant a write does: a stale tree that omits a file a staged
  // module reads must fail here, not in a browser that only says "did not activate".
  assertManifestRelativeReads(next)
  if (process.argv.includes('--check')) {
    const committed = committedFiles().sort()
    const expected = [...next.keys()].map(file => `lib/${file}`).sort()
    const same = committed.length === expected.length
      && committed.every((file, index) => file === expected[index])
      && [...next].every(([target, contents]) => readFileSync(join(LIB, target)).equals(contents))
    if (!same) {
      console.error(`lib/ is stale: run \`npm run build\` in ${relative(process.cwd(), PLUGIN) || '.'} and commit the result`)
      process.exit(1)
    }
  } else {
    writeLib(next)
  }
}
