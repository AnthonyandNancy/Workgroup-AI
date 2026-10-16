// D: dissolving a workgroup, as distinct from leaving it or being removed from it.
//
// The requirement separates three operations that a room UI otherwise tends to collapse into one:
//
//   * **dissolve** — the owner ends the workgroup itself. It cannot be chatted in or receive new
//     tasks afterwards, and the dissolution is announced to everyone online.
//   * **leave** — a member walks away; the workgroup carries on without them.
//   * **remove** — an admin takes somebody out; the workgroup carries on without them.
//
// The cases below exist because the cheapest implementation of "dissolve" is a `DELETE`, and that is
// the one the requirement rules out: history and audit are kept, so the dissolution is a **state the
// room enters**, not the disappearance of a row. A cascade would also take messages, tasks, artifacts,
// and memory with it, which is precisely the uncontrolled deletion the requirement forbids.
//
// Two more properties are asserted, both of which are easy to omit and expensive to add later:
//
//   * pending invitations are withdrawn, because an invitation into a dissolved workgroup would
//     otherwise let somebody join a room that no longer exists as a collaboration.
//   * tasks that have not finished are cancelled, because an approval that outlives the workgroup
//     could still start local work for a room that is gone.
//
// Only the owner may dissolve. An admin can remove a member; nobody but the owner ends the room.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'd-dissolve-test-signing-key-long-enough'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-d-'))
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
  const person = async handle => {
    const password = `${handle}-password-long-enough`
    const registered = await call('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
    assert.equal(registered.status, 201, registered.raw)
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: 'ed25519:AAAA', label: `${handle} laptop`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  try {
    await run({ config, db, server, call, person })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** A workgroup with one owner and one invited member, plus a message and a pending task. */
async function workgroupWithActivity(call, person) {
  const alice = await person('d-alice')
  const bob = await person('d-bob')
  const room = await call('POST', '/rooms', { name: 'Dissolve me', kind: 'workgroup' }, alice.token)
  assert.equal(room.status, 201, room.raw)
  const roomId = room.body.room.id

  await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
  const pending = await call('GET', '/invitations', undefined, bob.token)
  await call('POST', `/invitations/${pending.body.invitations[0].id}/accept`, {}, bob.token)
  // `clientMessageId` is the idempotency key the contract requires; a message without one is refused,
  // which is why this fixture supplies it like a real client would.
  await call('POST', `/rooms/${roomId}/messages`, { body: 'before the end', clientMessageId: 'd-dissolve-msg-0001' }, bob.token)

  // A third person invited but not yet joined: their invitation must not survive dissolution.
  const carol = await person('d-carol')
  await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
  return { alice, bob, carol, roomId }
}

test('only the owner may dissolve a workgroup', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)

    // An ordinary member: refused, and told what they can do instead.
    const byMember = await call('POST', `/rooms/${roomId}/dissolve`, {}, bob.token)
    assert.equal(byMember.status, 403, byMember.raw)

    // An admin is still not the owner. Promotion is checked because it is the nearest miss: an admin
    // can remove a member, so "admin can dissolve" would look consistent and be wrong.
    const promoted = await call('POST', `/rooms/${roomId}/members/${bob.userId}/role`, { role: 'admin' }, alice.token)
    assert.equal(promoted.status, 200, promoted.raw)
    const byAdmin = await call('POST', `/rooms/${roomId}/dissolve`, {}, bob.token)
    assert.equal(byAdmin.status, 403, byAdmin.raw)

    const byOwner = await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
    assert.equal(byOwner.status, 200, byOwner.raw)
    assert.equal(byOwner.body.room.dissolvedAt !== undefined, true, 'the answer must carry the dissolution')
  })
})

test('a non-member cannot dissolve a room they cannot even see', async () => {
  await withHub(async ({ call, person }) => {
    const { roomId } = await workgroupWithActivity(call, person)
    const outsider = await person('d-outsider')
    // 404, the same answer an unknown room gets: a guessed id must not be confirmed as existing.
    const refused = await call('POST', `/rooms/${roomId}/dissolve`, {}, outsider.token)
    assert.equal(refused.status, 404, refused.raw)
  })
})

test('a dissolved workgroup keeps its history and its audit trail', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, roomId } = await workgroupWithActivity(call, person)
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?').get(roomId).n
    assert.ok(before > 0)

    const dissolved = await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
    assert.equal(dissolved.status, 200, dissolved.raw)

    // The requirement forbids uncontrolled physical deletion, so the row is still there, messages and
    // all. A `DELETE FROM rooms` would have cascaded the messages away and this count would be zero.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE id = ?').get(roomId).n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?').get(roomId).n, before)
    const audited = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'room.dissolved' AND object_id = ?").get(roomId).n
    assert.equal(audited, 1, 'the dissolution is an audited event')
  })
})

test('a dissolved workgroup refuses new messages and new tasks', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)
    // Bob publishes a Bot so a task could otherwise be requested.
    await call('POST', '/bots', { botId: 'd-bot', displayName: 'Helper', description: 'd', capabilities: ['search'], visibility: 'room' }, bob.token)
    await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)

    const message = await call('POST', `/rooms/${roomId}/messages`, { body: 'anyone there?', clientMessageId: 'd-dissolve-msg-0003' }, bob.token)
    assert.ok(message.status >= 400, `expected a refusal, got ${String(message.status)}: ${message.raw}`)

    const task = await call('POST', `/rooms/${roomId}/tasks`, {
      targetBotId: 'd-bot', ownerUserId: bob.userId, description: 'after the end',
    }, alice.token)
    assert.ok(task.status >= 400, `expected a refusal, got ${String(task.status)}: ${task.raw}`)
  })
})

test('dissolving withdraws pending invitations, so nobody joins a workgroup that has ended', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, carol, roomId } = await workgroupWithActivity(call, person)
    const pendingBefore = db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE room_id = ? AND status = 'pending'").get(roomId).n
    assert.equal(pendingBefore, 1, 'carol was invited and has not answered')

    await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)

    const pendingAfter = db.prepare("SELECT COUNT(*) AS n FROM invitations WHERE room_id = ? AND status = 'pending'").get(roomId).n
    assert.equal(pendingAfter, 0)
    // And the invited person cannot accept it afterwards.
    const invitations = await call('GET', '/invitations', undefined, carol.token)
    const stillListed = (invitations.body.invitations ?? []).filter(entry => entry.roomId === roomId)
    assert.equal(stillListed.length, 0)
  })
})

test('dissolving cancels unfinished tasks, because an approval must not outlive its workgroup', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)
    await call('POST', '/bots', { botId: 'd-bot2', displayName: 'Helper', description: 'd', capabilities: ['search'], visibility: 'room' }, bob.token)
    const task = await call('POST', `/rooms/${roomId}/tasks`, {
      targetBotId: 'd-bot2', ownerUserId: bob.userId, description: 'pending when the room ends',
    }, alice.token)
    assert.equal(task.status, 201, task.raw)

    await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)

    const row = db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.body.task.id)
    assert.equal(row.state, 'CANCELLED', 'an unfinished task is cancelled, not left approvable')
  })
})

test('a dissolved workgroup stays visible read-only, and says that it ended', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)
    await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)

    // Readable: the room is how a member finds out what happened, and reading it is not a
    // collaboration. This is why dissolution is a state rather than a delete.
    const read = await call('GET', `/rooms/${roomId}`, undefined, bob.token)
    assert.equal(read.status, 200, read.raw)
    assert.ok(read.body.room.dissolvedAt !== undefined, 'the state is reported to whoever can read the room')
    const messages = await call('GET', `/rooms/${roomId}/messages`, undefined, bob.token)
    assert.equal(messages.status, 200, messages.raw)
    assert.ok((messages.body.messages ?? []).length > 0, 'history is still readable')
  })
})

test('leaving and being removed do not dissolve the workgroup', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)
    // The distinction the requirement draws, asserted directly: after a member leaves, the room is
    // still a room and still accepts messages from the people who remain.
    const left = await call('POST', `/rooms/${roomId}/leave`, {}, bob.token)
    assert.equal(left.status, 200, left.raw)
    const stillOpen = await call('POST', `/rooms/${roomId}/messages`, { body: 'still here', clientMessageId: 'd-dissolve-msg-0002' }, alice.token)
    assert.equal(stillOpen.status, 201, stillOpen.raw)
    const read = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(read.body.room.dissolvedAt, undefined, 'a room that lost a member did not end')
  })
})

test('dissolving twice is refused rather than silently succeeding', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, roomId } = await workgroupWithActivity(call, person)
    assert.equal((await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)).status, 200)
    const again = await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
    assert.equal(again.status, 409, again.raw)
  })
})

test('the dissolution is announced to the members subscribed to that room', async () => {
  await withHub(async ({ call, server, person }) => {
    const { alice, bob, roomId } = await workgroupWithActivity(call, person)

    // `publishToRoom` delivers to connections that have subscribed to the room, so the announcement is
    // observed by registering real connection entries rather than by spying on a method: a spy would
    // pass even if the event went to nobody, which is the failure that matters here.
    const delivered = []
    const makeFakeConnection = userId => ({
      user: { id: userId },
      rooms: new Set([roomId]),
      unacked: new Map(),
      socket: { readyState: 1, send: payload => delivered.push(JSON.parse(payload)) },
      alive: true,
    })
    const aliceConnection = makeFakeConnection(alice.userId)
    const bobConnection = makeFakeConnection(bob.userId)
    server.hub.realtime.connections.set('d-conn-alice', aliceConnection)
    server.hub.realtime.connections.set('d-conn-bob', bobConnection)
    try {
      const response = await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
      assert.equal(response.status, 200, response.raw)
    } finally {
      server.hub.realtime.connections.delete('d-conn-alice')
      server.hub.realtime.connections.delete('d-conn-bob')
    }

    const announcements = delivered.filter(event => event.type === 'room.dissolved')
    // Both members heard it, not just the actor: a member left typing into a workgroup that ended
    // would otherwise find out only when their next send is refused.
    assert.equal(announcements.length, 2, `expected both members to be told, got ${String(announcements.length)}`)
    assert.equal(announcements.every(event => event.roomId === roomId), true, 'the event names the room it concerns')
    assert.equal(announcements[0].payload.dissolvedBy, alice.userId)
  })
})
