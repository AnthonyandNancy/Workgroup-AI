// H-14 (memory quota): a room's memory has a ceiling, and eviction is soft.
//
// Why this exists: group memory had no bound at all. A room could accumulate entries until the
// database was the limit, which is not a policy an operator can state. The requirement is a
// configurable ceiling with oldest-first eviction, and it comes with one non-negotiable property:
// **the revision trail and the audit row survive the eviction.** A Hub whose answer to "what did we
// decide and who changed it" depends on a row still existing cannot evict by deleting, because the
// evidence of the decision is exactly what would disappear.
//
// So eviction reuses the deletion semantics already in this module: the body is cleared, the scope
// is narrowed, `deleted_at` is stamped, and the entry stops being readable — by anyone, including
// the author. The audit entry says `memory.evicted`, which is a different fact from
// `memory.deleted` (the author changed their mind) or `memory.deleted_by_admin` (a room admin
// removed it). An operator reading the trail can tell which of the three happened.
//
// The default is `0` = no ceiling, which is what keeps an upgrade from silently evicting what a
// Hub already stores.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { createRoom } from '../src/modules/rooms/store.js'
import { createMemory, listMemories, findMemory } from '../src/modules/memory/store.js'
import { createUser } from '../src/auth/store.js'

const SIGNING_KEY = 'h14-memory-test-signing-key-long-enough-for-hs256'

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h14-memory-'))
  // Retries because Windows releases a closed SQLite handle slightly after `close()` returns.
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) }
}

/**
 * A real room with one real member, opened directly so the cases can drive the store.
 *
 * No device id is passed: `audit_events.actor_device_id` is a foreign key, and inventing one here
 * would be inserting a device that does not exist merely to satisfy the column. A null actor is
 * the honest shape for "this test drove the store directly rather than through a signed-in client".
 */
function fixture(root) {
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const alice = createUser(db, { handle: 'alice', displayName: 'Alice', passwordHash: 'scrypt$1$1$1$AA$AA' })
  const room = createRoom(db, { name: 'Finance', ownerUserId: alice.id })
  return { config, db, alice, roomId: room.id }
}

test('with no ceiling configured, memory keeps growing as it did before', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const f = fixture(root)
    db = f.db
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    for (let i = 0; i < 5; i += 1) {
      createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: `note ${String(i)}` })
    }
    const entries = listMemories(db, { roomId: f.roomId, viewerUserId: f.alice.id })
    assert.equal(entries.filter(row => row.deleted_at === null).length, 5)
  } finally {
    db?.close()
    cleanup()
  }
})

test('writing past the ceiling evicts the oldest entry, and the newest is kept', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const f = fixture(root)
    db = f.db
    const bodies = []
    for (let i = 0; i < 4; i += 1) {
      const body = `note ${String(i)}`
      bodies.push(body)
      createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body, maxPerRoom: 3 })
    }
    const live = listMemories(db, { roomId: f.roomId, viewerUserId: f.alice.id }).filter(row => row.deleted_at === null)
    assert.equal(live.length, 3, 'the ceiling holds at the configured number')
    assert.deepEqual(live.map(row => row.body).sort(), [bodies[1], bodies[2], bodies[3]].sort(), 'the oldest went, not the newest')
  } finally {
    db?.close()
    cleanup()
  }
})

test('an evicted entry is readable by nobody, including its author', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const f = fixture(root)
    db = f.db
    createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: 'the oldest note', maxPerRoom: 2 })
    const oldest = listMemories(db, { roomId: f.roomId, viewerUserId: f.alice.id })[0]
    createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: 'second', maxPerRoom: 2 })
    createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: 'third', maxPerRoom: 2 })

    const evicted = findMemory(db, oldest.id)
    assert.notEqual(evicted.deleted_at, null, 'eviction stamps a deletion time')
    assert.equal(evicted.body, '', 'the body is cleared so a stray read cannot return it')
    const listed = listMemories(db, { roomId: f.roomId, viewerUserId: f.alice.id })
    assert.ok(!listed.some(row => row.id === oldest.id), 'the author does not see it either')
  } finally {
    db?.close()
    cleanup()
  }
})

test('the revision trail and the audit row survive an eviction', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const f = fixture(root)
    db = f.db
    createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: 'the oldest note', maxPerRoom: 1 })
    const oldest = listMemories(db, { roomId: f.roomId, viewerUserId: f.alice.id })[0]
    createMemory(db, { roomId: f.roomId, authorUserId: f.alice.id, body: 'evicts it', maxPerRoom: 1 })

    const audit = db.prepare(
      "SELECT event_type, safe_details_json FROM audit_events WHERE object_id = ? ORDER BY event_type",
    ).all(oldest.id)
    assert.ok(audit.some(row => row.event_type === 'memory.created'), 'the creation record is still there')
    const evicted = audit.find(row => row.event_type === 'memory.evicted')
    assert.ok(evicted !== undefined, 'the eviction is recorded as its own event type')
    assert.equal(JSON.parse(evicted.safe_details_json).reason, 'quota', 'the reason distinguishes it from a person deleting')
  } finally {
    db?.close()
    cleanup()
  }
})

test('the ceiling is configuration, and the API path uses it', async () => {
  const { root, cleanup } = tempRoot()
  let db
  let server
  try {
    const config = loadConfig({
      NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_MAX_MEMORIES_PER_ROOM: '2',
    })
    assert.equal(config.limits.maxMemoriesPerRoom, 2)
    db = openDatabase(config)
    migrate(db)
    server = await createServer({ config, db, logger: false })
    const call = async (method, path, body, token) => {
      const response = await server.inject({
        method,
        url: `/api/v1${path}`,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        payload: body === undefined ? undefined : JSON.stringify(body),
      })
      let json
      try {
        json = response.json()
      } catch {
        json = undefined
      }
      return { status: response.statusCode, body: json }
    }
    const registered = await call('POST', '/auth/register', { userHandle: 'alice', displayName: 'Alice', password: 'password-long-enough' })
    assert.equal(registered.status, 201)
    const login = await call('POST', '/auth/login', { userHandle: 'alice', password: 'password-long-enough', fingerprint: 'sha256:a', publicKey: 'ed25519:a' })
    const token = login.body.accessToken
    const created = await call('POST', '/rooms', { name: 'Finance' }, token)
    const roomId = created.body.room.id
    for (let i = 0; i < 4; i += 1) {
      const written = await call('POST', `/rooms/${roomId}/memories`, { body: `note ${String(i)}` }, token)
      assert.equal(written.status, 201, JSON.stringify(written.body))
    }
    const listed = await call('GET', `/rooms/${roomId}/memories`, undefined, token)
    assert.equal(listed.body.memories.length, 2, 'the configured ceiling is what the route enforces')
  } finally {
    if (server !== undefined) await server.close()
    db?.close()
    cleanup()
  }
})
