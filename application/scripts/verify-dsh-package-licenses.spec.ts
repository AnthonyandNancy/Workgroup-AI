import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDshPackageLicenses } from './verify-dsh-package-licenses.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-licenses-'))
  roots.push(root)
  writeManifest(root, 'package.json', {
    name: '@deepseek-ai/dsh-root',
    license: 'MIT',
    workspaces: ['apps/*', 'packages/*/*', 'vendor/*'],
  })
  return root
}

describe('DSH package license gate', () => {
  it('checks root, unhyphenated CLI, and dsh-prefixed package names while ignoring other families', () => {
    const root = createWorkspace()
    writeManifest(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', license: 'MIT' })
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@deepseek-ai/dsh-agent',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'vendor/cordis/package.json', {
      name: '@deepseek-ai/cordis',
      license: 'BSD-3-Clause',
    })

    expect(inspectDshPackageLicenses(root)).toEqual({
      packageCount: 3,
      failures: [
        'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare "license": "MIT"; found "BSD-3-Clause".',
      ],
    })
  })

  it('rejects a missing license declaration', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', { name: '@deepseek-ai/dsh-agent' })

    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare "license": "MIT"; found undefined.',
    ])
  })

  it('accepts a vendored package only under its pinned upstream license', () => {
    // A bundle may vendor third-party code, and redeclaring it MIT would misstate provenance and
    // drop required attribution. The retained value is pinned, so it cannot drift either.
    const root = createWorkspace()
    writeManifest(root, 'packages/bundle/ds-bot/package.json', {
      name: '@deepseek-ai/dsh-bot',
      license: 'Apache-2.0',
    })
    expect(inspectDshPackageLicenses(root).failures).toEqual([])

    // A different non-MIT value is still rejected: the pin is exact, not "anything but MIT".
    writeManifest(root, 'packages/bundle/ds-bot/package.json', {
      name: '@deepseek-ai/dsh-bot',
      license: 'GPL-3.0',
    })
    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/bundle/ds-bot/package.json: @deepseek-ai/dsh-bot vendors upstream code and must retain "license": "Apache-2.0"; found "GPL-3.0".',
    ])
  })

  it('does not let the vendored exception cover an unrelated package', () => {
    // The exception is keyed by name; another package claiming Apache-2.0 must still fail.
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@deepseek-ai/dsh-agent',
      license: 'Apache-2.0',
    })
    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare "license": "MIT"; found "Apache-2.0".',
    ])
  })
})
