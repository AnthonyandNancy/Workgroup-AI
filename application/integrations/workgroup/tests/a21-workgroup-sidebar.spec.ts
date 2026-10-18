// @vitest-environment jsdom
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { TextEncoder, TextDecoder, Uint8Array: new TextEncoder().encode('').constructor })
const packageRoot = resolve(process.cwd(), 'packages/bundle/ds-bot')
const botRequire = createRequire(resolve(packageRoot, 'package.json'))
const { build } = botRequire('esbuild')
const { createElement: h, act } = botRequire('react')
const { createRoot } = botRequire('react-dom/client')
let components
let root
let container

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: "export { WorkgroupTeamSidebar, WORKGROUP_SIDEBAR_CSS } from './workgroup-sidebar.js';",
      resolveDir: resolve(packageRoot, 'src/client'),
    },
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
  components = module.exports
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

async function mount(props) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(h(components.WorkgroupTeamSidebar, props)))
}

async function rerender(props) {
  await act(async () => root.render(h(components.WorkgroupTeamSidebar, props)))
}

async function click(selector) {
  const target = container.querySelector(selector)
  expect(target, selector).not.toBeNull()
  await act(async () => target.click())
}

const mainBot = { id: 'main-1', name: 'Chief', sessionId: 's-main', parts: ['s-main'], createdAt: 10 }
const helperBot = { id: 'helper-1', name: 'Helper', sessionId: 's-helper', parts: ['s-helper'], createdAt: 20 }
const localRoom = { id: 'room-local', name: 'Local room', members: ['helper-1'], preview: 'local preview', createdAt: 30 }
const agent = { id: 'agent-1', name: 'DSH Agent', sessions: ['s-agent'], createdAt: 40 }

const roster = {
  revision: 1,
  mainBotId: 'main-1',
  mainBotIds: ['main-1'],
  bots: [mainBot, helperBot],
  rooms: [localRoom],
  agents: [agent],
  exchangeTurns: {},
  questions: {},
  byId: {
    'main-1': mainBot,
    's-main': mainBot,
    'helper-1': helperBot,
    's-helper': helperBot,
  },
  roomsById: { 'room-local': localRoom },
  agentsById: { 'agent-1': agent },
  agentOf: { 's-agent': 'agent-1' },
  ready: true,
}

const sessions = {
  ids: ['s-main', 's-helper', 's-room', 's-agent'],
  byId: {
    's-main': {
      id: 's-main', updatedAt: 10, retainedBy: { mainView: 1 },
      projectionValues: { turnOutline: [{ turn: 1, response: 'main preview' }] },
    },
    's-helper': {
      id: 's-helper', updatedAt: 20, retainedBy: { mainView: 0 },
      projectionValues: { turnOutline: [{ turn: 1, response: 'helper preview' }] },
    },
    's-room': {
      id: 's-room', updatedAt: 30, retainedBy: { mainView: 0 },
      projectionValues: { turnOutline: [{ turn: 1, response: 'local room reply' }] },
    },
    's-agent': { id: 's-agent', title: 'Agent work', updatedAt: 50, retainedBy: { mainView: 0 } },
  },
}

const sessionStatus = new Map([
  ['s-main', { running: false }],
  ['s-helper', { running: false }],
  ['s-room', {}],
  ['s-agent', {}],
])

const work = { approvals: [], rooms: {} }
const ui = { unread: {}, renameAgent: null }
const update = { phase: 'idle' }

function workgroup(overrides = {}) {
  return {
    id: 'wg-1',
    kind: 'workgroup',
    name: 'Ops',
    memberCount: 3,
    botCount: 2,
    lastMessageAt: '2026-05-01T12:00:00.000Z',
    lastMessagePreview: 'deploy finished',
    lastMessageSeq: 4,
    pendingApprovalCount: 2,
    ownerUserId: 'u1',
    myRole: 'member',
    pinned: false,
    hidden: false,
    unread: 4,
    lastActivityAt: '2026-05-01T12:00:00.000Z',
    ...overrides,
  }
}

function snapshot(overrides = {}) {
  return { phase: 'ready', rooms: [], invitations: [], botInvitations: [], error: undefined, ...overrides }
}

function actions(overrides = {}) {
  return {
    openSession: vi.fn(),
    openAgent: vi.fn(),
    openAgentSession: vi.fn(),
    newAgentSession: vi.fn(async () => 's-new'),
    renameAgentSession: vi.fn(async () => {}),
    endAgentRename: vi.fn(),
    openMenu: vi.fn(),
    reportError: vi.fn(),
    openPalette: vi.fn(),
    openNewChat: vi.fn(),
    landOn: vi.fn(),
    clearUnread: vi.fn(),
    installUpdate: vi.fn(async () => {}),
    installDshUpdate: vi.fn(async () => {}),
    openAppUpdates: vi.fn(async () => {}),
    openWorkgroup: vi.fn(),
    openWorkgroupCreate: vi.fn(),
    answerWorkgroupInvitation: vi.fn(async () => ({})),
    answerWorkgroupBotInvitation: vi.fn(async () => ({})),
    setWorkgroupFlag: vi.fn(),
    ...overrides,
  }
}

function props({ wide = true, workgroupRoster = snapshot(), hub = { configured: true, signedIn: true, state: 'open' }, actionSet = actions(), localRoster = roster } = {}) {
  return {
    wide,
    useRoster: selector => selector(localRoster),
    useUi: selector => selector(ui),
    useSessions: selector => selector(sessions),
    useSessionStatus: selector => selector(sessionStatus),
    useSessionRetainInfo: (id, selector) => selector({ retainedBy: { mainView: id === 's-main' ? 1 : 0 } }),
    useActivity: selector => selector({}),
    useWork: selector => selector(work),
    useRegistry: selector => selector({}),
    useUpdate: selector => selector(update),
    useWorkgroups: selector => selector({ available: true }),
    useWorkgroupRoster: selector => selector(workgroupRoster),
    useHub: selector => selector(hub),
    actions: actionSet,
  }
}

describe('the copied workgroup sidebar', () => {
  it('keeps the local Main Bot, other Bots, local rooms, and Agents', async () => {
    await mount(props())
    expect(container.querySelector('[data-bot-id="main-1"]')).not.toBeNull()
    expect(container.querySelector('[data-bot-id="helper-1"]')).not.toBeNull()
    expect(container.querySelector('[data-room-id="room-local"]')).not.toBeNull()
    expect(container.querySelector('[data-agent-id="agent-1"]')).not.toBeNull()
    expect(container.textContent).toContain('Chief')
    expect(container.textContent).toContain('Helper')
    expect(container.textContent).toContain('Local room')
    expect(container.textContent).toContain('DSH Agent')
  })

  it('renders a workgroup row with its counts, unread, approvals, and Hub state', async () => {
    await mount(props({ workgroupRoster: snapshot({ rooms: [workgroup()] }) }))
    const row = container.querySelector('[data-workgroup-id="wg-1"]')
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('Ops')
    expect(row.textContent).toContain('3 members')
    expect(row.textContent).toContain('2 Bots')
    expect(row.textContent).toContain('deploy finished')
    expect(row.textContent).toContain('Workgroup')
    expect(row.textContent).toContain('Hub online')
    expect(row.getAttribute('data-wg-unread')).toBe('4')
    expect(row.getAttribute('data-wg-approvals')).toBe('2')
    expect(row.querySelector('[data-hub="live"]')).not.toBeNull()
    expect(container.querySelector('.bt-wg-row-unread').textContent).toBe('4')
    expect(container.querySelector('.bt-wg-row-approval').textContent).toBe('2')
  })

  it('marks a reconnecting Hub separately from an offline one', async () => {
    await mount(props({
      workgroupRoster: snapshot({ rooms: [workgroup()] }),
      hub: { configured: true, signedIn: true, state: 'reconnecting' },
    }))
    const row = container.querySelector('[data-workgroup-id="wg-1"]')
    expect(row.getAttribute('data-wg-hub')).toBe('reconnecting')
    expect(row.textContent).toContain('Hub reconnecting')
    expect(row.querySelector('[data-hub="reconnecting"]')).not.toBeNull()
  })

  it('falls back to the creation time when a workgroup has no messages', async () => {
    await mount(props({
      workgroupRoster: snapshot({
        rooms: [workgroup({ lastMessagePreview: '', lastMessageAt: null, createdAt: '2026-05-01T12:00:00.000Z' })],
      }),
    }))
    const preview = container.querySelector('[data-workgroup-id="wg-1"] .bt-row-preview')
    expect(preview).not.toBeNull()
    expect(preview.textContent.trim()).not.toBe('')
  })

  it('opens a workgroup through the owner action', async () => {
    const actionSet = actions()
    await mount(props({ workgroupRoster: snapshot({ rooms: [workgroup()] }), actionSet }))
    await click('[data-workgroup-id="wg-1"]')
    expect(actionSet.openWorkgroup).toHaveBeenCalledWith('wg-1')
    expect(actionSet.openSession).not.toHaveBeenCalled()
  })

  it('drops a hidden workgroup from the list', async () => {
    await mount(props({ workgroupRoster: snapshot({ rooms: [workgroup({ hidden: true })] }) }))
    expect(container.querySelector('[data-workgroup-id="wg-1"]')).toBeNull()
  })

  it('sorts a pinned workgroup above a more recently active local row', async () => {
    await mount(props({
      workgroupRoster: snapshot({ rooms: [workgroup({ pinned: true, lastActivityAt: '2026-01-01T00:00:00.000Z' })] }),
    }))
    const rows = [...container.querySelectorAll('[data-bot-id],[data-room-id],[data-agent-id],[data-workgroup-id]')]
    // The Main Bot tile always leads; the pinned workgroup follows before the local rows.
    expect(rows[0].getAttribute('data-bot-id')).toBe('main-1')
    expect(rows[1].getAttribute('data-workgroup-id')).toBe('wg-1')
  })

  it('offers pin and hide for a workgroup through the local flag action', async () => {
    const actionSet = actions()
    await mount(props({ actionSet, workgroupRoster: snapshot({ rooms: [workgroup()] }) }))
    const row = container.querySelector('[data-workgroup-id="wg-1"]')
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 20 }))
    })
    const menu = document.querySelector('[data-workgroup-menu="wg-1"]')
    expect(menu).not.toBeNull()
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(items.map(item => item.textContent)).toEqual(['Pin to top', 'Hide from list'])
    await act(async () => items[0].click())
    expect(actionSet.setWorkgroupFlag).toHaveBeenCalledWith('wg-1', { pinned: true })

    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 20 }))
    })
    const hide = document.querySelector('[data-workgroup-menu="wg-1"] [role="menuitem"]:last-child')
    await act(async () => hide.click())
    expect(actionSet.setWorkgroupFlag).toHaveBeenCalledWith('wg-1', { hidden: true })
  })

  it('renders human and Bot invitations and calls the matching answer actions', async () => {
    const actionSet = actions()
    await mount(props({
      actionSet,
      workgroupRoster: snapshot({
        invitations: [{ id: 'i1', roomId: 'wg-1', roomName: 'Ops', inviterDisplayName: 'Alice', role: 'admin' }],
        botInvitations: [{ id: 'b1', roomId: 'wg-2', roomName: 'Design', botDisplayName: 'Writer', ownerUserId: 'u2', invitedByUserId: 'u1' }],
      }),
    }))
    const human = container.querySelector('[data-wg-invitation="human"]')
    const bot = container.querySelector('[data-wg-invitation="bot"]')
    expect(human.textContent).toContain('Ops')
    expect(human.textContent).toContain('Alice')
    expect(human.textContent).toContain('Admin')
    expect(bot.textContent).toContain('Design')
    expect(bot.textContent).toContain('Writer')
    expect(bot.textContent).toContain('Bot')

    await click('[data-wg-invitation="human"] [data-wg-answer="accept"]')
    expect(actionSet.answerWorkgroupInvitation).toHaveBeenCalledWith('i1', 'accept')
    expect(actionSet.answerWorkgroupBotInvitation).not.toHaveBeenCalled()

    await click('[data-wg-invitation="bot"] [data-wg-answer="decline"]')
    expect(actionSet.answerWorkgroupBotInvitation).toHaveBeenCalledWith('b1', 'decline')
  })

  it('disables an invitation while answering and shows a failure', async () => {
    let settle
    const actionSet = actions({
      answerWorkgroupInvitation: vi.fn(() => new Promise((resolve) => { settle = resolve })),
    })
    const invitation = { id: 'i1', roomId: 'wg-1', roomName: 'Ops', inviterDisplayName: 'Alice', role: 'member' }
    await mount(props({ actionSet, workgroupRoster: snapshot({ invitations: [invitation] }) }))
    await click('[data-wg-invitation="human"] [data-wg-answer="accept"]')
    const accept = container.querySelector('[data-wg-invitation="human"] [data-wg-answer="accept"]')
    expect(accept.disabled).toBe(true)
    expect(accept.textContent).toBe('Accepting…')
    await act(async () => settle({}))
    expect(container.querySelector('[data-wg-invitation="human"] [data-wg-answer="accept"]').disabled).toBe(false)

    const failing = actions({ answerWorkgroupInvitation: vi.fn(async () => { throw new Error('invitation expired') }) })
    await rerender(props({ actionSet: failing, workgroupRoster: snapshot({ invitations: [invitation] }) }))
    await click('[data-wg-invitation="human"] [data-wg-answer="decline"]')
    const error = container.querySelector('[data-wg-invite-error="human:i1"]')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('invitation expired')
  })

  it('enables the create entry only with a live Hub and calls the owner action', async () => {
    const actionSet = actions()
    await mount(props({ hub: { configured: false, signedIn: false, state: 'closed' }, actionSet }))
    const disabled = container.querySelector('[data-wg-create="blocked"]')
    expect(disabled).not.toBeNull()
    expect(disabled.disabled).toBe(true)
    expect(container.querySelector('[data-wg-create-hint="absent"]').textContent).toContain('Hub is not configured')
    expect(actionSet.openWorkgroupCreate).not.toHaveBeenCalled()

    await rerender(props({ hub: { configured: true, signedIn: true, state: 'open' }, actionSet }))
    const enabled = container.querySelector('[data-wg-create="ready"]')
    expect(enabled).not.toBeNull()
    expect(enabled.disabled).toBe(false)
    await click('[data-wg-create="ready"]')
    expect(actionSet.openWorkgroupCreate).toHaveBeenCalledTimes(1)
  })

  it('renders the wide and rail layouts', async () => {
    const actionSet = actions()
    await mount(props({ wide: true, actionSet, workgroupRoster: snapshot({ rooms: [workgroup()] }) }))
    expect(container.querySelector('.bt-side')).not.toBeNull()
    expect(container.querySelector('.bt-side.bt-rail')).toBeNull()
    expect(container.querySelector('[data-workgroup-id="wg-1"]')).not.toBeNull()

    await rerender(props({ wide: false, actionSet, workgroupRoster: snapshot({ rooms: [workgroup()] }) }))
    expect(container.querySelector('.bt-side.bt-rail')).not.toBeNull()
    expect(container.querySelector('[data-workgroup-id="wg-1"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-invites]')).toBeNull()
  })

  it('summarizes invitations as a rail badge instead of overflowing the icon column', async () => {
    await mount(props({
      wide: false,
      workgroupRoster: snapshot({
        invitations: [{ id: 'i1', roomId: 'wg-1', roomName: 'Ops', inviterDisplayName: 'Alice', role: 'member' }],
      }),
    }))
    const badge = container.querySelector('[data-wg-invites="1"]')
    expect(badge).not.toBeNull()
    expect(badge.getAttribute('aria-label')).toBe('1 invitations')
    expect(container.querySelector('.bt-wg-invite-badge').textContent).toBe('1')
  })

  it('keeps the added styles on the shared tokens and respects reduced motion', () => {
    expect(components.WORKGROUP_SIDEBAR_CSS).toContain('var(--bt-')
    expect(components.WORKGROUP_SIDEBAR_CSS).toContain('@media (prefers-reduced-motion:reduce)')
    expect(components.WORKGROUP_SIDEBAR_CSS).toContain('.bt-wg-row')
  })
})
