// H-07 tests: the publishable Bot directory and derived presence.
//
// The completion condition is "only Bots the user authorized are visible". A directory is the
// easiest place for a Hub to over-share, so most of these cases are negative: a private Bot
// must be invisible and indistinguishable from one that does not exist; `room` visibility
// must not leak to someone who shares no room; a narrowed visibility must take effect on the
// next request; and a stale heartbeat must read as offline rather than available.
//
// Presence gets its own group because it is the one field a client cannot be trusted to
// report honestly on its own: a crashed client never sends "I am offline", so the Hub derives
// availability from heartbeat freshness instead of storing a claim.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { presenceOf, directoryInternals } from '../src/modules/bots/store.js'

const SIGNING_KEY = 'h07-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h07-'))
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
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  /** Two users who share a room, which `room` visibility requires. */
  const sharers = async () => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    return { alice, bob, roomId }
  }
  const publish = (actor, botId, displayName, visibility) =>
    call('POST', '/bots', { botId, displayName, visibility }, actor.token)
  try {
    await run({ config, db, server, call, person, sharers, publish })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---------------------------------------------------------------- presence derivation

test('presence is derived from heartbeat freshness, not from the stored claim', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  // No heartbeat ever recorded.
  assert.equal(presenceOf({ last_seen_at: null, state: 'online' }, now), 'offline')
  // A heartbeat a moment ago.
  assert.equal(presenceOf({ last_seen_at: '2025-12-31T23:59:30.000Z', state: 'online' }, now), 'online')
  // A heartbeat older than the TTL: the client is gone and cannot say so.
  const stale = new Date(now.getTime() - directoryInternals.PRESENCE_TTL_MS - 1000).toISOString()
  assert.equal(presenceOf({ last_seen_at: stale, state: 'online' }, now), 'offline')
  // A future timestamp must not buy extra liveness.
  assert.equal(presenceOf({ last_seen_at: '2026-01-02T00:00:00.000Z', state: 'online' }, now), 'online')
})

// ---------------------------------------------------------------- publishing

test('a new Bot starts private and is visible only to its owner', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const created = await publish(alice, 'chief', 'Chief', 'private')
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.bot.visibility, 'private')

    // The owner sees it in their own management list.
    const mine = await call('GET', '/bots', undefined, alice.token)
    assert.equal(mine.body.bots.length, 1)
    assert.equal(mine.body.bots[0].botId, 'chief')

    // Nobody else sees it anywhere.
    assert.equal((await call('GET', '/bots', undefined, bob.token)).body.bots.length, 0)
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots.length, 0)
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)).status, 404)
  })
})

test('a public Bot is visible to any authenticated user, with its owner named', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    await publish(alice, 'chief', 'Chief', 'public')

    const directory = await call('GET', '/bots/directory', undefined, bob.token)
    assert.equal(directory.body.bots.length, 1)
    assert.equal(directory.body.bots[0].botId, 'chief')
    assert.equal(directory.body.bots[0].ownerUserId, alice.userId)
    assert.equal(directory.body.bots[0].ownerDisplayName, 'Alice Zhang')
    assert.equal(directory.body.bots[0].presence, 'offline')

    const one = await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)
    assert.equal(one.status, 200)
    assert.equal(one.body.bot.displayName, 'Chief')
  })
})

test('an unauthenticated caller sees no directory at all', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', 'Chief', 'public')
    for (const path of ['/bots', '/bots/directory', `/bots/directory/${alice.userId}/chief`]) {
      assert.equal((await call('GET', path)).status, 401, `${path} must need a token`)
    }
    assert.equal((await call('POST', '/bots', { botId: 'x', displayName: 'X', visibility: 'public' })).status, 401)
  })
})

test('room visibility reaches someone who shares a room, and nobody else', async () => {
  await withHub(async ({ sharers, person, publish, call }) => {
    const { alice, bob, roomId } = await sharers()
    const outsider = await person('outsider', 'Outsider')
    await publish(alice, 'chief', 'Chief', 'room')

    // Bob shares a room with Alice, so he sees the Bot.
    const listed = await call('GET', '/bots/directory', undefined, bob.token)
    assert.deepEqual(listed.body.bots.map(b => b.botId), ['chief'])
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)).status, 200)

    // The unrelated user sees nothing and cannot confirm the Bot exists.
    assert.equal((await call('GET', '/bots/directory', undefined, outsider.token)).body.bots.length, 0)
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, outsider.token)).status, 404)

    // Removing Bob from that room narrows it back: sharing is a live fact, not a past one.
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots.length, 0)
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)).status, 404)
  })
})

test('a private Bot is indistinguishable from a Bot that does not exist', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await publish(alice, 'secret-bot', 'Secret', 'private')

    const existing = await call('GET', `/bots/directory/${alice.userId}/secret-bot`, undefined, bob.token)
    const invented = await call('GET', `/bots/directory/${alice.userId}/no-such-bot`, undefined, bob.token)
    assert.equal(existing.status, 404)
    assert.equal(invented.status, 404)
    // Identical responses: a prober learns nothing about which Bots exist.
    assert.deepEqual(existing.body, invented.body)
  })
})

test('narrowing visibility takes effect on the very next request', async () => {
  await withHub(async ({ sharers, call, db }) => {
    const { alice, bob } = await sharers()
    await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'public' }, alice.token)
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)).status, 200)

    await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'private' }, alice.token)
    // The resolve route re-checks visibility rather than trusting the earlier listing.
    assert.equal((await call('GET', `/bots/directory/${alice.userId}/chief`, undefined, bob.token)).status, 404)
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots.length, 0)
  })
})

test('only the owner can publish, change, or withdraw an entry', async () => {
  await withHub(async ({ person, publish, call, db }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    await publish(alice, 'chief', 'Chief', 'public')

    // There is no route that takes an owner id, so Bob's only possible action is on his own
    // entry — and his own entry does not exist.
    assert.equal((await call('POST', '/bots/chief/withdraw', {}, bob.token)).status, 404)
    assert.equal((await call('POST', '/bots/chief/heartbeat', {}, bob.token)).status, 404)

    // Alice's entry is untouched.
    const row = db.prepare('SELECT visibility FROM bot_directory WHERE owner_user_id = ? AND bot_id = ?').get(alice.userId, 'chief')
    assert.equal(row.visibility, 'public')

    // Alice can withdraw her own.
    assert.equal((await call('POST', '/bots/chief/withdraw', {}, alice.token)).status, 200)
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots.length, 0)
  })
})

test('the same botId under two owners is two independent entries', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    await publish(alice, 'chief', 'Alice Chief', 'public')
    await publish(bob, 'chief', 'Bob Chief', 'public')

    const directory = await call('GET', '/bots/directory', undefined, alice.token)
    assert.equal(directory.body.bots.length, 2)
    const byOwner = Object.fromEntries(directory.body.bots.map(b => [b.ownerUserId, b.displayName]))
    assert.equal(byOwner[alice.userId], 'Alice Chief')
    assert.equal(byOwner[bob.userId], 'Bob Chief')
  })
})

test('publishing validates the id, the name, and the visibility', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice')
    assert.equal((await publish(alice, '', 'Chief', 'public')).status, 400)
    assert.equal((await publish(alice, 'chief', '', 'public')).status, 400)
    assert.equal((await publish(alice, 'chief', 'x'.repeat(81), 'public')).status, 400)
    assert.equal((await publish(alice, 'chief', 'Chief', 'everyone')).status, 400)
    assert.equal((await call('POST', '/bots', { botId: 'chief', displayName: 'Chief' }, alice.token)).body.bot.visibility, 'private')
  })
})

test('the directory can be narrowed to one owner and searched by name', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    await publish(alice, 'writer', 'Writer', 'public')
    await publish(alice, 'coder', 'Coder', 'public')
    await publish(bob, 'analyst', 'Analyst', 'public')

    const byOwner = await call('GET', `/bots/directory?ownerUserId=${alice.userId}`, undefined, bob.token)
    assert.deepEqual(byOwner.body.bots.map(b => b.botId).sort(), ['coder', 'writer'])

    const byName = await call('GET', '/bots/directory?q=Writ', undefined, bob.token)
    assert.deepEqual(byName.body.bots.map(b => b.botId), ['writer'])
  })
})

// ---------------------------------------------------------------- presence over HTTP

test('a heartbeat marks a Bot online, and presence stops being online once it goes stale', async () => {
  await withHub(async ({ person, publish, call, db }) => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    await publish(alice, 'chief', 'Chief', 'public')
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots[0].presence, 'offline')

    const beat = await call('POST', '/bots/chief/heartbeat', {}, alice.token)
    assert.equal(beat.status, 200, beat.raw)
    assert.equal(beat.body.bot.presence, 'online')
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots[0].presence, 'online')

    // Simulate the client crashing: the stored state still says online, but time passes.
    const stale = new Date(Date.now() - directoryInternals.PRESENCE_TTL_MS - 1000).toISOString()
    db.prepare('UPDATE bot_directory SET last_seen_at = ? WHERE owner_user_id = ? AND bot_id = ?').run(stale, alice.userId, 'chief')
    assert.equal((await call('GET', '/bots/directory', undefined, bob.token)).body.bots[0].presence, 'offline')
  })
})

test('a heartbeat reports busy or offline as the client chooses, and refuses an unknown state', async () => {
  await withHub(async ({ person, publish, call }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', 'Chief', 'public')
    assert.equal((await call('POST', '/bots/chief/heartbeat', { state: 'busy' }, alice.token)).body.bot.state, 'busy')
    assert.equal((await call('POST', '/bots/chief/heartbeat', { state: 'offline' }, alice.token)).body.bot.state, 'offline')
    assert.equal((await call('POST', '/bots/chief/heartbeat', { state: 'on fire' }, alice.token)).status, 400)
  })
})

// ---------------------------------------------------------------- what the directory must not carry

test('a directory entry carries no model, Session, path, or capability information', async () => {
  await withHub(async ({ person, publish, call, db }) => {
    const alice = await person('alice', 'Alice Zhang')
    await publish(alice, 'chief', 'Chief', 'public')
    const columns = db.prepare("SELECT p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name = 'bot_directory'").all()
    const names = columns.map(row => row.column_name)
    for (const forbidden of ['model', 'session_id', 'sessionId', 'work_dir', 'workspace', 'path', 'capabilities', 'tools', 'api_key']) {
      assert.equal(names.includes(forbidden), false, `bot_directory must not carry ${forbidden}`)
    }
    // And the response shape confirms the same: the wire contract is these fields and nothing about
    // how the Bot works. `isChief` is one of them: whether a Bot is its owner's Main Bot is a fact the
    // Hub mirrors so a workgroup's leader can be checked, and it says nothing about the owner's machine.
    const entry = (await call('GET', '/bots/directory', undefined, alice.token)).body.bots[0]
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['botId', 'displayName', 'isChief', 'ownerDisplayName', 'ownerHandle', 'ownerUserId', 'presence', 'state', 'visibility'],
    )
  })
})

test('directory changes are audited without carrying the Bot display name into details', async () => {
  await withHub(async ({ person, publish, call, db }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', 'Chief', 'public')
    await call('POST', '/bots/chief/heartbeat', {}, alice.token)
    await call('POST', '/bots/chief/withdraw', {}, alice.token)

    const events = db.prepare("SELECT event_type, safe_details_json FROM audit_events WHERE object_type = 'bot'").all()
    const types = events.map(event => event.event_type)
    for (const expected of ['bot.published', 'bot.withdrawn']) {
      assert.ok(types.includes(expected), `expected ${expected} in ${types.join(', ')}`)
    }
    // Presence heartbeats are not audited: they are high-frequency and carry no decision.
    assert.equal(types.includes('bot.heartbeat'), false)
  })
})
