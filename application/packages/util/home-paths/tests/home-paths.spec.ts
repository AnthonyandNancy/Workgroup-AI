import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  resolveAgentsHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.workgroup-ai')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.workgroup-ai')
    expect(defaultDshHome()).toBe(join(homedir(), '.workgroup-ai'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before WORKGROUP_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { WORKGROUP_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { WORKGROUP_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only WORKGROUP_HOME as unset', () => {
    expect(resolveDshHome(undefined, { WORKGROUP_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { WORKGROUP_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved WORKGROUP_HOME', () => {
    vi.stubEnv('WORKGROUP_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.workgroup-ai')
    expect(dshHomeDisplay('/some/other/root')).toBe('$WORKGROUP_HOME')
  })

  it('owns the product-scoped default agents home directory name', () => {
    // Product-scoped rather than upstream's `~/.agents`: an installed official harness keeps its
    // own shared agent configuration root, so neither product adopts the other's instructions.
    expect(AGENTS_HOME_DIR_NAME).toBe('.workgroup-ai-agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.workgroup-ai-agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.workgroup-ai-agents'))
  })

  it('resolves an explicit agents home before WORKGROUP_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { WORKGROUP_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { WORKGROUP_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only WORKGROUP_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { WORKGROUP_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { WORKGROUP_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.workgroup-ai-agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$WORKGROUP_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.workgroup-ai')],
    ['', join(homedir(), '.workgroup-ai')],
    ['   ', join(homedir(), '.workgroup-ai')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with WORKGROUP_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('WORKGROUP_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('WORKGROUP_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
