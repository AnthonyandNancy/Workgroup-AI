// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextEncoder, TextDecoder } from 'node:util'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const nodeUint8Array = new TextEncoder().encode('').constructor
Object.assign(globalThis, { TextEncoder, TextDecoder, Uint8Array: nodeUint8Array })

// Compile the source with the same React instance as ds-bot. Only the shell's external artwork
// and markdown primitives are replaced; settings, hooks, navigation and form handlers remain real.
const packageRoot = resolve(process.cwd(), 'packages', 'bundle', 'ds-bot')
const settingsPath = resolve(packageRoot, 'src', 'client', 'settings.js')
const botRequire = createRequire(resolve(packageRoot, 'package.json'))
const { build } = botRequire('esbuild')
const { createElement: h, act } = botRequire('react')
const { createRoot } = botRequire('react-dom/client')
const { Simulate } = botRequire('react-dom/test-utils')
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

async function mountHub(hub = { configured: true, signedIn: true, state: 'connected', userId: 'user-1', userHandle: 'alice', hubUrl: 'https://hub.example/api/v1' }) {
  const workgroupHub = {
    configure: vi.fn(async () => {}), register: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}), resume: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    rooms: vi.fn(async () => [{ id: 'room-1', name: 'Ops' }]),
    invitations: vi.fn(async () => [{ id: 'invite-1', roomId: 'room-2', roomName: 'Finance' }]),
    respondToInvitation: vi.fn(async (_id, decision) => {
      if (!['accept', 'decline'].includes(decision)) throw new Error('INVALID_DECISION')
      return { room: { id: 'room-2' } }
    }),
    watch: vi.fn(async () => {}),
  }
  const actions = { closeSettings: vi.fn(), openSettings: vi.fn(), openSession: vi.fn() }
  const sessions = { list: { getSnapshot: () => ({ byId: {} }) }, create: vi.fn(async () => {}) }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = { page: 'hub', roster: { byId: {}, roomsById: {}, bots: [], rooms: [] }, actions, useUpdate: () => ({}), hub, workgroupHub, sessions }
  await act(async () => root.render(h(SettingsDialog, props)))
  return { workgroupHub, actions, sessions, props }
}

const button = (text) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)
async function click(text) {
  const target = button(text)
  expect(target, `button ${text}`).toBeDefined()
  await act(async () => target.click())
}
async function fill(placeholder, value) {
  const input = container.querySelector(`input[placeholder="${placeholder}"]`)
  expect(input).not.toBeNull()
  await act(async () => Simulate.change(input, { target: { value } }))
}

describe('Hub settings interactions (mock Host)', () => {
  it('declines an invitation through the protocol decision and refreshes the list', async () => {
    const { workgroupHub } = await mountHub()
    await click('Reject')
    expect(workgroupHub.respondToInvitation).toHaveBeenCalledWith('invite-1', 'decline')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(workgroupHub.invitations).toHaveBeenCalledTimes(2)
  })

  it('creates the workgroup Session before reopening it and starts watching the room', async () => {
    const { sessions, actions, workgroupHub } = await mountHub()
    const room = Array.from(container.querySelectorAll('button')).find(item => item.textContent.includes('Ops'))
    await act(async () => room.click())
    expect(sessions.create).toHaveBeenCalledWith({ sessionId: 'wg:room-1' })
    expect(actions.openSession).toHaveBeenCalledWith('wg:room-1')
    expect(sessions.create.mock.invocationCallOrder[0]).toBeLessThan(actions.openSession.mock.invocationCallOrder[0])
    expect(workgroupHub.watch).toHaveBeenCalledWith('room-1')
    expect(actions.closeSettings).toHaveBeenCalled()
  })

  it('shows the signed-in identity values without entering a room', async () => {
    const { actions } = await mountHub({ configured: true, signedIn: true, state: 'connected', userId: 'user-1', userHandle: 'alice', displayName: 'Alice Example', deviceId: 'device-1' })
    expect(container.textContent).toContain('user-1')
    expect(container.textContent).toContain('alice')
    expect(container.textContent).toContain('Alice Example')
    expect(container.textContent).toContain('device-1')
    expect(actions.openSession).not.toHaveBeenCalled()
  })

  it('accepts an invitation and refreshes the rooms and incoming invitations', async () => {
    const { workgroupHub } = await mountHub()
    await click('Accept')
    expect(workgroupHub.respondToInvitation).toHaveBeenCalledWith('invite-1', 'accept')
    expect(workgroupHub.rooms).toHaveBeenCalledTimes(2)
    expect(workgroupHub.invitations).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('copies the safe identity without opening a room', async () => {
    const { actions } = await mountHub()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await click('Copy my ID')
    await click('Copy my username')
    expect(writeText.mock.calls).toEqual([['user-1'], ['alice']])
    expect(actions.openSession).not.toHaveBeenCalled()
  })

  it('signs out without querying protected lists with the old identity', async () => {
    const { workgroupHub } = await mountHub()
    await click('Sign out')
    expect(workgroupHub.signOut).toHaveBeenCalledOnce()
    expect(workgroupHub.rooms).toHaveBeenCalledTimes(1)
    expect(workgroupHub.invitations).toHaveBeenCalledTimes(1)
  })

  it('allows registration without a key for Hubs using open registration', async () => {
    const { workgroupHub } = await mountHub({ configured: true, signedIn: false, state: 'signed-out' })
    await fill('Username', 'bob')
    await fill('Password', 'test-only-password')
    await fill('Display name', 'Bob')
    expect(button('Register').disabled).toBe(false)
    await click('Register')
    expect(workgroupHub.register).toHaveBeenCalledWith(expect.objectContaining({ userHandle: 'bob', displayName: 'Bob', password: 'test-only-password' }))
    expect(workgroupHub.register.mock.calls[0][0].bootstrapSecret).toBeUndefined()
  })
})
