/** Windows manifest paths still select the packages whose artifacts Desktop bundles. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { build } from 'tsdown'
import { expect, it, onTestFinished } from 'vitest'
import { workspacePackageGlobs } from './workspace-package-globs.ts'

it('selects workspace packages from Windows and POSIX manifest paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-globs-'))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const manifests = ['packages\\util\\atomic-write\\package.json', 'vendor/cordis/package.json']
  for (const [index, directory] of ['packages/util/atomic-write', 'vendor/cordis'].entries()) {
    await mkdir(join(cwd, directory, 'src'), { recursive: true })
    await writeFile(join(cwd, directory, 'package.json'), JSON.stringify({ name: `fixture-${index}`, type: 'module' }))
    await writeFile(join(cwd, directory, 'src/index.ts'), `export const value = ${index}\n`)
  }
  const options = { cwd, config: false as const, entry: ['src/index.ts'], write: false, dts: false, logLevel: 'silent' as const }
  const selected = await build({ ...options, workspace: workspacePackageGlobs(manifests) })
  expect(selected).toHaveLength(2)
  const unnormalized = await build({ ...options, workspace: manifests.map(path => win32.dirname(path)) })
  expect(unnormalized.map(bundle => bundle.config.name)).toEqual(['fixture-1'])
})

it('keeps only packages that compile into the entry this pass bundles', async () => {
  // The bundling pass consumes `lib/types`, which only a `tsc -b` package produces. A workspace
  // member shipping authored JavaScript has no such entry, and selecting it fails the entire
  // pass with "Cannot find entry" instead of skipping that one package.
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-tsconfig-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const manifests = [
    'packages/bundle/compiled/package.json',
    'packages/bundle/authored/package.json',
    'vendor/cordis/package.json',
  ]
  for (const directory of ['packages/bundle/compiled', 'packages/bundle/authored', 'vendor/cordis']) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, 'package.json'), JSON.stringify({ name: directory, type: 'module' }))
  }
  // A compiled package has tsconfig.json; an authored-JavaScript one deliberately does not.
  await writeFile(join(root, 'packages/bundle/compiled/tsconfig.json'), '{}')
  await writeFile(join(root, 'vendor/cordis/tsconfig.json'), '{}')

  expect(workspacePackageGlobs(manifests, root)).toEqual(['packages/bundle/compiled', 'vendor/cordis'])
  // Without a root there is nothing to test against, so the lexical conversion stays available.
  expect(workspacePackageGlobs(manifests)).toHaveLength(3)
  // A real directory spelling resolves on Windows too; the pattern spelling stays POSIX.
  expect(workspacePackageGlobs(['packages\\bundle\\compiled\\package.json'], root)).toEqual(['packages/bundle/compiled'])
})
