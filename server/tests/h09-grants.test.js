// H-09 tests: one-time dispatch grants, replay refusal, expiry, and revocation broadcast.
//
// The completion condition is "replay refused, expiry refused", and that is exactly what the
// negative cases below drive. A grant is the last step before real work starts on the owner's
// machine, so a grant that can be used twice, used late, used from another device, or used
// after a cancellation is the failure that matters most in this whole project.
//
// Each rule gets its own case because the checks fail independently: a single "invalid grant"
// test would pass while three of the four rules were broken.

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
  mintGrant, consumeGrant, revokeGrantsForTask, nonceHashOf, findGrantByNonce, grantInternals,
} from '../src/modules/tasks/grants.js'
import { findTask } from '../src/modules/tasks/store.js'

const SIGNING_KEY = 'h09-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h09-'))
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
    return { userId: login.body.user.id, token: login.body.accessToken, deviceId: login.body.device.id }
  }
  /** A and B sharing a room, with B's Chief published and a task A has asked for. */
  const pendingTask = async (description = '请制作季度报表') => {
    const alice = await person('finance.a', '财务 A')
    const bob = await person('finance.b', '财务 B')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'public' }, bob.token)
    const asked = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: bob.userId, targetBotId: 'chief', description }, alice.token)
    assert.equal(asked.status, 201, asked.raw)
    return { alice, bob, roomId, taskId: asked.body.task.id }
  }
  /** The same, with B having approved so a grant can be minted. */
  const approvedTask = async () => {
    const scene = await pendingTask()
    const decided = await call('POST', `/tasks/${scene.taskId}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'chief',
      approvedScope: { allowedTools: ['read'], workDir: 'reports', maxRuntimeSeconds: 600 },
    }, scene.bob.token)
    assert.equal(decided.status, 200, decided.raw)
    return scene
  }
  try {
    await run({ config, db, server, call, person, pendingTask, approvedTask })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---------------------------------------------------------------- hashing

test('a nonce is never stored in readable form', () => {
  const nonce = 'wggrant_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
  const hash = nonceHashOf(nonce)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash.includes(nonce), false)
  assert.equal(nonceHashOf(nonce), hash, 'hashing must be deterministic so a grant can be found')
  assert.notEqual(nonceHashOf(`${nonce}x`), hash)
})

// ---------------------------------------------------------------- minting

test('the owner mints one grant and the Hub keeps only its hash', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    assert.equal(minted.status, 201, minted.raw)
    assert.match(minted.body.grant.nonce, /^wggrant_/)
    assert.equal(minted.body.grant.taskId, taskId)
    assert.equal(minted.body.grant.botId, 'chief')
    assert.ok(Date.parse(minted.body.grant.expiresAt) > Date.now())

    // The stored row holds the hash, not the nonce.
    const row = db.prepare('SELECT * FROM dispatch_grants WHERE task_id = ?').get(taskId)
    assert.equal(row.nonce_hash, nonceHashOf(minted.body.grant.nonce))
    assert.equal(JSON.stringify(row).includes(minted.body.grant.nonce), false)
    // And the scope was copied onto the grant, so verification needs no join.
    assert.equal(JSON.parse(row.scope_json).workDir, 'reports')
  })
})

test('a task with no approval cannot produce a grant, so approval cannot be bypassed here either', async () => {
  await withHub(async ({ pendingTask, call }) => {
    const { bob, taskId } = await pendingTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    assert.equal(minted.status, 410)
    assert.equal(minted.body.error.code, 'NO_APPROVAL')
  })
})

test('only the task owner may mint, and only for their own task', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { alice, bob, taskId } = await approvedTask()
    // Alice asked for the work; she still cannot authorise its dispatch.
    const byRequester = await call('POST', `/tasks/${taskId}/grant`, {}, alice.token)
    assert.equal(byRequester.status, 403)
    assert.equal(byRequester.body.error.code, 'NOT_TASK_OWNER')
    assert.equal((await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)).status, 201)
  })
})

test('a rejected task cannot produce a grant', async () => {
  await withHub(async ({ pendingTask, call }) => {
    const { bob, taskId } = await pendingTask()
    await call('POST', `/tasks/${taskId}/decision`, { decision: 'reject', expectedVersion: 0 }, bob.token)
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    assert.equal(minted.status, 409)
    assert.equal(minted.body.error.code, 'TASK_NOT_DISPATCHABLE')
  })
})

test('a grant asking for a longer life than its approval is clamped to the approval', async () => {
  await withHub(async ({ db, approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    // Shorten the approval directly, so the case does not race a real clock: the property
    // under test is the clamping rule, not the passage of time.
    const approvalExpiry = new Date(Date.now() + 30_000).toISOString()
    db.prepare('UPDATE approvals SET expires_at = ? WHERE task_id = ?').run(approvalExpiry, taskId)

    // A grant asking for an hour must still not outlive the approval behind it.
    const minted = await call('POST', `/tasks/${taskId}/grant`, { ttlSeconds: 3600 }, bob.token)
    assert.equal(minted.status, 201, minted.raw)
    assert.equal(minted.body.grant.expiresAt, approvalExpiry)
    assert.ok(Date.parse(minted.body.grant.expiresAt) < Date.now() + 3600 * 1000)

    // And with a long approval, the grant's own, shorter window wins.
    const longApproval = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    db.prepare('UPDATE approvals SET expires_at = ? WHERE task_id = ?').run(longApproval, taskId)
    const second = await call('POST', `/tasks/${taskId}/grant`, { ttlSeconds: 120 }, bob.token)
    assert.equal(second.status, 201, second.raw)
    const lifetime = Date.parse(second.body.grant.expiresAt) - Date.now()
    assert.ok(lifetime <= 120_000 + 2000 && lifetime > 0, `expected about 120s, got ${lifetime}ms`)
  })
})

test('an approval that has lapsed cannot mint a grant', async () => {
  await withHub(async ({ db, approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    db.prepare('UPDATE approvals SET expires_at = ? WHERE task_id = ?').run('2000-01-01T00:00:00.000Z', taskId)
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    assert.equal(minted.status, 410)
    assert.equal(minted.body.error.code, 'APPROVAL_EXPIRED')
    assert.equal(db.prepare('SELECT count(*) AS n FROM dispatch_grants WHERE task_id = ?').get(taskId).n, 0)
  })
})

// ---------------------------------------------------------------- consuming

test('a grant is consumed exactly once, and the second attempt is a refused replay', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    const nonce = minted.body.grant.nonce

    const first = await call('POST', '/dispatch/consume', { nonce, taskId }, bob.token)
    assert.equal(first.status, 200, first.raw)
    assert.equal(first.body.scope.workDir, 'reports')
    assert.equal(first.body.botId, 'chief')

    const replay = await call('POST', '/dispatch/consume', { nonce, taskId }, bob.token)
    assert.equal(replay.status, 409)
    assert.equal(replay.body.error.code, 'GRANT_ALREADY_USED')
  })
})

test('consuming moves the task to QUEUED, so "dispatched" is one fact', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { bob, taskId } = await approvedTask()
    assert.equal(findTask(db, taskId).state, 'APPROVED')
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    assert.equal(findTask(db, taskId).state, 'APPROVED', 'minting alone must not start anything')

    await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    const after = findTask(db, taskId)
    assert.equal(after.state, 'QUEUED')
    // The dispatch is visible in the room's event stream.
    const events = db.prepare('SELECT event_type FROM task_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId).map(r => r.event_type)
    assert.ok(events.includes('task.dispatched'), events.join(', '))
  })
})

test('an unknown nonce and a grant for another task are refused identically', async () => {
  await withHub(async ({ approvedTask, pendingTask, call }) => {
    const { bob, taskId } = await approvedTask()
    const other = await pendingTask('另一个请求')
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)

    const unknown = await call('POST', '/dispatch/consume', { nonce: 'wggrant_not-a-real-nonce', taskId }, bob.token)
    const wrongTask = await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId: other.taskId }, bob.token)
    assert.equal(unknown.status, 404)
    assert.equal(wrongTask.status, 404)
    // Identical responses: a captured nonce cannot be confirmed as real by probing task ids.
    assert.deepEqual(unknown.body, wrongTask.body)
    // And the original grant is still usable for its own task.
    assert.equal((await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)).status, 200)
  })
})

test('a grant is bound to the device it was minted for', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)

    // Bob logs in on a second machine and presents the same nonce.
    const elsewhere = await call('POST', '/auth/login', {
      userHandle: 'finance.b', password: 'finance.b-password-long-enough',
      fingerprint: 'sha256:finance.b-second-machine', publicKey: 'ed25519:second',
    })
    assert.equal(elsewhere.status, 200, elsewhere.raw)
    const fromOtherDevice = await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, elsewhere.body.accessToken)
    assert.equal(fromOtherDevice.status, 404)
    // The rightful device still can.
    assert.equal((await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)).status, 200)
  })
})

test('an expired grant is refused', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    // Age the grant past its window.
    db.prepare('UPDATE dispatch_grants SET expires_at = ? WHERE task_id = ?').run('2000-01-01T00:00:00.000Z', taskId)
    const stale = await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    assert.equal(stale.status, 410)
    assert.equal(stale.body.error.code, 'GRANT_EXPIRED')
  })
})

// ---------------------------------------------------------------- revocation and cancellation

test('cancelling a task makes an already-minted grant fail with a revocation code', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { alice, bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)

    const cancelled = await call('POST', `/tasks/${taskId}/cancel`, {}, alice.token)
    assert.equal(cancelled.status, 200, cancelled.raw)
    // The version bump reached the grant: this is how a cancellation stops a machine the Hub
    // cannot address.
    const consumed = await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    assert.equal(consumed.status, 409)
    assert.equal(consumed.body.error.code, 'GRANT_REVOKED')
  })
})

test('cancelling marks outstanding grants explicitly, so the table agrees with the executor', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { alice, bob, taskId } = await approvedTask()
    await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    const before = db.prepare('SELECT revoked_at FROM dispatch_grants WHERE task_id = ?').get(taskId)
    assert.equal(before.revoked_at, null)

    await call('POST', `/tasks/${taskId}/cancel`, {}, alice.token)
    const after = db.prepare('SELECT revoked_at FROM dispatch_grants WHERE task_id = ?').get(taskId)
    // The version bump alone would make the grant fail; marking it makes the table itself
    // state the same conclusion, so an operator does not have to compare versions by hand.
    assert.ok(after.revoked_at !== null, 'cancellation must mark the grant revoked')
  })
})

test('the owner can revoke grants without cancelling the task', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    const revoked = await call('POST', `/tasks/${taskId}/grants/revoke`, {}, bob.token)
    assert.equal(revoked.status, 200, revoked.raw)
    assert.equal(revoked.body.revoked, 1)
    const consumed = await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    assert.equal(consumed.status, 409)
    assert.equal(consumed.body.error.code, 'GRANT_REVOKED')
  })
})

test('a room admin may revoke grants, and a stranger may not', async () => {
  await withHub(async ({ approvedTask, call, person }) => {
    const { alice, bob, taskId } = await approvedTask()
    const stranger = await person('stranger', 'Stranger')
    assert.equal((await call('POST', `/tasks/${taskId}/grants/revoke`, {}, stranger.token)).status, 403)
    // Alice owns the room, so she may stop the dispatch even though Bob owns the task.
    assert.equal((await call('POST', `/tasks/${taskId}/grants/revoke`, {}, alice.token)).status, 200)
    assert.equal((await call('POST', `/tasks/${taskId}/grants/revoke`, {}, bob.token)).status, 200)
  })
})

// ---------------------------------------------------------------- inspection

test('only the owner sees the grants for a task', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { alice, bob, taskId } = await approvedTask()
    await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)

    const mine = await call('GET', `/tasks/${taskId}/grants`, undefined, bob.token)
    assert.equal(mine.status, 200)
    assert.equal(mine.body.grants.length, 1)
    assert.equal(mine.body.grants[0].consumedAt, null)
    // The inspection never returns a usable nonce.
    assert.equal(mine.raw.includes('wggrant_'), false)

    const theirs = await call('GET', `/tasks/${taskId}/grants`, undefined, alice.token)
    assert.equal(theirs.status, 403)
  })
})

test('a non-member cannot inspect grants, and cannot tell a real task from an invented one', async () => {
  await withHub(async ({ approvedTask, call, person }) => {
    const { taskId } = await approvedTask()
    const stranger = await person('stranger', 'Stranger')
    const real = await call('GET', `/tasks/${taskId}/grants`, undefined, stranger.token)
    const invented = await call('GET', '/tasks/00000000-0000-4000-8000-000000000000/grants', undefined, stranger.token)
    assert.equal(real.status, 404)
    assert.equal(invented.status, 404)
    assert.deepEqual(real.body, invented.body)
  })
})

// ---------------------------------------------------------------- store-level guarantees

test('the store refuses minting for another owner, even called directly', async () => {
  await withHub(async ({ db, approvedTask }) => {
    const { alice, bob, taskId } = await approvedTask()
    assert.throws(() => mintGrant(db, { taskId, ownerUserId: alice.userId, ownerDeviceId: 'x' }), /Only the task owner/)
    // Nothing was written for the refused attempt.
    assert.equal(db.prepare('SELECT count(*) AS n FROM dispatch_grants WHERE task_id = ?').get(taskId).n, 0)
    assert.equal(mintGrant(db, { taskId, ownerUserId: bob.userId, ownerDeviceId: bob.deviceId }).nonce.startsWith('wggrant_'), true)
  })
})

test('two concurrent consumptions of one grant produce exactly one dispatch', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)))
    assert.equal(results.filter(r => r.status === 200).length, 1, results.map(r => r.status).join(','))
    assert.equal(results.filter(r => r.status === 409).length, 7)
    const row = db.prepare('SELECT consumed_at FROM dispatch_grants WHERE task_id = ?').get(taskId)
    assert.ok(row.consumed_at !== null)
  })
})

test('a consumed grant cannot be renewed, so a finished dispatch cannot be extended', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    // The task is now QUEUED, and a second mint for the same task must not silently be
    // refused by the state check alone: the contract is that one approval backs the dispatch.
    const second = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    // Minting from QUEUED is allowed (a retry after a crashed executor needs it), but the
    // consumed grant stays consumed.
    assert.equal(second.status, 201, second.raw)
    assert.equal((await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)).status, 409)
    assert.equal(findGrantByNonce(db, minted.body.grant.nonce).consumed_at !== null, true)
  })
})

test('grant refusals are audited, including a refused replay', async () => {
  await withHub(async ({ approvedTask, call, db }) => {
    const { alice, bob, taskId } = await approvedTask()
    const minted = await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)
    await call('POST', '/dispatch/consume', { nonce: minted.body.grant.nonce, taskId }, bob.token)

    const rows = db.prepare("SELECT event_type, outcome FROM audit_events WHERE object_type = 'dispatch_grant' ORDER BY occurred_at, rowid").all()
    const types = rows.map(r => r.event_type)
    assert.ok(types.includes('grant.minted'), types.join(', '))
    assert.ok(types.includes('grant.consumed'), types.join(', '))
    // A replay is recorded as a refusal: it is evidence of a relayed or retried grant, which
    // an operator needs to see.
    const replay = rows.find(r => r.event_type === 'grant.replay_refused')
    assert.ok(replay !== undefined, types.join(', '))
    assert.equal(replay.outcome, 'refused')
  })
})

test('the grant wire shape never carries the nonce hash or the scope', async () => {
  await withHub(async ({ approvedTask, call }) => {
    const { bob, taskId } = await approvedTask()
    await call('POST', `/tasks/${taskId}/grant`, {}, bob.token)
    const listed = await call('GET', `/tasks/${taskId}/grants`, undefined, bob.token)
    assert.deepEqual(Object.keys(listed.body.grants[0]).sort(), [
      'botId', 'consumedAt', 'expiresAt', 'id', 'issuedAt', 'revocationVersion', 'revokedAt', 'taskId',
    ])
  })
})
