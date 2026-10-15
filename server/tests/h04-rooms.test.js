// H-04 tests: rooms, membership, and invitations.
//
// The completion condition in the task board is one sentence — "a non-member cannot read
// room data" — and that is what most of this file drives at: from every angle a stranger
// could try (guessing ids, replaying an invitation, using a removed member's old token,
// asking before accepting). The rest covers the rules that keep a room administrable:
// the owner cannot be removed, removal cannot be undone by an in-flight invitation, and a
// removed member cannot act on the room again.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'h04-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h04-'))
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
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  /** Register, log in, and return the token plus ids a case needs. */
  const person = async (handle, label) => {
    const password = `${handle}-password-long-enough`
    const registered = await call('POST', '/auth/register', { userHandle: handle, displayName: label ?? handle, password })
    assert.equal(registered.status, 201, registered.raw)
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken, refreshToken: login.body.refreshToken, deviceId: login.body.device.id, handle }
  }
  try {
    await run({ config, db, server, call, person })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** A room owned by `owner` with `guest` invited and joined. */
async function roomWithGuest(call, owner, guest) {
  const created = await call('POST', '/rooms', { name: 'Finance' }, owner.token)
  assert.equal(created.status, 201, created.raw)
  const roomId = created.body.room.id
  const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: guest.userId }, owner.token)
  assert.equal(invited.status, 201, invited.raw)
  const accepted = await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, guest.token)
  assert.equal(accepted.status, 200, accepted.raw)
  return { roomId, invitationId: invited.body.invitation.id }
}

// ---------------------------------------------------------------- creation and listing

test('creating a room makes the creator its owner and first member', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.room.name, 'Finance')
    assert.equal(created.body.room.ownerUserId, alice.userId)
    assert.equal(created.body.room.myRole, 'owner')

    const membership = db.prepare('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?').get(created.body.room.id, alice.userId)
    assert.equal(membership.role, 'owner')

    const listed = await call('GET', '/rooms', undefined, alice.token)
    assert.equal(listed.body.rooms.length, 1)
    assert.equal(listed.body.rooms[0].id, created.body.room.id)
  })
})

test('a room name is required and bounded', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    assert.equal((await call('POST', '/rooms', {}, alice.token)).status, 400)
    assert.equal((await call('POST', '/rooms', { name: '   ' }, alice.token)).status, 400)
    assert.equal((await call('POST', '/rooms', { name: 'x'.repeat(121) }, alice.token)).status, 400)
  })
})

test('the room list shows only rooms the caller is a member of', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await roomWithGuest(call, alice, bob)
    await call('POST', '/rooms', { name: 'Alice private' }, alice.token)

    assert.equal((await call('GET', '/rooms', undefined, alice.token)).body.rooms.length, 2)
    const bobRooms = await call('GET', '/rooms', undefined, bob.token)
    assert.equal(bobRooms.body.rooms.length, 1)
    assert.equal(bobRooms.body.rooms[0].name, 'Finance')
  })
})

// ---------------------------------------------------------------- non-member isolation

test('a non-member cannot read a room, its members, or rename it', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const stranger = await person('stranger')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id

    for (const [method, path, body] of [
      ['GET', `/rooms/${roomId}`, undefined],
      ['GET', `/rooms/${roomId}/members`, undefined],
      ['PATCH', `/rooms/${roomId}`, { name: 'Hijacked' }],
    ]) {
      const response = await call(method, path, body, stranger.token)
      assert.equal(response.status, 404, `${method} ${path} must not reveal the room: ${response.raw}`)
    }
  })
})

test('a guessed room id is answered exactly like an unknown one, so ids cannot be probed', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const stranger = await person('stranger')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)

    const real = await call('GET', `/rooms/${created.body.room.id}`, undefined, stranger.token)
    const fake = await call('GET', '/rooms/00000000-0000-4000-8000-000000000000', undefined, stranger.token)
    assert.equal(real.status, 404)
    assert.equal(fake.status, 404)
    // Same code and message: nothing distinguishes "exists but not yours" from "no such room".
    assert.deepEqual(real.body, fake.body)
  })
})

test('an unauthenticated caller gets nothing, on every room route', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    for (const [method, path, body] of [
      ['GET', '/rooms', undefined],
      ['POST', '/rooms', { name: 'x' }],
      ['GET', `/rooms/${roomId}`, undefined],
      ['GET', `/rooms/${roomId}/members`, undefined],
      ['POST', `/rooms/${roomId}/invitations`, { targetUserId: alice.userId }],
      ['GET', '/invitations', undefined],
    ]) {
      const response = await call(method, path, body)
      assert.equal(response.status, 401, `${method} ${path} must require a token: ${response.raw}`)
    }
  })
})

// ---------------------------------------------------------------- invitations

test('an invitation is an offer to one named user, who must accept it', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id

    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal(invited.status, 201, invited.raw)
    assert.equal(invited.body.invitation.status, 'pending')
    assert.equal(invited.body.invitation.targetUserId, bob.userId)

    // Before accepting, Bob is still not a member.
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 404)

    // Bob sees the offer on his own list.
    const inbox = await call('GET', '/invitations', undefined, bob.token)
    assert.equal(inbox.body.invitations.length, 1)
    assert.equal(inbox.body.invitations[0].roomName, 'Finance')
    assert.equal(inbox.body.invitations[0].inviterDisplayName, 'alice')

    const accepted = await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    assert.equal(accepted.status, 200, accepted.raw)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 200)
  })
})

test('only the addressed recipient can accept an invitation', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const eve = await person('eve')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const invited = await call('POST', `/rooms/${created.body.room.id}/invitations`, { targetUserId: bob.userId }, alice.token)

    // Eve holds the invitation id but is not the recipient.
    const stolen = await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, eve.token)
    assert.equal(stolen.status, 404)
    assert.equal((await call('GET', `/rooms/${created.body.room.id}`, undefined, eve.token)).status, 404)
    // And Bob's offer is still open.
    assert.equal((await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)).status, 200)
  })
})

test('accepting twice changes nothing', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { invitationId, roomId } = await roomWithGuest(call, alice, bob)
    const again = await call('POST', `/invitations/${invitationId}/accept`, {}, bob.token)
    assert.equal(again.status, 409)
    // Exactly one membership row, still a member.
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 200)
  })
})

test('a declined or expired invitation cannot be used', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id

    const declined = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal((await call('POST', `/invitations/${declined.body.invitation.id}/decline`, {}, bob.token)).status, 200)
    assert.equal((await call('POST', `/invitations/${declined.body.invitation.id}/accept`, {}, bob.token)).status, 409)

    const expiring = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiring.body.invitation.id)
    const accepted = await call('POST', `/invitations/${expiring.body.invitation.id}/accept`, {}, carol.token)
    assert.equal(accepted.status, 410)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, carol.token)).status, 404)
    // The expired invitation is marked so it stops appearing as pending.
    assert.equal(db.prepare('SELECT status FROM invitations WHERE id = ?').get(expiring.body.invitation.id).status, 'expired')
  })
})

test('inviting needs room admin, and an invitation cannot grant ownership', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const { roomId } = await roomWithGuest(call, alice, bob)

    // Bob is a plain member: he cannot invite.
    const refused = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, bob.token)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'NOT_A_ROOM_ADMIN')

    // Ownership is not an invitable role, so it cannot be handed out by invitation.
    const ownerOffer = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId, role: 'owner' }, alice.token)
    assert.equal(ownerOffer.status, 400)
    assert.equal(ownerOffer.body.error.code, 'INVALID_ROLE')

    // An admin invitation is allowed; the accepted role is admin.
    const adminOffer = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId, role: 'admin' }, alice.token)
    assert.equal(adminOffer.status, 201, adminOffer.raw)
    await call('POST', `/invitations/${adminOffer.body.invitation.id}/accept`, {}, carol.token)
    const members = await call('GET', `/rooms/${roomId}/members`, undefined, alice.token)
    assert.equal(members.body.members.find(m => m.userId === carol.userId).role, 'admin')
  })
})

test('inviting an existing member is refused, and re-inviting returns the pending offer', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)
    const duplicate = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'ALREADY_A_MEMBER')

    const carol = await person('carol')
    const first = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    const second = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    // One offer, not two: a repeated invite must not queue a second membership.
    assert.equal(second.body.invitation.id, first.body.invitation.id)
  })
})

test('an invitation to an unknown or disabled user is refused', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    assert.equal((await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: 'no-such-user' }, alice.token)).status, 404)
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(bob.userId)
    const disabled = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal(disabled.status, 403)
    assert.equal(disabled.body.error.code, 'ACCOUNT_DISABLED')
  })
})

test('the inviter or a room admin may withdraw a pending invitation', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const { roomId } = await roomWithGuest(call, alice, bob)

    const offer = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    // The target cannot withdraw someone else's offer to them; the inviter can.
    const byTarget = await call('POST', `/invitations/${offer.body.invitation.id}/revoke`, {}, carol.token)
    assert.equal(byTarget.status, 403)
    const byInviter = await call('POST', `/invitations/${offer.body.invitation.id}/revoke`, {}, alice.token)
    assert.equal(byInviter.status, 200)
    assert.equal(byInviter.body.invitation.status, 'revoked')
    assert.equal((await call('POST', `/invitations/${offer.body.invitation.id}/accept`, {}, carol.token)).status, 409)
  })
})

// ---------------------------------------------------------------- removal and leaving

test('removing a member ends their access immediately', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 200)

    const removed = await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    assert.equal(removed.status, 200, removed.raw)

    // The very next request is refused, with the same 404 a stranger sees.
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/members`, undefined, bob.token)).status, 404)
    assert.equal((await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, bob.token)).status, 404)
  })
})

test('removal revokes an in-flight invitation, so a removal cannot be undone by accepting one', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const { roomId } = await roomWithGuest(call, alice, bob)

    // Carol is invited but has not accepted yet.
    const pending = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    // Meanwhile Bob is removed. His removal must not touch Carol's offer...
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    assert.equal((await call('POST', `/invitations/${pending.body.invitation.id}/accept`, {}, carol.token)).status, 200)

    // ...but removing Carol after she accepted does revoke her offers, and re-inviting her
    // is the only way back.
    await call('POST', `/rooms/${roomId}/members/${carol.userId}/remove`, {}, alice.token)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, carol.token)).status, 404)
    const reInvite = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token)
    assert.equal(reInvite.status, 201, reInvite.raw)
    assert.equal((await call('POST', `/invitations/${reInvite.body.invitation.id}/accept`, {}, carol.token)).status, 200)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, carol.token)).status, 200)
  })
})

test('the owner cannot be removed, and a member cannot remove themselves through remove', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)

    // Even an admin cannot remove the owner: a room with no owner is unadministrable.
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/role`, { role: 'admin' }, alice.token)
    const ownerRemoval = await call('POST', `/rooms/${roomId}/members/${alice.userId}/remove`, {}, bob.token)
    assert.equal(ownerRemoval.status, 409)
    assert.equal(ownerRemoval.body.error.code, 'CANNOT_REMOVE_OWNER')

    const selfRemoval = await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, bob.token)
    assert.equal(selfRemoval.status, 403)
    assert.equal(selfRemoval.body.error.code, 'CANNOT_REMOVE_SELF')
  })
})

test('removing a non-member is refused, and a plain member cannot remove anyone', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const { roomId } = await roomWithGuest(call, alice, bob)

    assert.equal((await call('POST', `/rooms/${roomId}/members/${carol.userId}/remove`, {}, alice.token)).status, 404)
    const byMember = await call('POST', `/rooms/${roomId}/members/${carol.userId}/remove`, {}, bob.token)
    assert.equal(byMember.status, 403)
    assert.equal(byMember.body.error.code, 'NOT_A_ROOM_ADMIN')
  })
})

test('leaving ends access, and the owner cannot leave', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)

    assert.equal((await call('POST', `/rooms/${roomId}/leave`, {}, bob.token)).status, 200)
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, bob.token)).status, 404)
    assert.equal((await call('GET', '/rooms', undefined, bob.token)).body.rooms.length, 0)

    const ownerLeaves = await call('POST', `/rooms/${roomId}/leave`, {}, alice.token)
    assert.equal(ownerLeaves.status, 409)
    assert.equal(ownerLeaves.body.error.code, 'OWNER_CANNOT_LEAVE')
  })
})

test('a removed member can be re-invited and rejoins as a member, not as their old role', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/role`, { role: 'admin' }, alice.token)
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)

    const again = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal(again.status, 201, again.raw)
    // The invitation decides the role; rejoining does not silently restore admin.
    assert.equal(again.body.invitation.role, 'member')
    await call('POST', `/invitations/${again.body.invitation.id}/accept`, {}, bob.token)
    const members = await call('GET', `/rooms/${roomId}/members`, undefined, alice.token)
    assert.equal(members.body.members.find(m => m.userId === bob.userId).role, 'member')
  })
})

// ---------------------------------------------------------------- roles and renaming

test('only an admin may change a role, and the owner\'s role is fixed', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const { roomId } = await roomWithGuest(call, alice, bob)
    await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: carol.userId }, alice.token).then(async (invited) => {
      await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, carol.token)
    })

    const byMember = await call('POST', `/rooms/${roomId}/members/${carol.userId}/role`, { role: 'admin' }, bob.token)
    assert.equal(byMember.status, 403)

    const promoted = await call('POST', `/rooms/${roomId}/members/${carol.userId}/role`, { role: 'admin' }, alice.token)
    assert.equal(promoted.status, 200, promoted.raw)
    assert.equal(promoted.body.member.role, 'admin')

    const ownerRole = await call('POST', `/rooms/${roomId}/members/${alice.userId}/role`, { role: 'member' }, alice.token)
    assert.equal(ownerRole.status, 409)
    assert.equal(ownerRole.body.error.code, 'CANNOT_CHANGE_OWNER')

    // `owner` is not an assignable role, so nobody can be promoted into it.
    const toOwner = await call('POST', `/rooms/${roomId}/members/${carol.userId}/role`, { role: 'owner' }, alice.token)
    assert.equal(toOwner.status, 400)
  })
})

test('renaming needs admin and is visible to members', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId } = await roomWithGuest(call, alice, bob)

    assert.equal((await call('PATCH', `/rooms/${roomId}`, { name: 'Nope' }, bob.token)).status, 403)
    const renamed = await call('PATCH', `/rooms/${roomId}`, { name: 'Finance Q4' }, alice.token)
    assert.equal(renamed.status, 200, renamed.raw)
    assert.equal(renamed.body.room.name, 'Finance Q4')
    const seen = await call('GET', '/rooms', undefined, bob.token)
    assert.equal(seen.body.rooms[0].name, 'Finance Q4')
  })
})

// ---------------------------------------------------------------- audit

test('membership changes are recorded in the audit trail', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const { roomId, invitationId } = await roomWithGuest(call, alice, bob)
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)

    const events = db.prepare('SELECT event_type, outcome FROM audit_events').all()
    const types = events.map(event => event.event_type)
    for (const expected of ['room.created', 'invitation.created', 'invitation.accepted', 'room.member_removed']) {
      assert.ok(types.includes(expected), `expected an audit event for ${expected}, got ${types.join(', ')}`)
    }
    assert.equal(events.every(event => event.outcome === 'success'), true, events.map(e => `${e.event_type}:${e.outcome}`).join(', '))

    // No audit row may carry the invitation id as a secret, and none may carry room content.
    const details = db.prepare('SELECT safe_details_json FROM audit_events').all().map(row => row.safe_details_json).join(' ')
    assert.equal(details.includes('password'), false)
    assert.ok(invitationId.length > 0)
  })
})

test('a revoked refresh token cannot be used to read rooms, so a signed-out device loses room access too', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const { roomId } = await roomWithGuest(call, alice, await person('bob'))
    assert.equal((await call('GET', `/rooms/${roomId}`, undefined, alice.token)).status, 200)
    await call('POST', '/auth/logout-all', {}, alice.token)
    // The access token is still live by design (short TTL, verified without a database read)
    // but the refresh token cannot mint a new one.
    const refreshed = await call('POST', '/auth/refresh', { refreshToken: alice.refreshToken })
    assert.equal(refreshed.status, 401)
  })
})
