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
const { Simulate } = botRequire('react-dom/test-utils')
let components
let root
let container

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { WorkgroupConversation } from './workgroup-ui/index.js'",
        "export { WorkgroupCreate } from './workgroup-ui/create.js'",
        "export { WorkgroupSettingsForm } from './workgroup-ui/settings.js'",
        "export { WorkgroupDetails } from './workgroup-ui/details.js'",
        "export { mergeTimeline } from './workgroup-ui/thread.js'",
      ].join(';'),
      resolveDir: resolve(packageRoot, 'src/client'),
    },
    bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'],
    plugins: [{ name: 'shell-primitives', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'test-shell' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-shell' }, () => ({ contents: "import { createElement as h } from 'react'; export const FishLogo = () => null; export const MarkdownText = ({ text }) => h('span', { 'data-test-markdown': 'true' }, text);" }))
    } }],
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

async function mount(name, props) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(h(components[name], props)))
}
async function click(selector) {
  const target = container.querySelector(selector)
  expect(target, selector).not.toBeNull()
  await act(async () => target.click())
}
async function fill(selector, value) {
  const target = container.querySelector(selector)
  expect(target, selector).not.toBeNull()
  await act(async () => Simulate.change(target, { target: { value } }))
}
async function blur(selector) {
  const target = container.querySelector(selector)
  expect(target, selector).not.toBeNull()
  await act(async () => Simulate.blur(target))
}

const members = [
  { userId: 'u1', displayName: 'Alice', role: 'owner', online: true },
  { userId: 'u2', displayName: 'Bob', role: 'member', online: false },
]
const bots = [{ ownerUserId: 'u2', botId: 'b1', displayName: 'Helper', ownerDisplayName: 'Bob' }]
const room = { id: 'room-1', name: 'Ops', kind: 'workgroup', ownerUserId: 'u1', notice: 'Read the notes first' }
const messages = [
  { id: 'm1', roomSeq: 1, senderUserId: 'u2', senderDisplayName: 'Bob', body: 'hello', createdAt: '2026-01-01T10:00:00.000Z' },
  { id: 'm2', roomSeq: 2, senderUserId: 'u1', senderDisplayName: 'Alice', body: 'hi', createdAt: '2026-01-01T10:01:00.000Z' },
]
const base = { room, members, bots, messages, tasks: [], selfUserId: 'u1' }

describe('the copied workgroup conversation', () => {
  it('orders messages by sequence and activity by time in one timeline', () => {
    const timeline = components.mergeTimeline(
      [{ id: 'm2', roomSeq: 2, createdAt: '2026-01-01T10:05:00.000Z' }, { id: 'm1', roomSeq: 1, createdAt: '2026-01-01T10:00:00.000Z' }],
      [{ id: 't1', createdAt: '2026-01-01T10:02:00.000Z' }],
    )
    expect(timeline.map(entry => entry.id)).toEqual(['m1', 'task:t1', 'm2'])
  })

  it('draws a colleague’s message with their name and the viewer’s own as their own bubble', async () => {
    await mount('WorkgroupConversation', base)
    const lines = container.querySelectorAll('[data-wg-message]')
    expect(lines).toHaveLength(2)
    expect(container.textContent).toContain('Bob')
    expect(container.querySelector('.bt-umsg [data-wg-message="m2"]') ?? container.querySelector('.bt-umsg')).not.toBeNull()
    expect(container.querySelector('[data-wg-message="m1"]').className).toBe('bt-group-msg')
    expect(container.querySelector('[data-wg-message="m1"] .bt-lead')).not.toBeNull()
    expect(container.querySelector('[data-wg-message="m1"] .bt-bubble [data-test-markdown="true"]')).not.toBeNull()
  })

  it('draws a Bot’s line on the left as itself, even when its owner is the reader', async () => {
    // The Hub records the Bot's owner as the accountable sender, so a renderer that only compares
    // ids would put the Bot's words in the reader's own bubble on the right.
    await mount('WorkgroupConversation', {
      ...base,
      messages: [{
        id: 'bot-1',
        roomSeq: 3,
        senderUserId: 'u1',
        senderBotId: 'b1',
        senderBotDisplayName: 'Helper',
        body: '任务完成',
        createdAt: '2026-01-01T10:02:00.000Z',
      }],
    })
    const line = container.querySelector('[data-wg-message="bot-1"]')
    expect(line.className).toBe('bt-group-msg')
    expect(container.querySelector('.bt-umsg')).toBeNull()
    expect(container.textContent).toContain('Helper')
  })

  it('renders a group avatar for the header and details instead of a single default mark', async () => {
    await mount('WorkgroupConversation', base)
    expect(container.querySelector('.bt-head .bt-cluster')).not.toBeNull()
    await click('[data-wg-details]')
    expect(container.querySelector('.bt-pile')).not.toBeNull()
  })

  it('marks an undelivered message instead of showing it as sent', async () => {
    await mount('WorkgroupConversation', { ...base, messages: [{ ...messages[1], failed: true }] })
    expect(container.querySelector('.bt-wg-message-failed').textContent).toBe('Not delivered')
  })

  it('quotes a message into the composer and sends the reply target', async () => {
    const onSend = vi.fn(async () => true)
    await mount('WorkgroupConversation', { ...base, onSend })
    await click('[data-wg-reply="m1"]')
    expect(container.querySelector('[data-wg-replying="m1"]')).not.toBeNull()
    await fill('[data-wg-input="message"]', 'answer')
    await click('[data-wg-send="submit"]')
    expect(onSend).toHaveBeenCalledWith('answer', expect.objectContaining({ id: 'm1' }), expect.any(Object))
  })

  it('keeps the draft and says so when the Hub does not accept a message', async () => {
    const onSend = vi.fn(async () => false)
    await mount('WorkgroupConversation', { ...base, onSend })
    await fill('[data-wg-input="message"]', 'still here')
    await click('[data-wg-send="submit"]')
    expect(container.querySelector('[data-wg-input="message"]').value).toBe('still here')
    expect(container.querySelector('[data-wg-draft="undelivered"]')).not.toBeNull()
  })

  it('records a picked mention by id and keeps the typed name for reading', async () => {
    const onSend = vi.fn(async () => true)
    await mount('WorkgroupConversation', { ...base, onSend })
    await fill('[data-wg-input="message"]', '@Bo')
    expect(container.querySelector('[data-wg-mentions="open"]')).not.toBeNull()
    await click('[data-wg-mention="u2"]')
    await click('[data-wg-send="submit"]')
    const extra = onSend.mock.calls[0][2]
    expect(extra.mentions).toEqual([{ userId: 'u2' }])
    expect(onSend.mock.calls[0][0]).toContain('@Bob')
  })

  it('offers the original + menu, refuses private references, and schedules a normal message', async () => {
    const onSend = vi.fn(async () => true)
    const onSchedule = vi.fn(async ({ text, at }) => ({ schedule: { id: 's1', text, at }, schedules: [{ id: 's1', text, at }] }))
    await mount('WorkgroupConversation', { ...base, onSend, onSchedule })
    await click('.bt-plus')
    expect(document.body.querySelector('[data-wg-plus="file"]')).not.toBeNull()
    expect(document.body.querySelector('[data-wg-plus="reference"]').disabled).toBe(true)
    await act(async () => document.body.querySelector('[data-wg-plus="schedule"]').click())
    await fill('[aria-label="Scheduled message"]', 'later')
    await fill('[aria-label="Delay in minutes"]', '1')
    await click('[data-wg-schedule-add="true"]')
    await vi.waitFor(() => expect(container.querySelector('[data-wg-scheduled="1"]')).not.toBeNull())
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1', text: 'later' }))
  })

  it('shows an image attachment when its authorized bytes arrive', async () => {
    const onImage = vi.fn(async () => 'blob:image-1')
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: vi.fn() })
    await mount('WorkgroupConversation', {
      ...base,
      messages: [{ id: 'm3', roomSeq: 3, senderUserId: 'u2', senderDisplayName: 'Bob', body: '', attachments: [{ artifactId: 'a1', fileName: 'shot.png' }] }],
      onImage,
    })
    await vi.waitFor(() => expect(container.querySelector('img.bt-uattach-img')).not.toBeNull())
    expect(container.querySelector('img.bt-uattach-img').getAttribute('src')).toBe('blob:image-1')
  })

  it('shows activity cards with their progress history and owner-only decisions', async () => {
    const task = { id: 'task-1', state: 'PENDING_APPROVAL', version: 2, ownerUserId: 'u1', requesterUserId: 'u2', description: 'Read the notes', createdAt: '2026-01-01T10:02:00.000Z' }
    const events = [{ id: 'e1', taskId: 'task-1', eventType: 'task.created', createdAt: '2026-01-01T10:02:00.000Z' }]
    await mount('WorkgroupConversation', { ...base, tasks: [task], events, onDecision: vi.fn() })
    expect(container.querySelector('[data-wg-task-events="task-1"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-approve="task-1"]')).not.toBeNull()
    await act(async () => root.render(h(components.WorkgroupConversation, { ...base, tasks: [task], events, selfUserId: 'u2' })))
    expect(container.querySelector('[data-wg-approve="task-1"]')).toBeNull()
  })

  it('opens the original details drawer and switches to settings inside it', async () => {
    const onRoomAction = vi.fn(async () => ({}))
    await mount('WorkgroupConversation', { ...base, onRoomAction })
    expect(container.querySelector('.bt-wg-panel')).toBeNull()
    await click('[data-wg-details]')
    for (const selector of ['.bt-panel.bt-wg-panel', '.bt-panel-grip', '.bt-panel-view', '.bt-drawer-top', '.bt-drawer-id', '.bt-drawer-body']) {
      expect(container.querySelector(selector), selector).not.toBeNull()
    }
    const panel = container.querySelector('.bt-panel.bt-wg-panel')
    expect(panel.style.getPropertyValue('--bt-panel-w')).toBe('320px')
    expect(container.querySelector('.bt-wg-surface').style.marginRight).toBe('320px')
    await click('[data-wg-settings="open"]')
    expect(container.querySelector('.bt-subhead')).not.toBeNull()
    expect(container.querySelector('.bt-drawer-body.bt-set-body')).not.toBeNull()
    expect(container.querySelector('.bt-wg-thread'), 'the conversation stays mounted').not.toBeNull()
    await click('[data-wg-settings-back]')
    expect(container.querySelector('.bt-drawer-id')).not.toBeNull()
    await click('[data-wg-details-close]')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    expect(container.querySelector('.bt-wg-panel')).toBeNull()
    expect(container.querySelector('.bt-wg-surface').style.marginRight).toBe('0px')
  })

  it('renames the group from the details drawer', async () => {
    const onRoomAction = vi.fn(async () => ({}))
    await mount('WorkgroupConversation', { ...base, onRoomAction })
    await click('[data-wg-details]')
    await click('.bt-drawer-name')
    const input = container.querySelector('.bt-drawer-name-input')
    expect(input).not.toBeNull()
    await act(async () => Simulate.change(input, { target: { value: 'Renamed' } }))
    await act(async () => Simulate.blur(input))
    expect(onRoomAction).toHaveBeenCalledWith('renameRoom', { name: 'Renamed' })
  })

  it('copies the conversation from the details header', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }))
    await mount('WorkgroupConversation', base)
    await click('[data-wg-details]')
    await click('[data-wg-share="true"]')
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('**Bob:** hello')
    expect(text).toContain('**Alice:** hi')
    expect(container.querySelector('[data-wg-share="true"]').getAttribute('aria-label')).toBe('Copied conversation')
  })
})

describe('the copied workgroup settings', () => {
  const onAction = vi.fn(async (operation) => (operation === 'invite' ? { id: 'invite-1' } : {}))

  it('saves the name and the notice through the Hub adapter', async () => {
    await mount('WorkgroupSettingsForm', { room, members, bots, selfUserId: 'u1', onAction, onClose: vi.fn() })
    await fill('[aria-label="Group name"]', 'New name')
    await blur('[aria-label="Group name"]')
    expect(onAction).toHaveBeenCalledWith('renameRoom', { name: 'New name' })
    await fill('[aria-label="Notice"]', 'New notice')
    await blur('[aria-label="Notice"]')
    expect(onAction).toHaveBeenCalledWith('updateNotice', { notice: 'New notice' })
  })

  it('adds the owner’s own Bot directly and only asks for a colleague’s', async () => {
    const loadBotCandidates = vi.fn(async () => [
      { ownerUserId: 'u1', botId: 'mine', displayName: 'Mine', mine: true, inRoom: false },
      { ownerUserId: 'u2', botId: 'theirs', displayName: 'Theirs', ownerDisplayName: 'Bob', mine: false, inRoom: false, visibility: 'room' },
    ])
    await mount('WorkgroupSettingsForm', { room, members, bots, selfUserId: 'u1', onAction, onClose: vi.fn(), loadBotCandidates })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-add-row="bot"]')).not.toBeNull())
    await click('[data-wg-add-row="bot"]')
    await act(async () => {
      Simulate.change(container.querySelector('[aria-label="Add a Bot"]'), { target: { value: 'mine' } })
    })
    await click('[data-wg-action="add-bot"]')
    expect(onAction).toHaveBeenCalledWith('addBot', { botId: 'mine' })
    await click('[data-wg-add-row="other-bot"]')
    await act(async () => {
      Simulate.change(container.querySelector('[aria-label="Invite another member\'s Bot"]'), { target: { value: 'u2:theirs' } })
    })
    await click('[data-wg-action="invite-bot"]')
    expect(onAction).toHaveBeenCalledWith('inviteBot', { ownerUserId: 'u2', botId: 'theirs' })
  })

  it('lets the owner share their own Bot with members and never a colleague’s', async () => {
    const ownBot = { ownerUserId: 'u1', botId: 'mine', displayName: 'Mine', ownerDisplayName: 'Alice' }
    const loadBotCandidates = vi.fn(async () => [
      { ownerUserId: 'u1', botId: 'mine', displayName: 'Mine', mine: true, inRoom: true, visibility: 'private' },
    ])
    await mount('WorkgroupSettingsForm', {
      room, members, bots: [ownBot], selfUserId: 'u1', onAction, onClose: vi.fn(), loadBotCandidates,
    })
    const toggle = container.querySelector('[data-wg-bot-visibility="mine"]')
    expect(toggle, 'the owner sees the sharing switch').not.toBeNull()
    expect(container.querySelector('[data-wg-bot-visibility="b1"]'), 'a colleague’s Bot has no switch').toBeNull()
    await act(async () => toggle.click())
    expect(onAction).toHaveBeenCalledWith('setBotVisibility', { botId: 'mine', visibility: 'room' })
  })

  it('writes pin and hide through the device-local preference callback', async () => {
    const onFlag = vi.fn()
    await mount('WorkgroupSettingsForm', { room, members, bots, selfUserId: 'u1', onAction, onClose: vi.fn(), onFlag, prefs: {} })
    await act(async () => container.querySelector('[role="switch"]').click())
    expect(onFlag).toHaveBeenCalledWith({ pinned: true })
  })

  it('offers dissolve to the owner and leave to a member', async () => {
    await mount('WorkgroupSettingsForm', { room, members, bots, selfUserId: 'u1', onAction, onClose: vi.fn(), onDissolve: vi.fn() })
    expect(container.querySelector('[data-group-action="dissolve"]')).not.toBeNull()
    await act(async () => root.render(h(components.WorkgroupSettingsForm, { room, members, bots, selfUserId: 'u2', onAction, onClose: vi.fn(), onDissolve: vi.fn() })))
    expect(container.querySelector('[data-group-action="dissolve"]')).toBeNull()
    expect(container.querySelector('[data-wg-action="leave"]')).not.toBeNull()
  })
})

describe('the copied workgroup details', () => {
  it('lists people, Bots, the notice, and the group memory', async () => {
    const memory = {
      list: vi.fn(async () => [{ id: 'mem-1', body: 'Use the shared folder', authorUserId: 'u2', revision: 1, scope: 'room', updatedAt: '2026-01-01T10:00:00.000Z' }]),
      search: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      revise: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    }
    await mount('WorkgroupDetails', { room, members, bots, tasks: [], selfUserId: 'u1', memory })
    expect(container.textContent).toContain('Read the notes first')
    expect(container.querySelector('[data-wg-member="u2"]').getAttribute('data-wg-presence')).toBe('offline')
    await vi.waitFor(() => expect(container.querySelector('[data-wg-memory-entry="mem-1"]')).not.toBeNull())
    await fill('[aria-label="New group memory"]', 'Another fact')
    await click('[data-wg-memory-add="true"]')
    expect(memory.create).toHaveBeenCalledWith({ body: 'Another fact', scope: 'room' })
    await click('[data-wg-memory-remove="mem-1"]')
    expect(memory.remove).toHaveBeenCalledWith('mem-1')
  })

  it('states that memory is unavailable instead of showing an empty list', async () => {
    await mount('WorkgroupDetails', { room, members, bots, tasks: [], selfUserId: 'u1' })
    expect(container.querySelector('[data-wg-memory="unavailable"]')).not.toBeNull()
  })

  it('shows how answers and permissions work and reports task usage', async () => {
    const task = { id: 'task-1', state: 'SHARED', description: 'Read the notes', updatedAt: '2026-01-01T10:00:00.000Z' }
    await mount('WorkgroupDetails', { room, members, bots, tasks: [task], selfUserId: 'u1' })
    expect(container.querySelector('[data-wg-who-answers="true"]').textContent).toContain('No automatic answers')
    expect(container.querySelector('[data-wg-permissions="true"]').textContent).toContain('folder, tools, and lifetime')
    expect(container.textContent).toContain('Usage')
    expect(container.textContent).toContain('1 tasks')
  })

  it('stops a Bot by cancelling its active task', async () => {
    const task = { id: 'task-stop', state: 'APPROVED', ownerUserId: 'u2', targetBotId: 'b1', description: 'Work' }
    const onCancel = vi.fn()
    await mount('WorkgroupDetails', { room, members, bots, tasks: [task], selfUserId: 'u1', onCancel })
    await click('[data-wg-stop-bot="b1"]')
    expect(onCancel).toHaveBeenCalledWith(task)
  })
})

describe('the copied workgroup creation form', () => {
  function workgroups(overrides = {}) {
    return {
      available: true,
      identity: { userId: 'u1' },
      directory: vi.fn(async () => [
        { botId: 'chief', displayName: 'Chief', ownerUserId: 'u1', isChief: true },
        { botId: 'mine', displayName: 'Mine', ownerUserId: 'u1', isChief: false },
        { botId: 'other', displayName: 'Other', ownerUserId: 'u1', isChief: false },
      ]),
      createRoom: vi.fn(async () => ({ id: 'room-9', name: 'New' })),
      addBot: vi.fn(async () => ({})),
      invite: vi.fn(async () => ({ id: 'inv-1' })),
      ...overrides,
    }
  }

  it('renders the original new-chat skeleton and closes with Escape', async () => {
    const onCancel = vi.fn()
    await mount('WorkgroupCreate', { workgroups: workgroups(), onCreated: vi.fn(), onCancel })
    const pane = container.querySelector('.bt-pane')
    expect(pane, 'the creation surface uses the original pane').not.toBeNull()
    expect(pane.style.left).toBe('280px')
    for (const selector of ['.bt-newchat', '.bt-to', '.bt-drop', '.bt-nc-compose', '.bt-nc-card', '.bt-x', '.bt-send.bt-to-create']) {
      expect(container.querySelector(selector), selector).not.toBeNull()
    }
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('picks a Bot with the same arrow/Enter movement as the original list', async () => {
    await mount('WorkgroupCreate', { workgroups: workgroups(), onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    const input = container.querySelector('[aria-label="Add your Bot"]')
    expect(input).not.toBeNull()
    // The first entry is highlighted without any key, so the ArrowDown is what proves the movement:
    // Enter then takes the second entry.
    await act(async () => Simulate.keyDown(input, { key: 'ArrowDown' }))
    await act(async () => Simulate.keyDown(input, { key: 'Enter' }))
    expect(container.querySelectorAll('.bt-to .bt-token')).toHaveLength(1)
    expect(container.querySelector('.bt-to .bt-token').textContent).toContain('Mine')
  })

  it('does not create from a single Bot, and says the workgroup needs two', async () => {
    const hub = workgroups()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    await click('[data-wg-create-bot="chief"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    expect(container.querySelector('[data-wg-create-blocked="second-bot"]')).not.toBeNull()
    expect(hub.createRoom).not.toHaveBeenCalled()
  })

  it('creates with two Bots, one of them a Main Bot, and names the workgroup after its members', async () => {
    const hub = workgroups()
    const onCreated = vi.fn()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated, onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    // The Main Bot's standing is visible before the click, not only after a refusal.
    expect(container.querySelector('[data-wg-create-chief="chief"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    await click('[data-wg-create-bot="chief"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    await click('[data-wg-create-bot="mine"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(false)
    await click('[data-wg-create-submit="true"]')
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'room-9', name: 'New' }))
    // The Hub generates the leader from botIds; the form deliberately names nobody.
    expect(hub.createRoom).toHaveBeenCalledWith('You, Chief, Mine', { kind: 'workgroup', botIds: ['chief', 'mine'] })
    expect(hub.addBot).not.toHaveBeenCalled()
  })

  it('does not create without a Main Bot, and says one is needed to lead', async () => {
    const hub = workgroups({
      directory: vi.fn(async () => [
        { botId: 'mine', displayName: 'Mine', ownerUserId: 'u1', isChief: false },
        { botId: 'other', displayName: 'Other', ownerUserId: 'u1', isChief: false },
      ]),
    })
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="mine"]')).not.toBeNull())
    await click('[data-wg-create-bot="mine"]')
    await click('[data-wg-create-bot="other"]')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    expect(container.querySelector('[data-wg-create-blocked="leader"]')).not.toBeNull()
    expect(hub.createRoom).not.toHaveBeenCalled()
  })

  it('creates with a Bot and an invite when the name is left empty', async () => {
    const hub = workgroups()
    const onCreated = vi.fn()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated, onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    await click('[data-wg-create-bot="chief"]')
    await click('[data-wg-create-bot="mine"]')
    await fill('[aria-label="User ID to invite"]', 'u3')
    await click('[data-wg-create-invite="add"]')
    await click('[data-wg-create-submit="true"]')
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'room-9', name: 'New' }))
    expect(hub.createRoom).toHaveBeenCalledWith('You, Chief, Mine', { kind: 'workgroup', botIds: ['chief', 'mine'] })
    expect(hub.invite).toHaveBeenCalledWith('room-9', { targetUserId: 'u3', role: 'member' })
  })

  it('does not create from a name alone', async () => {
    const hub = workgroups()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="mine"]')).not.toBeNull())
    await fill('[aria-label="Workgroup name"]', 'Launch')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
    expect(hub.createRoom).not.toHaveBeenCalled()
  })

  it('uses the typed name when one is provided', async () => {
    const hub = workgroups()
    const onCreated = vi.fn()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated, onCancel: vi.fn() })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    await fill('[aria-label="Workgroup name"]', 'Launch')
    await click('[data-wg-create-bot="chief"]')
    await click('[data-wg-create-bot="mine"]')
    await click('[data-wg-create-submit="true"]')
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'room-9', name: 'New' }))
    expect(hub.createRoom).toHaveBeenCalledWith('Launch', { kind: 'workgroup', botIds: ['chief', 'mine'] })
  })

  it('opens the created room even when an invitation fails, and reports that failure once', async () => {
    const hub = workgroups({ invite: vi.fn(async () => { throw new Error('invite failed') }) })
    const onCreated = vi.fn()
    const report = vi.fn()
    await mount('WorkgroupCreate', { workgroups: hub, onCreated, onCancel: vi.fn(), report })
    await vi.waitFor(() => expect(container.querySelector('[data-wg-create-bot="chief"]')).not.toBeNull())
    await click('[data-wg-create-bot="chief"]')
    await click('[data-wg-create-bot="mine"]')
    await fill('[aria-label="User ID to invite"]', 'u3')
    await click('[data-wg-create-invite="add"]')
    await click('[data-wg-create-submit="true"]')
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'room-9', name: 'New' }))
    expect(hub.createRoom).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0].message).toContain('invite failed')
  })

  it.each([
    ['signed out', { phase: 'ready', configured: true, signedIn: false, state: 'closed' }, 'Configured, signed out'],
    ['reconnecting', { phase: 'ready', configured: true, signedIn: true, state: 'reconnecting' }, 'Hub is reconnecting'],
    ['refused', { phase: 'ready', configured: true, signedIn: true, state: 'fatal' }, 'Hub refused this device'],
  ])('blocks creation when the Hub is %s and says why', async (_label, view, copy) => {
    await mount('WorkgroupCreate', { workgroups: workgroups(), hub: view, onCreated: vi.fn(), onCancel: vi.fn() })
    expect(container.querySelector('[data-wg-create-unavailable="true"]').textContent).toContain(copy)
    await fill('[aria-label="Workgroup name"]', 'Launch')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
  })

  it('refuses to create without a Hub and says why', async () => {
    const hub = workgroups({ available: false })
    await mount('WorkgroupCreate', { workgroups: hub, onCreated: vi.fn(), onCancel: vi.fn() })
    expect(container.querySelector('[data-wg-create-unavailable="true"]')).not.toBeNull()
    await fill('[aria-label="Workgroup name"]', 'Launch')
    expect(container.querySelector('[data-wg-create-submit="true"]').disabled).toBe(true)
  })
})
