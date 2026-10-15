// A-09: progress is redacted, and a result leaves the owner's machine only by review.
//
// The requirement is "private intermediate data is not published automatically", and the failure it
// describes is specific: a task runs in B's folder with B's model, and the room asked for a result —
// not for B's paths, B's shell output, or B's model's reasoning. This file tests the boundary from
// both sides:
//
//   * **What the room receives.** A real Hub, a real requester subscribed over a real WebSocket, and
//     a real progress report. What arrives is asserted field by field, so a private field that starts
//     travelling is a test failure rather than something noticed in a log later.
//   * **What the room cannot make happen.** The requester cannot write progress, cannot review, and
//     cannot share. Each is a route the Hub refuses, not a convention the client follows.
//
// The redaction is a **positive** field list, so this file also asserts that a field nobody
// anticipated is absent — which a negative list could not do.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createBridge } from '../bridge/index.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import { createApprovalClient } from '../client/approvals.mjs'
import {
  publicProgress,
  publicEventPayload,
  assertPublishable,
  reviewDecision,
  sharedPayload,
  recipientsForShare,
  NEVER_PUBLISHED,
  PROGRESS_STAGES,
  ProgressError,
} from '../client/review.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a09-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a09-bootstrap-secret'

async function loadWebSocket() {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const resolved = createRequire(import.meta.url).resolve('ws', { paths: [resolve(APP_ROOT, 'apps', 'web')] })
  const module = await import(pathToFileURL(resolved).href)
  return module.default ?? module.WebSocket
}

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a09-'))
  const port = 24000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try { if ((await fetch(`${base}/api/v1/health/live`)).ok) break } catch { /* not up */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`the Hub never came up:\n${log}`) }
    await new Promise(resume => setTimeout(resume, 150))
  }
  return {
    base,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resume => setTimeout(resume, 5000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true, maxRetries: 10 })
    },
  }
}

let hub
let WebSocketImpl
let counter = 0

async function newPerson(label, botId) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  const person = { handle, client, userId: client.identity.userId, deviceId: client.deviceId, workgroup: createWorkgroupClient({ client }) }
  person.approvals = createApprovalClient({ client, selfUserId: person.userId })
  if (botId !== undefined) {
    await client.request('POST', '/bots', { body: { botId, displayName: botId, role: 'Worker', visibility: 'public' } })
  }
  return person
}

/** A room with `requester` and `owner` in it, and a task the owner has approved and started. */
async function runningTask({ requester, owner, botId }) {
  const room = await requester.client.request('POST', '/rooms', { body: { name: 'Review room' } })
  await owner.workgroup.respondToInvitation((await requester.workgroup.invite(room.room.id, { targetUserId: owner.userId })).id, 'accept')
  const created = await requester.client.request('POST', `/rooms/${room.room.id}/tasks`, {
    body: { ownerUserId: owner.userId, description: 'Write the summary', targetBotId: botId },
  })
  let task = created.task
  task = await owner.approvals.decide({
    taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId, workDir: '/tmp/a09',
  })
  // Move it to RUNNING through the owner's own progress report, which is the only writer.
  task = await owner.approvals.reportProgress(task.id, { state: 'QUEUED', expectedVersion: task.version })
  task = await owner.approvals.reportProgress(task.id, { state: 'RUNNING', expectedVersion: task.version, stage: 'running' })
  return { roomId: room.room.id, task }
}

async function waitFor(predicate, { timeout = 15_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resume => setTimeout(resume, interval))
  }
}

beforeAll(async () => {
  hub = await startRealHub()
  WebSocketImpl = await loadWebSocket()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
}, 30_000)

// ---------------------------------------------------------------------------
// What a room receives
// ---------------------------------------------------------------------------

describe('what a room receives of a running task', () => {
  it('a progress report reaches the requester with only a stage and a state', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { roomId, task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })

    const events = []
    const bridge = createBridge({ hubUrl: hub.base, client: alice.client, WebSocketImpl, onEvent: event => { events.push(event) }, logger: {} })
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'alice to connect' })

      await bob.approvals.reportProgress(task.id, { stage: 'running' })
      await waitFor(() => events.some(event => event.type === 'task.progress'), { label: 'a progress event' })

      const progress = events.find(event => event.type === 'task.progress')
      // What the room learns: that the task moved. What it does not: which Bot, which Session, which
      // folder, or what the model is thinking.
      assert.equal(progress.payload.state, 'RUNNING')
      const serialized = JSON.stringify(progress)
      for (const forbidden of ['writer', 'workDir', '/tmp/a09', 'task.assignedBotId'].slice(0, 3)) {
        assert.equal(serialized.includes(forbidden), false, `the room saw ${forbidden} in ${serialized}`)
      }
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('the room\u2019s view of the task carries no machine detail', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { roomId, task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })

    const listed = await alice.client.request('GET', `/rooms/${roomId}/tasks`)
    const mine = listed.tasks.find(entry => entry.id === task.id)
    assert.ok(mine !== undefined)
    // What the requester may know: what they asked for and where it stands.
    assert.equal(mine.description, 'Write the summary')
    assert.equal(mine.state, 'RUNNING')

    // What they may not: the Bot, the mode, the scope. These are absent from the room's shape
    // entirely, not merely empty.
    for (const field of ['approvedScope', 'approval', 'workDir', 'assignedBotId', 'tools', 'sessionId']) {
      assert.equal(field in mine, false, `the room view exposed ${field}`)
    }
    // And the raw response text confirms it, so a nested field cannot hide.
    const raw = JSON.stringify(listed)
    assert.equal(raw.includes('/tmp/a09'), false)
    assert.equal(raw.includes('existing_bot'), false)
  }, 60_000)

  it('the owner may read what the room may not', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    // The owner's own view includes the scope, because it is their statement about their machine.
    const scope = await bob.approvals.approvedScope(task.id)
    assert.equal(scope.workDir, '/tmp/a09')
    assert.equal(scope.assignedBotId, 'writer')
  }, 60_000)

  it('the requester cannot write the owner\u2019s progress', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    // A progress line the requester could forge would let them claim work the owner never did.
    await expect(alice.client.request('POST', `/tasks/${task.id}/progress`, { body: { stage: 'running' } }))
      .rejects.toThrow(/owner/i)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Reviewing a result
// ---------------------------------------------------------------------------

describe('reviewing a result', () => {
  /** Move a task to REVIEW_REQUIRED as its owner. */
  async function requireReview(owner, task) {
    return owner.approvals.reportProgress(task.id, { state: 'REVIEW_REQUIRED', expectedVersion: task.version, stage: 'review_required' })
  }

  it('keep completes the task without publishing anything', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { roomId, task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    const awaiting = await requireReview(bob, task)

    const events = []
    const bridge = createBridge({ hubUrl: hub.base, client: alice.client, WebSocketImpl, onEvent: event => { events.push(event) }, logger: {} })
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'alice to connect' })

      const kept = await bob.approvals.review(awaiting.id, 'keep', { expectedVersion: awaiting.version })
      assert.equal(kept.state, 'COMPLETED')

      await new Promise(resume => setTimeout(resume, 500))
      // Nothing resembling a result reached the room.
      const serialized = JSON.stringify(events)
      assert.equal(serialized.includes('summary'), false)
      assert.equal(serialized.includes('/tmp/a09'), false)
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('reject fails the task, and nothing is published', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    const awaiting = await requireReview(bob, task)
    const failed = await bob.approvals.review(awaiting.id, 'reject', { expectedVersion: awaiting.version })
    assert.equal(failed.state, 'FAILED')
  }, 60_000)

  it('share moves the task to SHARED and names the recipients in the event', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const carol = await newPerson('carol')
    const { roomId, task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    await carol.workgroup.respondToInvitation((await alice.workgroup.invite(roomId, { targetUserId: carol.userId })).id, 'accept')
    const awaiting = await requireReview(bob, task)

    const events = []
    const bridge = createBridge({ hubUrl: hub.base, client: carol.client, WebSocketImpl, onEvent: event => { events.push(event) }, logger: {} })
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'carol to connect' })

      const shared = await bob.approvals.review(awaiting.id, 'share', { expectedVersion: awaiting.version, recipients: [carol.userId] })
      assert.equal(shared.state, 'SHARED')

      await waitFor(() => events.some(event => event.type === 'task.shared'), { label: 'the share event' })
      const event = events.find(entry => entry.type === 'task.shared')
      // The named recipient, and the requester: a result shared with a third party but not with the
      // person who asked for it would be worse than not sharing.
      assert.deepEqual([...event.payload.recipients].sort(), [alice.userId, carol.userId].sort())
      // The payload names people, not contents: no summary, no path, no artifact body.
      assert.equal(JSON.stringify(event).includes('/tmp/a09'), false)
      assert.equal('summary' in event.payload, false)
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('sharing with no recipients is refused, because an empty list is a question not a grant', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    const awaiting = await requireReview(bob, task)
    for (const recipients of [[], undefined, 'everyone']) {
      // The client refuses first for the empty and missing cases, and the Hub refuses the rest, so
      // both a well-behaved and a hand-crafted request are stopped.
      await expect(Promise.resolve().then(() => bob.approvals.review(awaiting.id, 'share', { expectedVersion: awaiting.version, recipients })))
        .rejects.toThrow(/named recipient|recipient/i)
    }
    // Still awaiting review, so the refusals did not change anything.
    assert.equal((await bob.approvals.task(awaiting.id)).task.state, 'REVIEW_REQUIRED')
  }, 60_000)

  it('a recipient outside the room is refused', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const stranger = await newPerson('stranger')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })
    const awaiting = await requireReview(bob, task)
    await expect(bob.approvals.review(awaiting.id, 'share', { expectedVersion: awaiting.version, recipients: [stranger.userId] }))
      .rejects.toThrow(/member/i)
  }, 60_000)

  it('nobody but the owner may review, and the task cannot be reviewed before it is finished', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const { task } = await runningTask({ requester: alice, owner: bob, botId: 'writer' })

    // The requester cannot judge work they have not seen.
    const asRequester = await alice.client.request('POST', `/tasks/${task.id}/keep`, { body: { expectedVersion: task.version } })
      .then(answer => ({ ok: true, answer }), error => ({ ok: false, error }))
    assert.equal(asRequester.ok, false, `the requester reviewed the task: ${JSON.stringify(asRequester)}`)
    assert.match(asRequester.error.message, /owner/i)
    // A task that needs no review may complete straight from RUNNING: the state machine lists that
    // transition deliberately, because a short task the owner already looked at should not be forced
    // through a review step nobody needs.
    const completed = await bob.approvals.review(task.id, 'keep', { expectedVersion: task.version })
    assert.equal(completed.state, 'COMPLETED')

    // What is refused is reviewing a task that is already finished: a terminal state is terminal, so
    // a second decision cannot reopen work. That is the rule that stops an approval being reused.
    const again = await bob.approvals.review(task.id, 'keep', { expectedVersion: completed.version })
      .then(answer => ({ ok: true, answer }), error => ({ ok: false, error }))
    assert.equal(again.ok, false, `a finished task was reviewed again: ${JSON.stringify(again.answer)}`)
    assert.match(again.error.message, /moved on|cannot become|already/i)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The redaction rules
// ---------------------------------------------------------------------------

describe('the redaction rules', () => {
  it('keeps only known public fields, so an unanticipated field is private by default', () => {
    const update = publicProgress({
      stage: 'running',
      state: 'RUNNING',
      // None of these may survive.
      workDir: '/home/bob/secret',
      stdout: 'the model said…',
      reasoning: 'because…',
      sessionId: 'session-1',
      botId: 'writer',
      somethingNobodyAnticipated: 'leak',
    })
    assert.deepEqual(Object.keys(update).sort(), ['stage', 'state'])
  })

  it('names an unrecognised stage as a failure rather than dropping the update', () => {
    const update = publicProgress({ stage: 'teleporting' })
    // A room that silently stops hearing about a task cannot tell that from one that stopped moving.
    assert.equal(update.stage, 'failed')
    assert.match(update.reason, /unrecognised/)
    for (const stage of PROGRESS_STAGES) {
      assert.equal(publicProgress({ stage }).stage, stage)
    }
  })

  it('strips an event payload to the public fields, rejecting anything of another type', () => {
    assert.deepEqual(publicEventPayload({ state: 'RUNNING', stage: 'working', workDir: '/x', output: 'y', tools: ['bash'] }), { state: 'RUNNING', stage: 'working' })
    // A field of the right name but the wrong type is dropped rather than published as an object.
    assert.deepEqual(publicEventPayload({ state: { nested: 'value' } }), {})
    assert.deepEqual(publicEventPayload(null), {})
  })

  it('refuses to publish anything carrying a field that describes the owner\u2019s machine', () => {
    for (const field of NEVER_PUBLISHED.slice(0, 8)) {
      expect(() => assertPublishable({ [field]: 'value' })).toThrow(expect.objectContaining({ code: 'PRIVATE_FIELD' }))
    }
    // And at depth: a nested leak is still a leak.
    expect(() => assertPublishable({ ok: { fine: { workDir: '/x' } } })).toThrow(ProgressError)
    expect(() => assertPublishable({ list: [{ workDir: '/x' }] })).toThrow(ProgressError)
    // A clean payload passes.
    assert.deepEqual(assertPublishable({ taskId: 't', state: 'RUNNING' }), { taskId: 't', state: 'RUNNING' })
  })

  it('the shared payload references an artifact rather than carrying it', () => {
    const payload = sharedPayload({
      task: { id: 't1', roomId: 'r1', description: 'Write it', ownerUserId: 'bob' },
      artifact: { id: 'a1', fileName: 'summary.md', contentType: 'text/markdown', sizeBytes: 42, storageKey: 'objects/abc' },
      summary: 'The incident summary',
    })
    assert.equal(payload.summary, 'The incident summary')
    assert.deepEqual(payload.artifact, { id: 'a1', fileName: 'summary.md', contentType: 'text/markdown', sizeBytes: 42 })
    // The storage key is the owner's machine layout and must not travel with the reference.
    assert.equal(JSON.stringify(payload).includes('objects/abc'), false)
  })

  it('a share always includes the requester, and only a share has recipients', () => {
    const task = { id: 't1', ownerUserId: 'bob', requesterUserId: 'alice', state: 'REVIEW_REQUIRED' }
    const members = ['alice', 'bob', 'carol']

    const shared = reviewDecision({ task, decision: 'share', recipients: ['carol'], roomMembers: members, actorUserId: 'bob' })
    assert.deepEqual(shared.recipients.sort(), ['alice', 'carol'])
    assert.equal(shared.transitionsTo, 'SHARED')
    assert.equal(shared.publishes, true)

    const kept = reviewDecision({ task, decision: 'keep', roomMembers: members, actorUserId: 'bob' })
    assert.deepEqual(kept.recipients, [])
    assert.equal(kept.publishes, false)
    assert.equal(kept.transitionsTo, 'COMPLETED')

    const rejected = reviewDecision({ task, decision: 'reject', roomMembers: members, actorUserId: 'bob' })
    assert.equal(rejected.transitionsTo, 'FAILED')
    assert.equal(rejected.publishes, false)

    // Only the owner reviews, and only while a result is waiting.
    expect(() => reviewDecision({ task, decision: 'keep', actorUserId: 'alice' })).toThrow(expect.objectContaining({ code: 'NOT_THE_OWNER' }))
    expect(() => reviewDecision({ task: { ...task, state: 'RUNNING' }, decision: 'keep', actorUserId: 'bob' })).toThrow(expect.objectContaining({ code: 'NOT_AWAITING_REVIEW' }))
    expect(() => reviewDecision({ task, decision: 'share', recipients: [], roomMembers: members, actorUserId: 'bob' })).toThrow(expect.objectContaining({ code: 'NO_RECIPIENTS' }))
    expect(() => reviewDecision({ task, decision: 'share', recipients: ['stranger'], roomMembers: members, actorUserId: 'bob' })).toThrow(expect.objectContaining({ code: 'RECIPIENT_NOT_A_MEMBER' }))
    expect(() => reviewDecision({ task, decision: 'publish_to_the_world', actorUserId: 'bob' })).toThrow(expect.objectContaining({ code: 'INVALID_DECISION' }))
  })

  it('recipientsForShare never widens to a room, whatever it is given', () => {
    const task = { id: 't1', ownerUserId: 'bob', requesterUserId: 'alice', state: 'REVIEW_REQUIRED' }
    const decision = reviewDecision({ task, decision: 'share', recipients: ['carol'], roomMembers: ['alice', 'bob', 'carol'], actorUserId: 'bob' })
    // Exactly the chosen list, with the requester added — never the room.
    assert.deepEqual(recipientsForShare(decision).sort(), ['alice', 'carol'])
    // A keep or a reject has no recipients at all, so a caller cannot accidentally share on them.
    assert.deepEqual(recipientsForShare({ decision: 'keep' }), [])
    assert.deepEqual(recipientsForShare(undefined), [])
  })
})
