// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextEncoder, TextDecoder } from 'node:util'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const nodeUint8Array = new TextEncoder().encode('').constructor
Object.assign(globalThis, { TextEncoder, TextDecoder, Uint8Array: nodeUint8Array })

// Compile the source with the same React instance as ds-bot. Only the shell's external artwork
// and markdown primitives are replaced; the Settings dialog and its real page routing stay intact.
const packageRoot = resolve(process.cwd(), 'packages', 'bundle', 'ds-bot')
const settingsPath = resolve(packageRoot, 'src', 'client', 'settings.js')
const botRequire = createRequire(resolve(packageRoot, 'package.json'))
const { build } = botRequire('esbuild')
const { createElement: h, act } = botRequire('react')
const { createRoot } = botRequire('react-dom/client')
let SettingsDialog
let root
let container

beforeAll(async () => {
  const result = await build({
    entryPoints: [settingsPath],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    external: ['react', 'react-dom'],
    plugins: [{
      name: 'shell-primitives',
      setup(builder) {
        builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'test-shell' }))
        builder.onLoad({ filter: /.*/, namespace: 'test-shell' }, () => ({ contents: 'export const FishLogo = () => null; export const MarkdownText = () => null;' }))
      },
    }],
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(botRequire, module, module.exports)
  SettingsDialog = module.exports.SettingsDialog
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

async function mountSettings(page = 'general', workgroups) {
  const actions = { closeSettings: vi.fn(), openSettings: vi.fn(), openSession: vi.fn() }
  const props = {
    page,
    roster: { byId: {}, roomsById: {}, bots: [{ id: 'bot-1', name: 'One' }, { id: 'bot-2', name: 'Two' }], rooms: [], prefs: {} },
    actions,
    useUpdate: () => ({}),
    workgroups,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(h(SettingsDialog, props)))
  return { actions }
}

describe('Bot Settings', () => {
  it('does not expose Hub configuration or authentication controls', async () => {
    await mountSettings('hub')

    expect(container.textContent).not.toContain('Workgroup Hub')
    expect(container.textContent).not.toContain('Hub URL')
    expect(container.textContent).not.toContain('Username')
    expect(container.textContent).not.toContain('Password')
    expect(container.textContent).not.toContain('Registration key')
    expect(container.textContent).not.toContain('Configure Hub')
    expect(container.textContent).not.toContain('Sign in')
    expect(container.textContent).not.toContain('Register')
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('keeps the workgroup creation entry directly below ordinary group creation', async () => {
    const workgroups = { create: vi.fn(async () => undefined) }
    await mountSettings('groups', workgroups)

    const buttons = Array.from(container.querySelectorAll('button')).map(button => button.textContent)
    expect(buttons.indexOf('Create group chat')).toBeGreaterThanOrEqual(0)
    expect(buttons.indexOf('Create workgroup chat')).toBe(buttons.indexOf('Create group chat') + 1)
  })
})
