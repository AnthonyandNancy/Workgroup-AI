import { describe, expect, it } from 'vitest'
import { classifySourceChange, isWatchableSource, parseDevDesktopHotArguments } from './dev-desktop-hot.ts'

const clientPackages = new Set(['packages/bundle/ds-bot', 'packages/client/modules'])
const hostFaces = new Map<string, Set<string> | undefined>([['packages/client/modules', new Set(['src/index.ts'])]])

describe('classifySourceChange', () => {
  it('keeps DS Bot browser sources on the HMR path', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/client/i18n.js', clientPackages, hostFaces).action).toBe('client')
  })

  it('keeps the staged browser artifact beside the Host modules on the HMR path', () => {
    // `exports["./client"]` names this file, and `build-client.mjs` rewrites it on every browser
    // edit: restarting for it would relaunch the shell on each browser-side change.
    expect(classifySourceChange('packages/bundle/ds-bot/client.js', clientPackages, hostFaces)).toEqual({
      action: 'client',
      reason: 'DS Bot browser half',
    })
  })

  it('restarts for DS Bot host and shared sources instead of treating them as browser-side', () => {
    expect(classifySourceChange('packages/bundle/ds-bot/src/host/tools.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/src/shared/workgroup-session.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/index.js', clientPackages, hostFaces).action).toBe('restart')
    expect(classifySourceChange('packages/bundle/ds-bot/web-search.js', clientPackages, hostFaces).action).toBe('restart')
  })

  it('restarts for the workgroup integration sources the DS Bot Host imports', () => {
    expect(classifySourceChange('integrations/workgroup/client/index.mjs', clientPackages, hostFaces).action).toBe('restart')
  })

  it('keeps a declared host-face file of an ordinary client package restarting', () => {
    expect(classifySourceChange('packages/client/modules/src/index.ts', clientPackages, hostFaces).action).toBe('restart')
  })
})

describe('isWatchableSource', () => {
  it('accepts the .mjs modules integration packages ship', () => {
    expect(isWatchableSource('integrations/workgroup/policy/egress.mjs')).toBe(true)
  })
})

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
    expect(() => parseDevDesktopHotArguments(['--hot'])).toThrow(/unknown option/u)
  })
})
