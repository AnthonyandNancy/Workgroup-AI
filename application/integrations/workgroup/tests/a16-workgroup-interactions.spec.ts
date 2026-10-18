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
    stdin: { contents: "export { WorkgroupView, WorkgroupTasks, WorkgroupThread } from './workgroup.js'; export { WorkgroupPane, WorkgroupSurface } from './workgroup-pane.js';", resolveDir: resolve(packageRoot, 'src/client') },
    bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react', 'react-dom'],
    plugins: [{ name: 'shell-primitives', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'test-shell' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-shell' }, () => ({ contents: 'export const FishLogo = () => null; export const MarkdownText = () => null;' }))
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
const state = {
  room: { id: 'room-1', name: 'Ops', kind: 'workgroup', ownerUserId: 'u1' },
  members: [{ userId: 'u1', displayName: 'Alice', role: 'owner' }, { userId: 'u2', displayName: 'Bob', role: 'member' }],
  bots: [], messages: [], tasks: [], head: 0,
}

function workgroups(userId = 'u1') {
  return {
    identity: { userId }, openRoom: vi.fn(async () => state),
    renameRoom: vi.fn(async () => ({})), invite: vi.fn(async () => ({ id: 'invite-1' })),
    setRole: vi.fn(async () => ({})), removeMember: vi.fn(async () => ({})),
    leaveRoom: vi.fn(async () => ({})), revokeInvitation: vi.fn(async () => ({})), dissolve: vi.fn(async () => ({})),
    sendMessage: vi.fn(async () => ({})), answerTask: vi.fn(async () => ({})), reviewTask: vi.fn(async () => ({})),
    cancelTask: vi.fn(async () => ({})), uploadArtifact: vi.fn(),
    // The owner's own published directory. A test that wants a Bot choice stubs this, never the
    // room's mixed `bots` list: only the owner's published Bots may be dispatched to.
    directory: vi.fn(async () => []),
  }
}

describe('workgroup composer and Hub settings (mock Host)', () => {
  it('keeps an idempotency id when retrying and forwards mentions and artifact ids through the pane', async () => {
    const hub = workgroups()
    hub.sendMessage.mockRejectedValueOnce(new Error('delivery unknown'))
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, hub: { configured: true, signedIn: true, state: 'open' } })
    await fill('[data-wg-input="message"]', 'hello')
    await click('[data-wg-send="submit"]')
    await click('[data-wg-send="submit"]')
    const first = hub.sendMessage.mock.calls[0]
    expect(first[0]).toBe('room-1')
    expect(first[2].clientMessageId).toEqual(expect.any(String))
    expect(hub.sendMessage.mock.calls[1][2].clientMessageId).toBe(first[2].clientMessageId)
  })

  it('renames, invites, changes roles, removes, and dissolves via Hub actions only', async () => {
    const hub = workgroups()
    const local = { updateRoom: vi.fn(), deleteRoom: vi.fn() }
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, actions: local, hub: { configured: true, signedIn: true, state: 'open' } })
    await click('[data-wg-settings="open"]')
    await fill('[aria-label="Group name"]', 'New name')
    await click('[data-wg-action="rename"]')
    expect(hub.renameRoom).toHaveBeenCalledWith('room-1', { name: 'New name' })
    await fill('[aria-label="User ID"]', 'u3')
    await click('[data-wg-action="invite"]')
    expect(hub.invite).toHaveBeenCalledWith('room-1', { targetUserId: 'u3' })
    await click('[data-wg-action="revoke"]')
    expect(hub.revokeInvitation).toHaveBeenCalledWith('invite-1')
    await fill('[data-wg-role="u2"]', 'admin')
    expect(hub.setRole).toHaveBeenCalledWith('room-1', 'u2', 'admin')
    await click('[data-wg-remove="u2"]')
    expect(hub.removeMember).toHaveBeenCalledWith('room-1', 'u2')
    await click('[data-group-action="dissolve"]')
    await click('[data-group-action="dissolve"]')
    expect(hub.dissolve).toHaveBeenCalledWith('room-1')
    expect(local.updateRoom).not.toHaveBeenCalled()
    expect(local.deleteRoom).not.toHaveBeenCalled()
  })

  it('lets a member leave and withholds owner settings', async () => {
    const hub = workgroups('u2')
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, hub: { configured: true, signedIn: true, state: 'open' } })
    await click('[data-wg-settings="open"]')
    expect(container.querySelector('[data-group-action="dissolve"]')).toBeNull()
    expect(container.querySelector('[data-wg-action="rename"]')).toBeNull()
    await click('[data-wg-action="leave"]')
    expect(hub.leaveRoom).toHaveBeenCalledWith('room-1')
  })

  it('renders attachments as controlled download actions and displays refusals', async () => {
    const onDownload = vi.fn(async () => { throw new Error('Download not permitted') })
    await mount('WorkgroupView', { ...state, selfUserId: 'u1', onDownload, messages: [
      { id: 'm1', roomSeq: 1, body: 'notes', attachments: [{ artifactId: 'a1', fileName: 'notes.txt' }] },
    ] })
    await click('[data-wg-artifact="a1"]')
    expect(onDownload).toHaveBeenCalledWith({ artifactId: 'a1', fileName: 'notes.txt' })
    expect(container.textContent).toContain('Download not permitted')
  })
})


describe('owner-only workgroup task decisions', () => {
  const task = {
    id: 'task-1', state: 'PENDING_APPROVAL', version: 7, ownerUserId: 'u1', requesterUserId: 'u2',
    requesterDisplayName: 'Bob', description: 'Read the approved notes',
  }
  // The owner's published directory, and a room list that also carries somebody else's Bot: the
  // form must read the first and never the second.
  const ownerBots = [{ botId: 'bot-1', ownerUserId: 'u1', displayName: 'Research' }]
  const roomBots = [...ownerBots, { botId: 'bot-2', ownerUserId: 'u2', displayName: 'Private helper' }]
  const folderActions = {
    folders: vi.fn(async () => ({ team: null, picker: null, folders: [{ path: 'C:\\approved-notes', title: 'Approved notes' }] })),
  }

  /** A Hub adapter whose room already holds the pending task, and whose directory answers `bots`. */
  function approvalHub({ bots = ownerBots } = {}) {
    const hub = workgroups()
    hub.directory.mockResolvedValue(bots)
    hub.openRoom.mockResolvedValue({ ...state, tasks: [task], bots: roomBots })
    return hub
  }

  async function openApproval(hub) {
    await mount('WorkgroupSurface', {
      sessionId: 'wg:room-1', workgroups: hub, actions: folderActions,
      hub: { configured: true, signedIn: true, state: 'open' },
    })
    await click('[data-wg-approve="task-1"]')
    expect(container.querySelector('[data-wg-approval-form="task-1"]')).not.toBeNull()
  }

  /** Choose the one folder the folder guard offered, through the real FolderMenu. */
  async function pickApprovedFolder() {
    await click('[data-wg-workdir="task-1"] button')
    await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).not.toBeNull())
    const folder = [...document.body.querySelectorAll('[role="menuitemradio"]')]
      .find(item => item.getAttribute('title') === 'C:\\approved-notes')
    expect(folder).not.toBeUndefined()
    await act(async () => folder.click())
  }

  it('shows decision controls only to the task owner', async () => {
    const onDecision = vi.fn()
    await mount('WorkgroupView', { ...state, selfUserId: 'u1', tasks: [task], onDecision })
    expect(container.querySelector('[data-wg-approve="task-1"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-reject="task-1"]')).not.toBeNull()

    await act(async () => root.render(h(components.WorkgroupView, { ...state, selfUserId: 'u2', tasks: [task], onDecision })))
    expect(container.querySelector('[data-wg-approve="task-1"]')).toBeNull()
    expect(container.querySelector('[data-wg-reject="task-1"]')).toBeNull()
    expect(container.textContent).toContain('Read the approved notes')
  })

  it('gives the requester, a room admin, and an ordinary member no actionable decision', async () => {
    // The room's owner and admin is u3; the requester is u2. Neither may decide u1's task, and a
    // fourth member may not either. The server refuses them independently; the UI must not offer
    // the action at all.
    const room = { ...state, ownerUserId: 'u3', members: [...state.members, { userId: 'u3', displayName: 'Carol', role: 'owner' }] }
    for (const viewer of ['u2', 'u3', 'u4']) {
      const onDecision = vi.fn()
      await mount('WorkgroupView', { ...room, selfUserId: viewer, tasks: [task], onDecision })
      expect(container.querySelector('[data-wg-approve="task-1"]'), viewer).toBeNull()
      expect(container.querySelector('[data-wg-reject="task-1"]'), viewer).toBeNull()
      expect(container.querySelector('[data-wg-approval-form="task-1"]'), viewer).toBeNull()
      expect(onDecision).not.toHaveBeenCalled()
    }
  })

  it('forwards the displayed task version through the pane when the owner rejects', async () => {
    const hub = workgroups()
    hub.openRoom.mockResolvedValue({ ...state, tasks: [task] })
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, hub: { configured: true, signedIn: true, state: 'open' } })
    await click('[data-wg-reject="task-1"]')
    await vi.waitFor(() => expect(hub.openRoom).toHaveBeenCalledTimes(2))
    // A rejection grants nothing, so it carries no scope at all: only the version the card held.
    expect(hub.answerTask).toHaveBeenCalledWith('task-1', 'reject', { expectedVersion: 7 })
    expect(container.querySelector('[data-wg-settings="open"]')).not.toBeNull()
  })

  it('refuses an incomplete approval scope locally without contacting the Hub', async () => {
    const hub = approvalHub()
    await openApproval(hub)
    await click('[data-wg-approval-submit="task-1"]')
    expect(hub.answerTask).not.toHaveBeenCalled()
    expect(container.querySelector('[data-wg-approval-error="task-1"]')).not.toBeNull()
  })

  it('walks the owner through every required field and sends nothing until all are present', async () => {
    const hub = approvalHub()
    await openApproval(hub)
    const submit = () => click('[data-wg-approval-submit="task-1"]')
    const refused = () => {
      expect(hub.answerTask).not.toHaveBeenCalled()
      expect(container.querySelector('[data-wg-approval-error="task-1"]')).not.toBeNull()
    }

    // No mode yet.
    await submit(); refused()

    // A mode that needs no Bot still needs a folder, tools, a lifetime, and a recipient.
    await fill('[data-wg-assignment-mode="task-1"]', 'create_bot')
    await submit(); refused()

    await pickApprovedFolder()
    await submit(); refused()

    await fill('[data-wg-tools="task-1"]', ', ,')
    await submit(); refused()

    await fill('[data-wg-tools="task-1"]', 'read, summarize')
    await submit(); refused()

    // A lifetime that has ended is refused, not recorded.
    for (const expired of ['0', '-30', 'soon']) {
      await fill('[data-wg-expiry="task-1"]', expired)
      await submit(); refused()
    }

    await fill('[data-wg-expiry="task-1"]', '3600')
    await submit(); refused()

    // Every requirement now holds, so exactly one request goes out.
    const recipient = container.querySelector('[data-wg-recipient="u2"]')
    expect(recipient).not.toBeNull()
    await act(async () => Simulate.change(recipient, { target: { checked: true } }))
    await click('[data-wg-approval-submit="task-1"]')
    await vi.waitFor(() => expect(hub.answerTask).toHaveBeenCalledTimes(1))
  })

  it('forwards complete owner scope, expiry, recipients, and the displayed task version', async () => {
    const hub = approvalHub()
    await openApproval(hub)
    expect(hub.directory).toHaveBeenCalledWith({ ownerUserId: 'u1' })

    await fill('[data-wg-assignment-mode="task-1"]', 'existing_bot')
    const botSelect = container.querySelector('[data-wg-assigned-bot="task-1"]')
    expect(botSelect).not.toBeNull()
    // The owner's published Bot is offered; a colleague's room Bot is not.
    await vi.waitFor(() => expect([...botSelect.options].map(option => option.value)).toContain('bot-1'))
    expect([...botSelect.options].map(option => option.value)).not.toContain('bot-2')
    await fill('[data-wg-assigned-bot="task-1"]', 'bot-1')
    await pickApprovedFolder()
    await fill('[data-wg-tools="task-1"]', 'read, summarize')
    await fill('[data-wg-expiry="task-1"]', '3600')
    const recipient = container.querySelector('[data-wg-recipient="u2"]')
    expect(recipient).not.toBeNull()
    await act(async () => Simulate.change(recipient, { target: { checked: true } }))
    await click('[data-wg-approval-submit="task-1"]')

    await vi.waitFor(() => expect(hub.answerTask).toHaveBeenCalledTimes(1))
    expect(hub.answerTask).toHaveBeenCalledWith('task-1', 'approve', {
      expectedVersion: 7,
      mode: 'existing_bot',
      botId: 'bot-1',
      workDir: 'C:\\approved-notes',
      tools: ['read', 'summarize'],
      recipients: ['u2'],
      expiresAt: expect.any(String),
    })
    // The lifetime the owner typed becomes one absolute deadline, which is the only expiry the
    // scope records: a duration would leave a later reader unable to date the grant.
    const payload = hub.answerTask.mock.calls[0][2]
    expect(payload.approvedScope).toBeUndefined()
    const remaining = Date.parse(payload.expiresAt) - Date.now()
    expect(remaining).toBeGreaterThan(3_590_000)
    expect(remaining).toBeLessThan(3_610_000)
  })

  it('does not offer an existing Bot the owner has not published', async () => {
    const hub = approvalHub({ bots: [] })
    await openApproval(hub)
    await fill('[data-wg-assignment-mode="task-1"]', 'existing_bot')
    const botSelect = container.querySelector('[data-wg-assigned-bot="task-1"]')
    // Selecting the mode without a published Bot cannot produce a decision: the form refuses
    // rather than submitting a mode the executor cannot honour.
    expect([...botSelect.options].map(option => option.value)).toEqual([''])
    await pickApprovedFolder()
    await fill('[data-wg-tools="task-1"]', 'read')
    await fill('[data-wg-expiry="task-1"]', '600')
    const recipient = container.querySelector('[data-wg-recipient="u2"]')
    await act(async () => Simulate.change(recipient, { target: { checked: true } }))
    await click('[data-wg-approval-submit="task-1"]')
    expect(hub.answerTask).not.toHaveBeenCalled()
    expect(container.querySelector('[data-wg-approval-error="task-1"]')).not.toBeNull()
  })

  it('does not expose approval scope details to a non-owner', async () => {
    const privateTask = {
      ...task,
      approvedScope: {
        mode: 'existing_bot', assignedBotId: 'secret-bot', workDir: 'C:\\private-work',
        tools: ['private-tool'], recipients: ['u2'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
    }
    await mount('WorkgroupView', { ...state, selfUserId: 'u2', tasks: [privateTask] })

    expect(container.querySelector('[data-wg-approve="task-1"]')).toBeNull()
    expect(container.querySelector('[data-wg-approval-form="task-1"]')).toBeNull()
    expect(container.textContent).not.toContain('C:\\private-work')
    expect(container.textContent).not.toContain('private-tool')
    expect(container.textContent).not.toContain('secret-bot')
  })

  it('reads the room snapshot through the pane keyed hook', async () => {
    const hub = workgroups()
    hub.openRoom.mockResolvedValue({ ...state, tasks: [task] })
    const useWorkgroupRoom = vi.fn(() => ({ ...state, tasks: [task] }))
    await mount('WorkgroupPane', {
      useSessions: () => 'wg:room-1',
      useWorkgroups: () => hub,
      useHub: () => ({ configured: true, signedIn: true, state: 'open' }),
      useWorkgroupRoom,
      actions: {},
    })
    expect(useWorkgroupRoom).toHaveBeenCalledWith('room-1')
    expect(container.querySelector('[data-wg-approve="task-1"]')).not.toBeNull()
  })
})

describe('owner-only result review', () => {
  const finished = {
    id: 'task-2', state: 'REVIEW_REQUIRED', version: 9, ownerUserId: 'u1', requesterUserId: 'u2',
    requesterDisplayName: 'Bob', description: 'Summarize the approved notes',
  }

  it('offers keep, reject, and share only to the owner, and shows the redacted state to the room', async () => {
    const onReview = vi.fn()
    await mount('WorkgroupView', { ...state, selfUserId: 'u1', tasks: [finished], onReview })
    expect(container.querySelector('[data-wg-review-keep="task-2"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-review-share="task-2"]')).not.toBeNull()
    expect(container.querySelector('[data-wg-review-reject="task-2"]')).not.toBeNull()
    // The state is public to the room; the controls are not.
    expect(container.querySelector('[data-wg-task="task-2"]').getAttribute('data-wg-task-state')).toBe('REVIEW_REQUIRED')
    expect(container.textContent).toContain('Waiting for review')

    await act(async () => root.render(h(components.WorkgroupView, { ...state, selfUserId: 'u2', tasks: [finished], onReview })))
    expect(container.querySelector('[data-wg-review-keep="task-2"]')).toBeNull()
    expect(container.querySelector('[data-wg-review-share="task-2"]')).toBeNull()
    expect(container.querySelector('[data-wg-review-reject="task-2"]')).toBeNull()
    expect(container.querySelector('[data-wg-task="task-2"]')).not.toBeNull()
    expect(onReview).not.toHaveBeenCalled()
  })

  it('shares only with a named recipient, and keeps or rejects with the displayed version', async () => {
    const hub = workgroups()
    hub.openRoom.mockResolvedValue({ ...state, tasks: [finished] })
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, hub: { configured: true, signedIn: true, state: 'open' } })

    // An unnamed share is an unanswered question, not a grant to the room: refused locally.
    await click('[data-wg-review-share="task-2"]')
    expect(hub.reviewTask).not.toHaveBeenCalled()
    expect(container.querySelector('[data-wg-review-error="task-2"]')).not.toBeNull()

    const recipient = container.querySelector('[data-wg-review-recipient="u2"]')
    expect(recipient).not.toBeNull()
    await act(async () => Simulate.change(recipient, { target: { checked: true } }))
    await click('[data-wg-review-share="task-2"]')
    await vi.waitFor(() => expect(hub.reviewTask).toHaveBeenCalledWith('task-2', 'share', { expectedVersion: 9, recipients: ['u2'] }))

    hub.reviewTask.mockClear()
    await click('[data-wg-review-keep="task-2"]')
    await vi.waitFor(() => expect(hub.reviewTask).toHaveBeenCalledWith('task-2', 'keep', { expectedVersion: 9 }))

    hub.reviewTask.mockClear()
    await click('[data-wg-review-reject="task-2"]')
    await vi.waitFor(() => expect(hub.reviewTask).toHaveBeenCalledWith('task-2', 'reject', { expectedVersion: 9 }))
  })
})

describe('stopping a task that is already running', () => {
  const running = {
    id: 'task-3', state: 'RUNNING', version: 6, ownerUserId: 'u1', requesterUserId: 'u2',
    requesterDisplayName: 'Bob', description: 'Summarize the approved notes',
  }

  it('offers cancel to the requester and the owner, and not to an unrelated member', async () => {
    const onCancel = vi.fn()
    await mount('WorkgroupView', { ...state, selfUserId: 'u2', tasks: [running], onCancel })
    expect(container.querySelector('[data-wg-cancel="task-3"]')).not.toBeNull()

    await act(async () => root.render(h(components.WorkgroupView, { ...state, selfUserId: 'u1', tasks: [running], onCancel })))
    expect(container.querySelector('[data-wg-cancel="task-3"]')).not.toBeNull()

    // u4 is a member who is neither the requester nor the owner nor an admin of this room.
    await act(async () => root.render(h(components.WorkgroupView, {
      ...state,
      selfUserId: 'u4',
      members: [...state.members, { userId: 'u4', displayName: 'Dave', role: 'member' }],
      ownerUserId: 'u5',
      tasks: [running],
      onCancel,
    })))
    expect(container.querySelector('[data-wg-cancel="task-3"]')).toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels through the Hub adapter and reloads the room', async () => {
    const hub = workgroups()
    hub.openRoom.mockResolvedValue({ ...state, tasks: [running] })
    await mount('WorkgroupSurface', { sessionId: 'wg:room-1', workgroups: hub, hub: { configured: true, signedIn: true, state: 'open' } })
    await click('[data-wg-cancel="task-3"]')
    await vi.waitFor(() => expect(hub.cancelTask).toHaveBeenCalledWith('task-3'))
    await vi.waitFor(() => expect(hub.openRoom).toHaveBeenCalledTimes(2))
  })

  it('shows the Hub’s failure category without the owner’s message', async () => {
    const failed = { ...running, state: 'FAILED', lastReason: 'MODEL_UNAVAILABLE' }
    await mount('WorkgroupView', { ...state, selfUserId: 'u2', tasks: [failed] })
    const reason = container.querySelector('[data-wg-task-reason]')
    expect(reason).not.toBeNull()
    expect(reason.textContent).toBe('MODEL_UNAVAILABLE')
  })

  it('shows no cancel control for a task that has already ended', async () => {
    const done = { ...running, state: 'COMPLETED' }
    await mount('WorkgroupView', { ...state, selfUserId: 'u2', tasks: [done], onCancel: vi.fn() })
    expect(container.querySelector('[data-wg-cancel="task-3"]')).toBeNull()
  })
})

describe('the injected realtime room snapshot', () => {
  it('renders a presence update independently of the HTTP poll', async () => {
    const props = { sessionId: 'wg:room-1', workgroups: workgroups(), hub: { configured: true, signedIn: true, state: 'open' }, roomSnapshot: state }
    await mount('WorkgroupSurface', props)
    // Presence is shown in the details drawer, where the copied group chat lists its members.
    await click('[data-wg-details]')
    const roomSnapshot = { ...state, members: state.members.map(member => ({ ...member, online: true })) }
    await act(async () => root.render(h(components.WorkgroupSurface, { ...props, roomSnapshot })))
    expect(container.querySelector('[data-wg-member="u2"]').getAttribute('data-wg-presence')).toBe('online')
    expect(props.workgroups.openRoom).toHaveBeenCalledTimes(1)
  })
})
