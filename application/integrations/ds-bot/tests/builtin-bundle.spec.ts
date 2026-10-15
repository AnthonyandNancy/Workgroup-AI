// F-06: DS Bot ships inside the product as one bundle, mounted by one path.
//
// The requirement has two halves, and the second is the one that is easy to get wrong:
//
//  1. A fresh install already has Chief — the user never installs a plugin. That means the
//     Bot runtime must be a *default bundle* of the product's profiles, not an optional
//     entry the user adds.
//  2. Exactly one Bot Host is active. The upstream plugin-install flow (a profile listing
//     `@deepseek-ai/dsh-bot` as a dependency plus the plugin manager's own patch) is the second
//     would mount the same host twice, and two hosts on one data root do not merely cost
//     memory: they contend for `state.lock`, and the loser degrades to a read-only team.
//
// These cases read the real profile templates and the real desktop project manager, so a
// change to either is caught here instead of at a user's first launch.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROFILE_TEMPLATES, DEFAULT_PROFILE_BUNDLES, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const BOT_BUNDLE = '@deepseek-ai/dsh-bot'
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const botPackageDir = join(repoRoot, 'packages', 'bundle', 'ds-bot')

describe('DS Bot is a built-in bundle of this product', () => {
  it('is a default bundle of the web profile, which the desktop client also uses', () => {
    // The desktop shell initializes its project from PROFILE_TEMPLATES.web, so covering the
    // web template covers both surfaces the product ships.
    expect(PROFILE_TEMPLATES.web.bundles).toContain(BOT_BUNDLE)
  })

  it('is listed exactly once, so no profile mounts the host twice', () => {
    const occurrences = PROFILE_TEMPLATES.web.bundles.filter(name => name === BOT_BUNDLE)
    expect(occurrences).toHaveLength(1)
  })

  it('is not a default of the surfaces that have no Bot UI', () => {
    // The Bot surface is a browser UI. Mounting its host in a surface that cannot show it
    // would run an agent host nobody asked for, on data the user cannot see.
    expect(PROFILE_TEMPLATES.acp.bundles).not.toContain(BOT_BUNDLE)
    expect(PROFILE_TEMPLATES.headless.bundles).not.toContain(BOT_BUNDLE)
    expect(PROFILE_TEMPLATES.sdk.bundles).not.toContain(BOT_BUNDLE)
    expect(PROFILE_TEMPLATES['sdk-minimal'].bundles).not.toContain(BOT_BUNDLE)
    // The generic plugin-init default stays upstream's: an unnamed profile is not this product.
    expect(DEFAULT_PROFILE_BUNDLES).not.toContain(BOT_BUNDLE)
  })

  it('ships a resolvable bundle package with a host patch', () => {
    const manifest = JSON.parse(readFileSync(join(botPackageDir, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(BOT_BUNDLE)
    expect(manifest.dsh?.bundle?.patch).toBeTruthy()
    expect(existsSync(join(botPackageDir, manifest.dsh.bundle.patch))).toBe(true)
    // The main entry the Loader imports for the host half must exist and export the plugin
    // contract: a named `apply`, or the Loader discards its namespace.
    expect(existsSync(join(botPackageDir, manifest.main))).toBe(true)
    const index = readFileSync(join(botPackageDir, manifest.main), 'utf8')
    expect(index).toMatch(/export\s+(function\s+apply|const\s+apply)/)
    expect(index).toMatch(/export\s+const\s+inject\s*=/)
  })

  it('resolves through the real profile loader, which is what a shipped install actually does', () => {
    // The requirement is that a fresh install has a Bot, and a profile naming the bundle is not
    // that: `loadProfileDirectory` silently skips a bundle it cannot resolve, so a name that
    // exists only in the template reads as "configured" while the user gets no Bot entry at all.
    // This drives the real loader over a profile shaped exactly like the one Desktop writes —
    // `dependencies: {}`, bundles from the template — and asserts the bundle is among the loaded
    // layers rather than the skipped ones.
    const dir = mkdtempSync(join(tmpdir(), 'wg-bundle-resolve-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...PROFILE_TEMPLATES.web.bundles] } },
      }))
      // The install anchor is the app that owns the `dsh` bin: the bundle must resolve from the
      // installation itself, because a fresh profile has no node_modules of its own yet.
      const anchor = join(repoRoot, 'apps', 'cli', 'package.json')
      const profile = loadProfileDirectory('dsh', dir, anchor, { userLayer: false })
      expect(profile.layers.map(layer => layer.packageName)).toContain(BOT_BUNDLE)
      expect(profile.skippedBundles.map(row => row.packageName)).not.toContain(BOT_BUNDLE)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('declares its own host row, and the watch of that row is the only mount in the patch', () => {
    const manifest = JSON.parse(readFileSync(join(botPackageDir, 'package.json'), 'utf8'))
    const patch = readFileSync(join(botPackageDir, manifest.dsh.bundle.patch), 'utf8')
    // Count the rows whose `name` mounts the host plugin, not the companion web-search row.
    const hostRows = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$\n\s*name:\s*'@deepseek-ai\/dsh-bot'\s*$/gm)]
    expect(hostRows).toHaveLength(1)
    expect(hostRows[0][1]).toBe('bot')
  })

  it('the desktop first-run profile initialization names the Bot bundle exactly once', async () => {
    // `createPluginProfile` is what a first launch runs to materialize the profile, so it is
    // the function that decides whether the user starts with a Bot or has to install one.
    const { createPluginProfile } = await import('../../../apps/desktop/src/project-manager.ts')
    const root = mkdtempSync(join(tmpdir(), 'wg-f06-project-'))
    try {
      const profileDir = join(root, 'profile')
      createPluginProfile(profileDir)
      const manifestPath = join(profileDir, 'package.json')
      expect(existsSync(manifestPath)).toBe(true)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.dsh.profile.bundles).toContain(BOT_BUNDLE)
      expect(manifest.dsh.profile.bundles.filter((b: string) => b === BOT_BUNDLE)).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('every project-metadata writer spreads that one template, so no writer can drift', async () => {
    // Two writers build a project manifest: the signed runtime and the development project.
    // Both spread WEB_PROFILE.bundles rather than naming bundles themselves, which is what
    // makes the single edit in PROFILE_TEMPLATES.web reach every surface.
    const source = readFileSync(join(repoRoot, 'apps', 'desktop', 'src', 'project-manager.ts'), 'utf8')
    const spreads = [...source.matchAll(/bundles:\s*\[\.\.\.WEB_PROFILE\.bundles\]/g)]
    expect(spreads).toHaveLength(2)
    // No writer may name a bundle literal, which would be a second place to keep in sync.
    const literals = [...source.matchAll(/bundles:\s*\[\s*['"]/g)]
    expect(literals).toHaveLength(0)
  })

  it('disabling third-party bundles during recovery keeps the built-in Bot and nothing else custom', async () => {
    const { DesktopProjectManager } = await import('../../../apps/desktop/src/project-manager.ts')
    const root = mkdtempSync(join(tmpdir(), 'wg-f06-recovery-'))
    try {
      const paths = {
        root,
        profile: join(root, 'profile'),
        project: join(root, 'project'),
        runtime: join(root, 'runtime'),
      }
      mkdirSync(paths.profile, { recursive: true })
      writeFileSync(join(paths.profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BOT_BUNDLE, 'some-other-plugin'] } },
      }, undefined, 2))
      const manager = new DesktopProjectManager(paths as never, { dsh: join(root, 'runtime') } as never)
      // Recovery sanitizes the profile back to the product template: the built-in Bot is part
      // of the product and must survive, while a user's third-party bundle must not.
      await manager.disableAllPlugins()
      const manifest = JSON.parse(readFileSync(join(paths.profile, 'package.json'), 'utf8'))
      expect(manifest.dsh.profile.bundles).toContain(BOT_BUNDLE)
      expect(manifest.dsh.profile.bundles).not.toContain('some-other-plugin')
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
