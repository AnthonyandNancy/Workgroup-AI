// W3-T3: the owner Host's consumer for an approved workgroup task.
//
// The Hub is the authority and execution happens here, so this suite drives the production wiring
// that turns an approval event into an isolated native Bot Task Session: the real Host workgroup
// adapter (`workgroup-hub.js`) receives the event through its Bridge, the real consumer
// (`task-dispatch.js`) fetches owner-scoped detail, the real dispatch policy
// (`policy/dispatch.mjs`) consumes a signed single-use grant, and the real Task Session and grant
// modules (`task-sessions.js`, `task-grants.js`) create the isolated Session and its limits.
//
// What is a test double, and why that is stated rather than hidden:
//
//   * `fetch` is the Hub. The bytes and signatures are real (an Ed25519 key is generated per run
//     and the grant is signed over the real canonical bytes); only the HTTP server is absent.
//   * `sessionController` is the native Bot's Session factory. It records what the product code
//     asked for — which folder, which preset, which Session id — instead of running a model.
//   * The Bot roster is one Bot owned by the host user, which is what `botOf` reads.
//
// So this is M-level evidence for the execution chain. It does not prove a real model run, a real
// Hub, or process termination (L/N remain BLOCKED), and it does not stand in for the REAL Loader
// composition suite.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createPublicKey } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { install as installTaskSessions } from '../../../packages/bundle/ds-bot/src/host/task-sessions.js'
import { install as installTaskGrants } from '../../../packages/bundle/ds-bot/src/host/task-grants.js'
import { install as installWorkgroupHub } from '../../../packages/bundle/ds-bot/src/host/workgroup-hub.js'
import { install as installTaskDispatch } from '../../../packages/bundle/ds-bot/src/host/task-dispatch.js'
import { SIGNED_GRANT_FIELDS } from '../../../integrations/workgroup/policy/grant-signature.mjs'

import { recycleTestPath } from './recycle.mjs'

const temporaryRoots = []
const cleanupFns = []
// Each Host's scratch tree is recycled in the test that made it: the recycle runs PowerShell on
// Windows, and a whole file's worth of trees in one hook exceeds the hook timeout.
afterAll(() => { for (const root of temporaryRoots.splice(0)) recycleTestPath(root) }, 60_000)
afterEach(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()()
  vi.unstubAllGlobals()
}, 30_000)

function temporaryRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function response(payload, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

const KEY_PAIR = generateKeyPairSync('ed25519')
const KEY_ID = 'g1'
const PUBLIC_PEM = KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' })
const NOW = () => new Date()
const future = seconds => new Date(Date.now() + seconds * 1000).toISOString()

/** Sign a grant the way `server/src/modules/tasks/signing.js` does, over the same canonical bytes. */
function signedGrant({ botId = 'bot-1', taskId = 'task-1', expiresAt }) {
  const grant = { id: `grant-${Math.random().toString(16).slice(2)}`, taskId, botId, expiresAt, nonce: `nonce-${Math.random().toString(16).slice(2)}`, keyId: KEY_ID }
  const bytes = Buffer.from(SIGNED_GRANT_FIELDS.map(field => (field === 'grantId' ? grant.id : String(grant[field] ?? ''))).join('\n'), 'utf8')
  grant.signature = sign(null, bytes, KEY_PAIR.privateKey).toString('base64')
  return grant
}

class TestWebSocket {
  static OPEN = 1
  static instances = []
  readyState = 0
  listeners = new Map()
  constructor() { TestWebSocket.instances.push(this) }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  send() {}
  close() {}
  emit(type, event) { this.listeners.get(type)?.(event) }
}

/**
 * One Host process: real Task Session, grant, workgroup, and dispatch modules over a stubbed Hub.
 *
 * `hub` is mutable so a case can change what the Hub answers without rebuilding the process.
 */
function makeHost({ ownerUserId = 'u1', botId = 'bot-1', workDir } = {}) {
  const root = temporaryRoot('workgroup-dispatch-')
  const scratch = join(root, 'approved')
  mkdirSync(scratch)
  const approvedDir = realpathSync(workDir ?? scratch)
  const hubStatePath = join(root, 'hub-session.json')
  writeFileSync(hubStatePath, JSON.stringify({
    userId: ownerUserId,
    userHandle: 'alice',
    displayName: 'Alice',
    deviceId: 'device-1',
    accessToken: 'test-only-access-token',
    refreshToken: 'test-only-refresh-token',
    accessTokenExpiresAt: future(3600),
    refreshTokenExpiresAt: future(3600),
  }))
  const hubConfigPath = join(root, 'hub-config.json')

  const state = {
    bots: { [botId]: { id: botId, name: 'Writer', role: 'Worker', sessionId: `chat-${botId}`, instructions: 'Be careful' } },
    mainBotIds: [botId],
    taskSessions: {}, taskGrants: {}, revision: 0,
  }
  const created = []
  const prompts = []
  const guards = []
  const archived = []
  const warnings = []
  const hub = {
    requests: [],
    task: undefined,
    consumeStatus: 200,
    progressFails: false,
    version: 3,
    approvedQueue: [],
    setTask(next) { hub.task = next; hub.version = next.version ?? 3 },
    reset() { hub.requests.length = 0 },
  }

  vi.stubGlobal('WebSocket', TestWebSocket)
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    hub.requests.push({ url: target, method, body })
    if (target.endsWith('/rooms/room-1')) return response({ room: { id: 'room-1', name: 'Ops', kind: 'workgroup' }, members: [] })
    if (target.endsWith('/rooms/room-1/messages?afterSeq=0&limit=200')) return response({ messages: [], hasMore: false })
    if (target.endsWith('/rooms/room-1/messages?limit=200')) return response({ messages: [], nextAfterSeq: 0 })
    if (target.endsWith('/rooms/room-1/tasks')) return response({ tasks: [] })
    // The owner's approved queue: the durable read a Host uses when no event reached it.
    if (target.endsWith('/tasks/approved')) return response({ tasks: hub.approvedQueue ?? [] })
    if (target.endsWith('/tasks/task-1')) return response({ task: { ...hub.task, version: hub.version }, events: [] })
    if (target.endsWith('/tasks/task-1/grant')) return response({ grant: signedGrant({ botId: hub.task?.assignedBotId ?? botId, expiresAt: future(3600) }) }, { status: 201 })
    if (target.endsWith('/dispatch/keys')) return response({ keys: { [KEY_ID]: PUBLIC_PEM }, currentKeyId: KEY_ID })
    if (target.endsWith('/dispatch/consume')) {
      if (hub.consumeStatus !== 200) return response({ error: { code: 'GRANT_REVOKED', message: 'This grant was revoked' } }, { status: hub.consumeStatus })
      // The Hub records the dispatch and the QUEUED state in one step, exactly as
      // `server/src/modules/tasks/grants.js` does: the consumer must re-read the version rather
      // than assume the pre-consume one.
      hub.version += 1
      hub.task = { ...hub.task, state: 'QUEUED', version: hub.version }
      return response({ taskId: 'task-1', botId: body.botId ?? hub.task?.assignedBotId ?? null, scope: hub.task?.approval?.scope ?? {} })
    }
    if (target.endsWith('/tasks/task-1/progress')) {
      if (hub.progressFails) return response({ error: { code: 'VERSION_CONFLICT', message: 'This task has moved on' } }, { status: 409 })
      // A stage-only report changes no state, so it does not move the version — exactly as the
      // Hub’s own progress route behaves.
      if (body.state !== undefined) {
        hub.version += 1
        hub.task = { ...hub.task, state: body.state, version: hub.version }
      }
      return response({ task: hub.task })
    }
    throw new Error(`unexpected Hub request ${method} ${target}`)
  })

  const sessionEvents = []
  const rt = {
    config: { hubUrl: 'https://hub.example', hubStatePath, hubConfigPath },
    dshHome: join(root, 'home'),
    version: 'test',
    warn: (...args) => { warnings.push(args.join(' ')) },
    state,
    ctx: {
      emit: () => {},
      // Cordis' effectful listener registration: the consumer's turn-end report is registered here,
      // so the test can deliver the same event the Agent loop would.
      on: (name, handler) => { if (name === 'session/event') sessionEvents.push(handler); return () => {} },
      tools: { guard: fn => guards.push(fn) },
      sessionController: {
        create: vi.fn(async (options) => {
          const sessionId = `task-session-${created.length + 1}`
          created.push({ sessionId, options })
          return { sessionId }
        }),
        prompt: vi.fn(async (request) => { prompts.push(request); return {} }),
      },
      sessionTitle: { rename: vi.fn(async () => {}) },
      sessions: { flush: vi.fn(async () => {}) },
      // The model boundary for `chief_auto`. It answers with the only Bot in the roster; the point
      // under test is that the answer is a suggestion the flow still verifies, not a local guess.
      llm: {
        resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [] } })),
        stream: vi.fn(() => (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'bot-1' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'bot-1' } }
        })()),
      },
      workspaceRegistry: {
        archiveSession: vi.fn(async (id, options) => { archived.push({ id, options }) }),
        get: () => ({ path: root }),
      },
    },
    botOf: id => state.bots[id],
    defaultModel: vi.fn(async () => 'location/test-model'),
    desiredModel: vi.fn(async () => undefined),
    chatOf: id => state.bots[id]?.sessionId ?? id,
    isFolder: async path => path === approvedDir,
    ensureWorkspace: vi.fn(async () => 'workspace-1'),
    readOnly: () => undefined,
    resolveAgent: vi.fn(async (sessionId) => ({ session: { id: sessionId }, cancel: vi.fn() })),
    indexAgents: vi.fn(),
    save: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    ensureCapabilities: vi.fn(async () => {}),
  }

  installTaskSessions(rt)
  installTaskGrants(rt)
  installWorkgroupHub(rt)
  installTaskDispatch(rt)

  const host = {
    rt, hub, state, created, prompts, guards, archived, warnings, approvedDir, ownerUserId, botId, root,
    /** Deliver a Session event exactly as `agent-loop` publishes it to `session/event`. */
    emitSessionEvent(sessionId, event) {
      for (const handler of sessionEvents) handler({ id: sessionId }, event)
    },
  }
  cleanupFns.push(async () => {
    await rt.hubEndpoint('hub-sign-out', {}).catch(() => {})
    const index = temporaryRoots.indexOf(root)
    if (index !== -1) temporaryRoots.splice(index, 1)
    recycleTestPath(root)
  })
  return host
}

/** A task the owner approved, as the owner-scoped detail route answers it. */
function approvedTask({ ownerUserId = 'u1', botId = 'bot-1', workDir, overrides = {} } = {}) {
  const scope = {
    mode: 'existing_bot',
    assignedBotId: botId,
    workDir,
    tools: ['read', 'write'],
    recipients: ['u2'],
    expiresAt: future(3600),
    taskId: 'task-1',
    roomId: 'room-1',
    requesterUserId: 'u2',
    ownerUserId,
  }
  return {
    id: 'task-1', roomId: 'room-1', requesterUserId: 'u2', ownerUserId,
    targetBotId: botId, assignedBotId: botId, assignmentMode: 'existing_bot',
    description: 'Summarize the approved notes',
    state: 'APPROVED', version: 3, revocationVersion: 0,
    createdAt: future(-600), updatedAt: future(-60),
    approval: { decision: 'approve', decidedAt: future(-60), expiresAt: future(3600), scope },
    ...overrides,
  }
}

const event = (type = 'task.approved', taskId = 'task-1') => ({ schemaVersion: 'wg.v1', eventId: `event-${type}`, type, roomId: 'room-1', payload: { taskId, state: 'APPROVED' } })

const paths = (host) => host.hub.requests.map(entry => `${entry.method} ${entry.url.replace('https://hub.example/api/v1', '')}`)

/** Drive one approved event through the Host hook and wait until the consumer settled. */
async function dispatchApproved(host, payload = event()) {
  await host.rt.onWorkgroupEvent(payload)
}

describe('an approved workgroup task becomes one isolated native Bot Task Session', () => {
  it('consumes one signed grant and starts exactly one bound Task Session', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)

    // The chain, in order: owner-scoped detail, one grant, the published keys, one consume, then
    // the two legal state steps before a session exists.
    expect(paths(host)).toEqual([
      'GET /tasks/task-1',
      'POST /tasks/task-1/grant',
      'GET /dispatch/keys',
      // Consuming the grant moves the task to QUEUED on the Hub.
      'POST /dispatch/consume',
      'GET /tasks/task-1',
      // Only the step to RUNNING is left for the executor, and it uses the version the Hub now has.
      'POST /tasks/task-1/progress',
      // The two stage-only reports the flow emits while it starts and once the turn is handed over.
      'POST /tasks/task-1/progress',
      'POST /tasks/task-1/progress',
    ])
    expect(host.hub.requests[5].body.state).toBe('RUNNING')
    expect(host.hub.requests[5].body.expectedVersion).toBe(4)
    // A stage-only report is exactly that: no state, no path, no tool list, no session id.
    for (const entry of host.hub.requests.slice(6)) {
      expect(Object.keys(entry.body)).toEqual(['stage'])
    }

    expect(host.created).toHaveLength(1)
    expect(host.created[0].options.cwd).toBe(host.approvedDir)
    // The durable binding names the task, the approved Bot, and the new Session.
    assert.deepEqual(
      Object.fromEntries(Object.entries(host.state.taskSessions['task-1']).filter(([key]) => ['taskId', 'botId', 'sessionId', 'workDir', 'closedAt'].includes(key))),
      { taskId: 'task-1', botId: 'bot-1', sessionId: 'task-session-1', workDir: host.approvedDir, closedAt: null },
    )
    // The local grant carries the approved tools and the approved folder, so every later tool call
    // is checked against the scope rather than against whatever the Session was created with.
    assert.deepEqual(host.state.taskGrants['task-1'].allowedTools, ['read', 'write'])
    assert.equal(host.state.taskGrants['task-1'].workDir, host.approvedDir)
    assert.equal(host.state.taskGrants['task-1'].revocationVersion, 0)
    // The task is actually handed to the Bot: a Session that is created and never prompted would
    // report "started" while nothing runs.
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0].sessionId).toBe('task-session-1')
    expect(host.prompts[0].content[0].text).toContain('Summarize the approved notes')
    expect(host.rt.ensureCapabilities).toHaveBeenCalledWith('task-session-1')
    // Isolation: a new Session, never the Bot's ordinary chat.
    expect(host.created[0].sessionId).not.toBe(host.rt.chatOf('bot-1'))
  })

  it('starts nothing before an approval: PENDING_APPROVAL is refused with no grant and no session', async () => {
    const host = makeHost()
    // The frame claims an approval; the Hub's own detail says the task is still pending. The detail
    // is the authority, so the attempt stops there.
    host.hub.setTask(approvedTask({ workDir: host.approvedDir, overrides: { state: 'PENDING_APPROVAL', approval: undefined } }))
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.prompts).toEqual([])
    expect(paths(host).some(path => path.includes('/grant'))).toBe(false)
    expect(paths(host).some(path => path.includes('/dispatch/consume'))).toBe(false)
    expect(host.state.taskSessions).toEqual({})
  })

  it('refuses a rejected task, a cancelled task, and a task that is already terminal', async () => {
    for (const state of ['REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED', 'EXPIRED']) {
      const host = makeHost()
      host.hub.setTask(approvedTask({ workDir: host.approvedDir, overrides: { state } }))
      await dispatchApproved(host)
      expect(host.created, state).toEqual([])
      expect(host.hub.requests.some(entry => entry.url.endsWith('/grant')), state).toBe(false)
    }
  })

  it('refuses Another owner\u2019s approval and never starts work on this machine', async () => {
    // The event reaches every socket in the room, so a member Host sees approvals that are not its
    // own. The identity check is the one that stops it.
    const host = makeHost({ ownerUserId: 'u1' })
    host.hub.setTask(approvedTask({ ownerUserId: 'u2', workDir: host.approvedDir }))
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.hub.requests.some(entry => entry.url.endsWith('/grant'))).toBe(false)
    expect(host.hub.requests.some(entry => entry.url.endsWith('/dispatch/consume'))).toBe(false)
  })

  it('refuses a task whose scope names another Bot than the one it was approved for', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir, overrides: { assignedBotId: 'bot-1' } }))
    host.hub.task.approval.scope.assignedBotId = 'bot-2'
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.hub.requests.some(entry => entry.url.endsWith('/dispatch/consume'))).toBe(false)
  })

  it('refuses an expired approval before minting anything', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    host.hub.task.approval.scope.expiresAt = future(-60)
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.hub.requests.some(entry => entry.url.endsWith('/grant'))).toBe(false)
  })

  it('refuses a scope with no approved directory instead of falling back to a workspace', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    delete host.hub.task.approval.scope.workDir
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.rt.ensureWorkspace).not.toHaveBeenCalled()
    // Refused before the credential was spent: no grant was minted for a scope that cannot run.
    expect(host.hub.requests.some(entry => entry.url.endsWith('/grant'))).toBe(false)
    // The refusal is reported to the room only as a failure stage, never with the scope.
    const reported = host.hub.requests.filter(entry => entry.url.endsWith('/progress'))
    expect(reported.length).toBeGreaterThan(0)
    expect(JSON.stringify(reported.map(entry => entry.body))).not.toContain('approval')
    // The room learns a category, not the owner's message or the path.
    expect(reported.at(-1).body.reason).toBe('NO_DIRECTORY_APPROVED')
  })

  it('does not start when the Hub refuses to consume the grant, and reports the failure', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    host.hub.consumeStatus = 403
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.prompts).toEqual([])
    const failed = host.hub.requests.filter(entry => entry.url.endsWith('/progress')).at(-1)
    expect(failed.body.state).toBe('FAILED')
  })

  it('does not start when the task moved on between the event and the state step', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    host.hub.progressFails = true
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    expect(host.state.taskSessions).toEqual({})
  })

  it('starts one Session for duplicate approvals rather than two', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    await dispatchApproved(host)

    expect(host.created).toHaveLength(1)
    expect(host.hub.requests.filter(entry => entry.url.endsWith('/grant'))).toHaveLength(1)
    expect(host.hub.requests.filter(entry => entry.url.endsWith('/dispatch/consume'))).toHaveLength(1)
  })

  it('does not restart a task whose Session was already closed', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    host.state.taskSessions['task-1'].closedAt = Date.now()
    host.hub.reset()
    await dispatchApproved(host)

    expect(host.created).toHaveLength(1)
    expect(host.hub.requests.filter(entry => entry.url.endsWith('/dispatch/consume'))).toHaveLength(0)
  })

  it('reports a finished turn for review, and a failed turn as failed', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    // The two state steps left the Hub task at version 5 and RUNNING.
    expect(host.hub.task.state).toBe('RUNNING')
    host.hub.reset()

    host.emitSessionEvent('task-session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(host.hub.requests.some(entry => entry.url.endsWith('/progress'))).toBe(true))
    const review = host.hub.requests.filter(entry => entry.url.endsWith('/progress')).at(-1)
    expect(review.body).toEqual({ state: 'REVIEW_REQUIRED', expectedVersion: 5, stage: 'review' })

    // A second turn end (a retry) does not report again: the review is one decision on one result.
    host.hub.reset()
    host.emitSessionEvent('task-session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resume => setTimeout(resume, 50))
    expect(host.hub.requests.filter(entry => entry.url.endsWith('/progress'))).toHaveLength(0)
  })

  it('reports a failed turn as FAILED rather than asking for a review', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    host.hub.reset()

    host.emitSessionEvent('task-session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'model endpoint unavailable', code: 'UNKNOWN' } } } })
    await vi.waitFor(() => expect(host.hub.requests.some(entry => entry.url.endsWith('/progress'))).toBe(true))
    const failed = host.hub.requests.filter(entry => entry.url.endsWith('/progress')).at(-1)
    expect(failed.body.state).toBe('FAILED')
    expect(failed.body.stage).toBe('failed')
  })

  it('cancels by revoking the grant before stopping the Session, and records the unconfirmed process state', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)

    // Before the cancellation, an approved tool is allowed through the per-call guard.
    expect(host.rt.checkTaskToolCallForProbe({ agent: { id: 'task-session-1' }, name: 'read', input: {} })).toBeUndefined()

    const order = []
    const revoke = host.rt.revokeGrant
    host.rt.revokeGrant = async (...args) => { order.push('revoke'); return await revoke(...args) }
    const close = host.rt.closeTaskSession
    host.rt.closeTaskSession = async (...args) => { order.push('close'); return await close(...args) }

    host.hub.setTask({ ...approvedTask({ workDir: host.approvedDir }), state: 'CANCELLED' })
    await host.rt.onWorkgroupEvent(event('task.cancelled'))

    expect(order).toEqual(['revoke', 'close'])
    // Every later call by the cancelled task is refused by the grant guard, without asking the Hub.
    expect(host.rt.checkTaskToolCallForProbe({ agent: { id: 'task-session-1' }, name: 'read', input: {} })).toMatch(/withdrawn/)
    const binding = host.rt.taskBinding('task-1')
    expect(binding.closedAt).toEqual(expect.any(Number))
    // The Session stop is observed; a child process the turn may have spawned is not, and is not
    // claimed to be.
    expect(binding.cancel).toEqual({ signalledAt: expect.any(Number), sessionStopped: true, processTree: 'unconfirmed' })
    expect(host.archived).toHaveLength(1)
    expect(host.archived[0]).toEqual({ id: 'task-session-1', options: { stopActivity: true } })
  })

  it('ignores a cancellation that is not this owner’s, and one whose task is still running', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    const revoke = vi.fn()
    host.rt.revokeGrant = revoke

    host.hub.setTask({ ...approvedTask({ workDir: host.approvedDir }), state: 'RUNNING' })
    await host.rt.onWorkgroupEvent(event('task.cancelled'))
    expect(revoke).not.toHaveBeenCalled()

    host.hub.setTask({ ...approvedTask({ workDir: host.approvedDir }), ownerUserId: 'u2', state: 'CANCELLED' })
    await host.rt.onWorkgroupEvent(event('task.cancelled'))
    expect(revoke).not.toHaveBeenCalled()
  })

  it('reports FAILED when the Session cannot be opened or the turn cannot be handed over', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    // The Session factory refusing is a normal failure on an owner host (no model configured, the
    // workspace gone). It must reach a terminal state rather than leave the task RUNNING forever.
    host.rt.ctx.sessionController.create.mockRejectedValueOnce(new Error('no model is available'))
    await dispatchApproved(host)

    expect(host.created).toEqual([])
    const failed = host.hub.requests.filter(entry => entry.url.endsWith('/progress')).at(-1)
    expect(failed.body.state).toBe('FAILED')
    expect(failed.body.stage).toBe('failed')
    expect(host.warnings.some(line => line.includes('failed to run'))).toBe(true)
  })

  it('refuses a tool call once this Host has observed a newer revocation version', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    const probe = () => host.rt.checkTaskToolCallForProbe({ agent: { id: 'task-session-1' }, name: 'read', input: {} })
    expect(probe()).toBeUndefined()

    // A cancellation raises the Hub's version. Learning the new value is enough to stop the next
    // call, even before (or without) the cancellation event arriving.
    await host.rt.recordRevocationVersion('task-1', 1)
    expect(host.state.taskGrants['task-1'].currentRevocationVersion).toBe(1)
    expect(probe()).toMatch(/cancelled after its grant/)
  })

  it('learns a moved revocation version from an owner-scoped read at turn end', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await dispatchApproved(host)
    host.hub.task = { ...host.hub.task, state: 'RUNNING', revocationVersion: 3, version: host.hub.version }

    host.emitSessionEvent('task-session-1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'model unavailable' } } } })
    await vi.waitFor(() => expect(host.state.taskGrants['task-1'].currentRevocationVersion).toBe(3))
    expect(host.rt.checkTaskToolCallForProbe({ agent: { id: 'task-session-1' }, name: 'read', input: {} }))
      .toMatch(/cancelled after its grant/)
  })

  it('lets the owner’s Chief choose a Bot when the approval names no Bot', async () => {
    const host = makeHost()
    const task = approvedTask({ workDir: host.approvedDir, overrides: { assignmentMode: 'chief_auto', assignedBotId: null, targetBotId: null } })
    task.approval.scope.mode = 'chief_auto'
    delete task.approval.scope.assignedBotId
    host.hub.setTask(task)
    await dispatchApproved(host)

    expect(host.created).toHaveLength(1)
    // The Chief's answer is what selected the Bot, and the local grant records the Bot that ran.
    expect(host.state.taskGrants['task-1'].botId).toBe('bot-1')
    expect(host.rt.ctx.llm.stream).toHaveBeenCalledTimes(1)
    expect(host.prompts).toHaveLength(1)
  })

  it('finds approved work through the owner queue when no approval event arrived', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    // The queue is owner-scoped on the Hub; a task belonging to somebody else is not this Host's.
    host.hub.approvedQueue = [
      { id: 'task-other', ownerUserId: 'u2' },
      { id: 'task-1', ownerUserId: 'u1', state: 'APPROVED' },
    ]
    const result = await host.rt.taskDispatchReconcile()
    expect(result.started).toBe(1)
    expect(host.created).toHaveLength(1)
    expect(host.state.taskSessions['task-1']).toBeDefined()

    // A second pass sees the durable binding and starts nothing again.
    host.hub.reset()
    await host.rt.taskDispatchReconcile()
    expect(host.created).toHaveLength(1)
    expect(host.hub.requests.some(entry => entry.url.endsWith('/grant'))).toBe(false)
  })

  it('receives the approval through the real Bridge rather than by being called directly', async () => {
    const host = makeHost()
    host.hub.setTask(approvedTask({ workDir: host.approvedDir }))
    await host.rt.hubEndpoint('hub-open-room', { roomId: 'room-1' })
    const socket = TestWebSocket.instances.at(-1)
    expect(socket).toBeDefined()
    socket.readyState = TestWebSocket.OPEN
    socket.emit('open')
    await host.rt.hubEndpoint('hub-open-room', { roomId: 'room-1' })
    socket.emit('message', { data: JSON.stringify(event()) })

    await vi.waitFor(() => expect(host.created).toHaveLength(1))
    expect(host.prompts).toHaveLength(1)
  })
})
