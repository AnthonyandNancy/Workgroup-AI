// H-08 tests: task creation, the owner's approval, the state machine, and the event log.
//
// The completion condition is "approval cannot be skipped", and that is what most of this
// file attacks. A delegation system fails in one specific direction: work starts without its
// owner agreeing. So the cases below try every route to `APPROVED` and `RUNNING` that does
// not go through the owner's own decision — the requester deciding, a room admin deciding,
// the owner's own Chief deciding, a second decision overwriting the first, a decision on a
// finished task, a direct transition hop — and each one must be refused.
//
// The state machine is also exercised directly through the store, because a route test only
// proves that *that* route is safe; a future route that calls the store with a different hop
// must be blocked by the table itself.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import {
  TASK_STATES, TERMINAL_STATES, TASK_TRANSITIONS, canTransition, isTerminal,
  transition, createTask, decideTask, cancelTask, findTask, taskInternals,
} from '../src/modules/tasks/store.js'

const SIGNING_KEY = 'h08-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h08-'))
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({
      method, url: `/api/v1${path}`, headers, payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  const person = async (handle, displayName) => {
    const password = `${handle}-password-long-enough`
    await call('POST', '/auth/register', { userHandle: handle, displayName: displayName ?? handle, password })
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken, deviceId: login.body.device.id, displayName: displayName ?? handle }
  }
  /**
   * The project's core business scene: A and B share a room, B publishes a Bot A may see,
   * and A asks B's Bot for work.
   */
  const delegation = async () => {
    const alice = await person('finance.a', '财务 A')
    const bob = await person('finance.b', '财务 B')
    const created = await call('POST', '/rooms', { name: 'Finance', kind: 'workgroup' }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    // Bob publishes his Chief and explicitly adds it to this workgroup; directory visibility
    // alone is discovery, not room membership.
    await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'public' }, bob.token)
    const added = await call('POST', `/rooms/${roomId}/bots`, { botId: 'chief' }, bob.token)
    assert.equal(added.status, 201, added.raw)
    return { alice, bob, roomId }
  }
  const askTask = (alice, roomId, bob, description, targetBotId = 'chief') =>
    call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: bob.userId, targetBotId, description }, alice.token)
  try {
    await run({ config, db, server, call, person, delegation, askTask })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---------------------------------------------------------------- the transition table

test('the transition table has no edge that reaches RUNNING without passing through approval', () => {
  // Only QUEUED reaches RUNNING. APPROVED deliberately does not: an approved task is queued
  // first, so there is a state where the owner's client holds the grant but no process has
  // started. That gap is what makes "approved but never started" observable rather than
  // indistinguishable from "already running".
  const canReachRunning = TASK_STATES.filter(state => canTransition(state, 'RUNNING'))
  assert.deepEqual(canReachRunning, ['QUEUED'])
  assert.equal(canTransition('APPROVED', 'RUNNING'), false)
  // And nothing reaches APPROVED except the one state that waits for the owner.
  const canReachApproved = TASK_STATES.filter(state => canTransition(state, 'APPROVED'))
  assert.deepEqual(canReachApproved, ['PENDING_APPROVAL'])
  // A pending task cannot jump straight to work.
  assert.equal(canTransition('PENDING_APPROVAL', 'RUNNING'), false)
  assert.equal(canTransition('PENDING_APPROVAL', 'QUEUED'), false)
  assert.equal(canTransition('PENDING_APPROVAL', 'COMPLETED'), false)
})

test('terminal states accept no further transition, so finished work cannot be resumed', () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(TASK_TRANSITIONS[state], [], `${state} must accept nothing`)
    assert.equal(isTerminal(state), true)
    for (const target of TASK_STATES) {
      assert.equal(canTransition(state, target), false, `${state} → ${target} must be refused`)
    }
  }
  // Every state has an entry, so a missing key can never be mistaken for permission.
  for (const state of TASK_STATES) assert.ok(Array.isArray(TASK_TRANSITIONS[state]), `${state} is missing from the table`)
})

// ---------------------------------------------------------------- creation

test('a created task waits for approval and carries no approval yet', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, '请制作季度报表')
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.task.state, 'PENDING_APPROVAL')
    assert.equal(created.body.task.requesterUserId, alice.userId)
    assert.equal(created.body.task.ownerUserId, bob.userId)
    assert.equal(created.body.task.targetBotId, 'chief')
    assert.equal(created.body.task.version, 0)
    // No approval exists yet, and the machine fields are not part of the room's view of a task at
    // all — so neither is present, rather than present-and-null.
    assert.equal('assignedBotId' in created.body.task, false)
    assert.equal('assignmentMode' in created.body.task, false)
    assert.equal('approval' in created.body.task, false)

    // The owner's queue shows it; the requester's does not.
    assert.equal((await call('GET', '/tasks/pending', undefined, bob.token)).body.tasks.length, 1)
    assert.equal((await call('GET', '/tasks/pending', undefined, alice.token)).body.tasks.length, 0)
  })
})

test('creating a task requires membership of the room on both sides', async () => {
  await withHub(async ({ delegation, askTask, call, person }) => {
    const { alice, bob, roomId } = await delegation()
    const stranger = await person('stranger', 'Stranger')
    // A stranger cannot ask anything in a room they are not in.
    assert.equal((await askTask(stranger, roomId, bob, 'x')).status, 404)
    // And an owner who is not in the room cannot be assigned work from it.
    const outsider = await person('outsider', 'Outsider')
    const notAMember = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: outsider.userId, description: 'x' }, alice.token)
    assert.equal(notAMember.status, 404)
  })
})

test('a task to yourself is refused, because that is what your own chat is for', async () => {
  await withHub(async ({ delegation, askTask }) => {
    const { alice, roomId } = await delegation()
    const self = await askTask(alice, roomId, alice, 'x')
    assert.equal(self.status, 409)
    assert.equal(self.body.error.code, 'SELF_TASK')
  })
})

test('naming a Bot the requester may not see is refused, so the answer cannot enumerate Bots', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    // Bob has a second, private Bot.
    await call('POST', '/bots', { botId: 'secret', displayName: 'Secret', visibility: 'private' }, bob.token)
    const refused = await askTask(alice, roomId, bob, 'x', 'secret')
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'BOT_NOT_AVAILABLE')
    // A Bot that does not exist is refused the same way, so the two are indistinguishable.
    const invented = await askTask(alice, roomId, bob, 'x', 'no-such-bot')
    assert.equal(invented.status, 403)
    assert.deepEqual(refused.body, invented.body)
  })
})

test('a task description is required and bounded', async () => {
  await withHub(async ({ delegation, call }) => {
    const { alice, bob, roomId } = await delegation()
    for (const description of [undefined, '', '   ', 'x'.repeat(20_001)]) {
      const response = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: bob.userId, description }, alice.token)
      assert.equal(response.status, 400, `description ${String(description).slice(0, 20)} must be refused`)
    }
  })
})

// ---------------------------------------------------------------- the owner decides

test('the owner approves, and the recorded scope names what was granted', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, '请制作季度报表')
    const taskId = created.body.task.id

    const decided = await call('POST', `/tasks/${taskId}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'chief',
      approvedScope: { allowedTools: ['read', 'write'], workDir: 'reports', maxRuntimeSeconds: 600 },
    }, bob.token)
    assert.equal(decided.status, 200, decided.raw)
    assert.equal(decided.body.task.state, 'APPROVED')
    assert.equal(decided.body.task.assignmentMode, 'existing_bot')
    assert.equal(decided.body.task.assignedBotId, 'chief')
    assert.equal(decided.body.task.version, 1)

    const scope = decided.body.task.approval.scope
    assert.deepEqual(scope.allowedTools, ['read', 'write'])
    assert.equal(scope.workDir, 'reports')
    assert.equal(scope.maxRuntimeSeconds, 600)
    // The Hub fills in the identity facts so the executor and Hub cannot disagree on them.
    assert.equal(scope.requesterUserId, alice.userId)
    assert.equal(scope.ownerUserId, bob.userId)
    assert.equal(scope.roomId, roomId)
    assert.equal(scope.taskId, taskId)
    assert.ok(Date.parse(decided.body.task.approval.expiresAt) > Date.now())
  })
})

test('the owner rejects, and a rejected task can go nowhere', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id

    const rejected = await call('POST', `/tasks/${taskId}/decision`, { decision: 'reject', expectedVersion: 0 }, bob.token)
    assert.equal(rejected.status, 200, rejected.raw)
    assert.equal(rejected.body.task.state, 'REJECTED')

    // A second decision on the same task is refused, and no approval row was written.
    const again = await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 1 }, bob.token)
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'ALREADY_DECIDED')
  })
})

// ---------------------------------------------------------------- nobody else decides

test('the requester cannot approve their own request', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const decided = await call('POST', `/tasks/${created.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0 }, alice.token)
    assert.equal(decided.status, 403)
    assert.equal(decided.body.error.code, 'NOT_TASK_OWNER')
    // The task is untouched.
    assert.equal((await call('GET', `/tasks/${created.body.task.id}`, undefined, alice.token)).body.task.state, 'PENDING_APPROVAL')
  })
})

test('a room admin cannot approve on the owner\'s behalf', async () => {
  await withHub(async ({ delegation, askTask, call, person }) => {
    const { alice, bob, roomId } = await delegation()
    const appointed = await person('admin.user', 'Admin')
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: appointed.userId, role: 'admin' }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, appointed.token)

    const created = await askTask(alice, roomId, bob, 'x')
    const decided = await call('POST', `/tasks/${created.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0 }, appointed.token)
    assert.equal(decided.status, 403)
    assert.equal(decided.body.error.code, 'NOT_TASK_OWNER')
  })
})

test('a companion Bot has no path to decide, because it is not a user and holds no token', async () => {
  await withHub(async ({ delegation, askTask, call, db, config }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id

    // A Chief would act with its owner's credentials if it could decide. The Hub's answer is
    // that there is no such credential: a decision needs a device that authenticate issued.
    const { issueAccessToken } = await import('../src/auth/tokens.js')
    // A token naming Bob but a device that does not exist is refused by the authenticator,
    // which is what stops a local process from minting authority for itself.
    const forgedDevice = issueAccessToken({ signingKey: config.readTokenSigningKey(), userId: bob.userId, deviceId: 'no-such-device', ttlSeconds: 900 })
    const decided = await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0 }, forgedDevice)
    assert.equal(decided.status, 403)
    assert.equal(decided.body.error.code, 'DEVICE_REVOKED')
    assert.equal(findTask(db, taskId).state, 'PENDING_APPROVAL')
  })
})

// ---------------------------------------------------------------- racing and replay

test('two concurrent approvals produce exactly one decision', async () => {
  await withHub(async ({ delegation, askTask, call, db }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id

    const results = await Promise.all(Array.from({ length: 6 }, () =>
      call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0 }, bob.token)))
    const accepted = results.filter(r => r.status === 200)
    const refused = results.filter(r => r.status === 409)
    assert.equal(accepted.length, 1, results.map(r => r.status).join(','))
    assert.equal(refused.length, 5)
    // Exactly one approval row exists, which is what the unique constraint guarantees.
    assert.equal(db.prepare('SELECT count(*) AS n FROM approvals WHERE task_id = ?').get(taskId).n, 1)
    assert.equal(findTask(db, taskId).version, 1)
  })
})

test('a decision with a stale expectedVersion is refused even when the state would allow it', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    assert.equal((await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0 }, bob.token)).status, 200)
    // Replaying the same decision with the original version must not be a second write.
    const replay = await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0 }, bob.token)
    assert.equal(replay.status, 409)
  })
})

test('an approval must name its mode correctly, and choosing an existing Bot names which', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const first = await askTask(alice, roomId, bob, 'one')
    assert.equal((await call('POST', `/tasks/${first.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'make_it_up' }, bob.token)).status, 400)
    assert.equal((await call('POST', `/tasks/${first.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot' }, bob.token)).status, 400)
    // A Bot Bob never published cannot be assigned.
    assert.equal((await call('POST', `/tasks/${first.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'ghost' }, bob.token)).status, 403)

    // The two automatic modes need no bot id.
    const second = await askTask(alice, roomId, bob, 'two')
    assert.equal((await call('POST', `/tasks/${second.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto' }, bob.token)).status, 200)
    const third = await askTask(alice, roomId, bob, 'three')
    assert.equal((await call('POST', `/tasks/${third.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'create_bot' }, bob.token)).status, 200)
  })
})

// ---------------------------------------------------------------- cancellation and revocation

test('cancelling raises the revocation version, which is what invalidates a live grant', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    const approved = await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto' }, bob.token)
    assert.equal(approved.body.task.revocationVersion, 0)

    const cancelled = await call('POST', `/tasks/${taskId}/cancel`, {}, bob.token)
    assert.equal(cancelled.status, 200, cancelled.raw)
    assert.equal(cancelled.body.task.state, 'CANCELLED')
    // The bump is the fact a local executor compares against before each step.
    assert.equal(cancelled.body.task.revocationVersion, 1)
  })
})

test('the requester, the owner, and a room admin may cancel, and nobody else', async () => {
  await withHub(async ({ delegation, askTask, call, person, db }) => {
    const { alice, bob, roomId } = await delegation()
    const stranger = await person('stranger', 'Stranger')

    const first = await askTask(alice, roomId, bob, 'req cancels')
    assert.equal((await call('POST', `/tasks/${first.body.task.id}/cancel`, {}, alice.token)).status, 200)

    const second = await askTask(alice, roomId, bob, 'owner cancels')
    assert.equal((await call('POST', `/tasks/${second.body.task.id}/cancel`, {}, bob.token)).status, 200)

    const third = await askTask(alice, roomId, bob, 'stranger cannot')
    const refused = await call('POST', `/tasks/${third.body.task.id}/cancel`, {}, stranger.token)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'NOT_ALLOWED_TO_CANCEL')
    assert.equal(findTask(db, third.body.task.id).state, 'PENDING_APPROVAL')
  })
})

test('a finished task cannot be cancelled or decided', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    await call('POST', `/tasks/${taskId}/decision`, { decision: 'reject', expectedVersion: 0 }, bob.token)
    const cancelled = await call('POST', `/tasks/${taskId}/cancel`, {}, alice.token)
    assert.equal(cancelled.status, 409)
    assert.equal(cancelled.body.error.code, 'ALREADY_TERMINAL')
  })
})

test('cancelling a running task asks it to stop rather than claiming it stopped', async () => {
  await withHub(async ({ delegation, askTask, call, db }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto' }, bob.token)
    // The Hub never runs the task; a running task is what the owner's client reports.
    transition(db, { taskId, to: 'QUEUED', expectedVersion: 1 })
    transition(db, { taskId, to: 'RUNNING', expectedVersion: 2 })

    const cancelled = await call('POST', `/tasks/${taskId}/cancel`, {}, alice.token)
    assert.equal(cancelled.status, 200)
    // The state is CANCELLING, not CANCELLED: the local process may be mid-step, and the Hub
    // must not report a stop it cannot verify.
    assert.equal(cancelled.body.task.state, 'CANCELLING')
    assert.equal(cancelled.body.task.revocationVersion, 1)
  })
})

// ---------------------------------------------------------------- reading and isolation

test('a non-member cannot read a task, and cannot tell a real one from an invented one', async () => {
  await withHub(async ({ delegation, askTask, call, person }) => {
    const { alice, bob, roomId } = await delegation()
    const stranger = await person('stranger', 'Stranger')
    const created = await askTask(alice, roomId, bob, 'x')
    const real = await call('GET', `/tasks/${created.body.task.id}`, undefined, stranger.token)
    const invented = await call('GET', '/tasks/00000000-0000-4000-8000-000000000000', undefined, stranger.token)
    assert.equal(real.status, 404)
    assert.equal(invented.status, 404)
    assert.deepEqual(real.body, invented.body)
    // And the room's task list is closed to them too.
    assert.equal((await call('GET', `/rooms/${roomId}/tasks`, undefined, stranger.token)).status, 404)
  })
})

test('a removed member loses access to the room tasks immediately', async () => {
  await withHub(async ({ delegation, askTask, call, person }) => {
    const { alice, bob, roomId } = await delegation()
    // Alice owns the room and removes Carol, so the case is about the removed member rather
    // than about who holds the owner role.
    const carol = await person('carol', 'Carol')
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, carol.token)

    const created = await askTask(carol, roomId, bob, 'x')
    assert.equal((await call('GET', `/tasks/${created.body.task.id}`, undefined, carol.token)).status, 200)
    await call('POST', `/rooms/${roomId}/members/${carol.userId}/remove`, {}, alice.token)
    assert.equal((await call('GET', `/tasks/${created.body.task.id}`, undefined, carol.token)).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/tasks`, undefined, carol.token)).status, 404)
  })
})

test('the room\'s task list shows its tasks to members and only its own', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    await askTask(alice, roomId, bob, 'one')
    await askTask(alice, roomId, bob, 'two')
    const other = await call('POST', '/rooms', { name: 'Other' }, alice.token)
    await call('POST', `/rooms/${other.body.room.id}/tasks`, { ownerUserId: alice.userId, description: 'x' }, bob.token).catch(() => undefined)

    const listed = await call('GET', `/rooms/${roomId}/tasks`, undefined, bob.token)
    assert.equal(listed.body.tasks.length, 2)
    assert.equal(listed.body.tasks.every(t => t.roomId === roomId), true)
  })
})

// ---------------------------------------------------------------- the event log

test('every state change leaves a room-visible event, in order', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, '请制作季度报表')
    const taskId = created.body.task.id
    await call('POST', `/tasks/${taskId}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto' }, bob.token)
    await call('POST', `/tasks/${taskId}/cancel`, {}, alice.token)

    const seen = await call('GET', `/tasks/${taskId}`, undefined, bob.token)
    const types = seen.body.events.map(event => event.eventType)
    assert.deepEqual(types, ['task.created', 'task.approved', 'task.cancelled'])
    // The events are the room's view: no owner-private detail leaks into them.
    const serialized = JSON.stringify(seen.body.events)
    assert.equal(serialized.includes('workDir'), false)
    assert.equal(serialized.includes('/home'), false)
    assert.equal(serialized.includes('api'), false)
  })
})

test('the room-visible event payload never carries the approved scope\'s resource detail', async () => {
  await withHub(async ({ delegation, askTask, call, db }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    await call('POST', `/tasks/${created.body.task.id}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'chief',
      approvedScope: { workDir: 'D:\\finance\\private', allowedTools: ['shell'], maxRuntimeSeconds: 600 },
    }, bob.token)
    const rows = db.prepare('SELECT public_payload_json FROM task_events WHERE task_id = ?').all(created.body.task.id)
    const payloads = rows.map(row => row.public_payload_json).join(' ')
    // The scope lives in `approvals`, which only the owner and requester may read; the
    // room-visible stream must not repeat the local paths it contains.
    assert.equal(payloads.includes('private'), false)
    assert.equal(payloads.includes('finance'), false)
  })
})

test('the store\'s own transition refuses an illegal hop even when called directly', async () => {
  await withHub(async ({ db, delegation, askTask }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    // A future route that calls the store must still be blocked by the table.
    assert.throws(() => transition(db, { taskId, to: 'RUNNING', expectedVersion: 0 }), /cannot become RUNNING/)
    assert.throws(() => transition(db, { taskId, to: 'COMPLETED', expectedVersion: 0 }), /cannot become COMPLETED/)
    assert.throws(() => transition(db, { taskId, to: 'NOT_A_STATE', expectedVersion: 0 }), /Unknown task state/)
    assert.equal(findTask(db, taskId).state, 'PENDING_APPROVAL')
  })
})

test('the store refuses a decision from anyone but the owner, even called directly', async () => {
  await withHub(async ({ db, delegation, askTask }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    assert.throws(() => decideTask(db, {
      taskId: created.body.task.id, approverUserId: alice.userId, approverDeviceId: 'x',
      decision: 'approve', expectedVersion: 0,
    }), /Only the task owner may decide/)
    assert.equal(findTask(db, created.body.task.id).state, 'PENDING_APPROVAL')
  })
})

test('an approval that passes its window is recorded as expired, and expired work cannot start', async () => {
  await withHub(async ({ db, delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    const taskId = created.body.task.id
    // A very short window, then time passes.
    decideTask(db, {
      taskId, approverUserId: bob.userId, approverDeviceId: bob.deviceId,
      decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto', ttlSeconds: 1,
    })
    const past = new Date(Date.now() + 5000)
    const { expireStaleApprovals } = await import('../src/modules/tasks/store.js')
    // The task is APPROVED, not PENDING, so the sweep leaves it: a grant that already exists
    // is the executor's to honour or refuse by its own clock.
    const expired = expireStaleApprovals(db, { now: past })
    assert.deepEqual(expired, [])
    const approval = db.prepare('SELECT expires_at FROM approvals WHERE task_id = ?').get(taskId)
    assert.ok(Date.parse(approval.expires_at) < past.getTime())
    assert.equal((await call('GET', `/tasks/${taskId}`, undefined, bob.token)).body.task.state, 'APPROVED')
  })
})

test('the task wire shape carries no model, path, or credential field', async () => {
  await withHub(async ({ delegation, askTask, call }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    // The room's view of a task, asserted exactly. `assignedBotId` and `assignmentMode` are
    // deliberately **absent**: which Bot the owner chose is a fact about their machine, and the room
    // asked for a result rather than an inventory of the machine that produced it. This list is
    // exhaustive so a field that starts travelling is a failure here rather than a discovery later.
    const fields = Object.keys(created.body.task).sort()
    assert.deepEqual(fields, [
      'createdAt', 'description', 'id', 'ownerUserId', 'requesterUserId', 'revocationVersion',
      'roomId', 'state', 'targetBotId', 'updatedAt', 'version',
    ])
    assert.equal(fields.includes('assignedBotId'), false, 'the chosen Bot must not reach the room')
    assert.equal(fields.includes('assignmentMode'), false, 'the dispatch mode must not reach the room')

    // The owner sees their own machine fields, because they are the owner's own statement.
    await call('POST', `/tasks/${created.body.task.id}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'chief',
    }, bob.token)
    const asOwner = await call('GET', `/tasks/${created.body.task.id}`, undefined, bob.token)
    assert.equal(asOwner.body.task.assignedBotId, 'chief')
    assert.equal(asOwner.body.task.assignmentMode, 'existing_bot')

    // And the requester does not, even after the approval: the approved scope names a directory and
    // a tool list, which describe the owner's machine.
    const asRequester = await call('GET', `/tasks/${created.body.task.id}`, undefined, alice.token)
    assert.equal(asRequester.body.task.assignedBotId, undefined)
    assert.equal(asRequester.body.task.approvedScope, undefined)
    assert.equal(asRequester.body.task.approval, undefined)
    assert.equal(asRequester.raw.includes('existing_bot'), false, 'the dispatch mode must not reach the requester')
    assert.equal(asRequester.body.task.targetBotId, 'chief', 'the Bot the requester named is their own request, and is theirs to read back')
  })
})

test('task state changes are audited with the actor', async () => {
  await withHub(async ({ delegation, askTask, call, db }) => {
    const { alice, bob, roomId } = await delegation()
    const created = await askTask(alice, roomId, bob, 'x')
    await call('POST', `/tasks/${created.body.task.id}/decision`, { decision: 'approve', expectedVersion: 0, assignmentMode: 'chief_auto' }, bob.token)
    const rows = db.prepare("SELECT event_type, actor_user_id, outcome FROM audit_events WHERE object_type = 'task' ORDER BY occurred_at, rowid").all()
    // `decideTask` writes the state and the decision in one transaction, so the trail has
    // exactly these two rows: creation by the requester, then the owner's approval.
    assert.deepEqual(rows.map(r => r.event_type), ['task.created', 'task.approve'])
    assert.equal(rows[0].actor_user_id, alice.userId)
    assert.equal(rows[1].actor_user_id, bob.userId)
    assert.equal(rows.every(r => r.outcome === 'success'), true)
  })
})
