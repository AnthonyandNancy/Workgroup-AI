// H-10 tests: group memory with a source, an author, revisions, scope, expiry, and deletion.
//
// The completion condition is "an unauthorized search returns nothing or 403". The cases below
// drive that from every angle: a non-member, a removed member, and a member of the room reading
// an entry the author did not share. The rest cover the properties that make a memory usable as
// evidence — the author cannot be rewritten by a correction, a correction keeps the old text, and
// a deletion leaves a record that it happened rather than erasing the trail.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { searchMemories, listMemories, mayRead } from '../src/modules/memory/store.js'

const SIGNING_KEY = 'h10-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h10-'))
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
    return { userId: login.body.user.id, token: login.body.accessToken, displayName: displayName ?? handle }
  }
  /** Two members and one stranger, with a room the first two share. */
  const scene = async () => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const stranger = await person('stranger', 'Outsider')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    const message = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'client-msg-000001', body: '季度报表口径：以开票日为准' }, alice.token)
    return { alice, bob, stranger, roomId, messageId: message.body.message.id }
  }
  try {
    await run({ config, db, server, call, person, scene })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

const remember = (call, roomId, body, token, extra = {}) =>
  call('POST', `/rooms/${roomId}/memories`, { body, ...extra }, token)
const search = (call, roomId, q, token) => call('GET', `/rooms/${roomId}/memories/search?q=${encodeURIComponent(q)}`, undefined, token)

// ---------------------------------------------------------------- creation and source

test('a memory records its author and its source message', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId, messageId } = await scene()
    const created = await remember(call, roomId, '季度报表口径：以开票日为准', alice.token, { sourceMessageId: messageId })
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.memory.authorUserId, alice.userId)
    assert.equal(created.body.memory.sourceMessageId, messageId)
    // `sourced` states whether the entry cites a message, so a reader can weigh it.
    assert.equal(created.body.memory.sourced, true)
    assert.equal(created.body.memory.revision, 1)
    assert.equal(created.body.memory.scope, 'room')
  })
})

test('a memory with no source is kept, and is labelled as an unsourced assertion', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, '我们决定改用新口径', alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.memory.sourceMessageId, null)
    assert.equal(created.body.memory.sourced, false)
  })
})

test('a source message from another room is refused, so a memory cannot quote across a boundary', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const other = await call('POST', '/rooms', { name: 'Engineering' }, alice.token)
    const otherMessage = await call('POST', `/rooms/${other.body.room.id}/messages`, { clientMessageId: 'client-msg-000001', body: 'secret' }, alice.token)
    const refused = await remember(call, roomId, 'x', alice.token, { sourceMessageId: otherMessage.body.message.id })
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'SOURCE_IN_ANOTHER_ROOM')
    // A source that does not exist is refused too.
    assert.equal((await remember(call, roomId, 'x', alice.token, { sourceMessageId: 'no-such-message' })).status, 404)
  })
})

test('a memory body is required and bounded, and its scope must be one of the two', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    assert.equal((await remember(call, roomId, '', alice.token)).status, 400)
    assert.equal((await remember(call, roomId, '   ', alice.token)).status, 400)
    assert.equal((await remember(call, roomId, 'x'.repeat(20_001), alice.token)).status, 400)
    assert.equal((await remember(call, roomId, 'ok', alice.token, { scope: 'everyone' })).status, 400)
    assert.equal((await remember(call, roomId, 'ok', alice.token, { scope: 'author' })).status, 201)
  })
})

// ---------------------------------------------------------------- reading and isolation

test('a non-member cannot write, list, or search a room\'s memory', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, stranger, roomId } = await scene()
    await remember(call, roomId, '季度口径以开票日为准', alice.token)
    // Writing is refused, and the refusal is indistinguishable from an unknown room.
    const wrote = await remember(call, roomId, 'x', stranger.token)
    assert.equal(wrote.status, 404)
    assert.equal(wrote.body.error.code, 'NO_SUCH_ROOM')
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, stranger.token)).status, 404)
    assert.equal((await search(call, roomId, '季度', stranger.token)).status, 404)
  })
})

test('a removed member cannot search the history, so leaving ends access to its memory', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    await remember(call, roomId, '季度口径以开票日为准', alice.token)
    assert.equal((await search(call, roomId, '季度', bob.token)).status, 200)

    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    // The same query that worked a moment ago is now refused: membership is re-checked every time.
    assert.equal((await search(call, roomId, '季度', bob.token)).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, bob.token)).status, 404)
  })
})

test('an author-scoped memory is invisible to other members, in listing and in search', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, '我自己的想法：先按新口径试一个月', alice.token, { scope: 'author' })
    assert.equal(created.status, 201, created.raw)
    const memoryId = created.body.memory.id

    // The author sees it.
    const mine = await call('GET', `/rooms/${roomId}/memories`, undefined, alice.token)
    assert.equal(mine.body.memories.length, 1)
    // Another member of the same room does not, and cannot confirm it exists.
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, bob.token)).body.memories.length, 0)
    assert.equal((await search(call, roomId, '新口径', bob.token)).body.memories.length, 0)
    assert.equal((await call('GET', `/memories/${memoryId}`, undefined, bob.token)).status, 404)
  })
})

test('a room-scoped memory is visible to every member', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    await remember(call, roomId, '季度口径以开票日为准', alice.token, { scope: 'room' })
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, bob.token)).body.memories.length, 1)
    assert.equal((await search(call, roomId, '开票日', bob.token)).body.memories.length, 1)
  })
})

test('a stranger and an invented memory id are answered identically', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, stranger, roomId } = await scene()
    const created = await remember(call, roomId, 'something', alice.token)
    const real = await call('GET', `/memories/${created.body.memory.id}`, undefined, stranger.token)
    const invented = await call('GET', '/memories/00000000-0000-4000-8000-000000000000', undefined, stranger.token)
    assert.equal(real.status, 404)
    assert.equal(invented.status, 404)
    // Identical responses: probing cannot confirm that a memory exists.
    assert.deepEqual(real.body, invented.body)
  })
})

test('a room-scoped entry is still not readable by a stranger', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, stranger, roomId } = await scene()
    const created = await remember(call, roomId, 'room-wide', alice.token)
    // Membership is checked independently of scope: a room-scoped entry is for the room, not for
    // anyone who learns its id.
    assert.equal((await call('GET', `/memories/${created.body.memory.id}`, undefined, stranger.token)).status, 404)
  })
})

// ---------------------------------------------------------------- search

test('search matches literally and case-insensitively, and refuses an empty query', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    await remember(call, roomId, 'Quarterly report uses the invoice date', alice.token)
    assert.equal((await search(call, roomId, 'QUARTERLY', alice.token)).body.memories.length, 1)
    assert.equal((await search(call, roomId, 'invoice', alice.token)).body.memories.length, 1)
    assert.equal((await search(call, roomId, 'invoice date', alice.token)).body.memories.length, 1)
    assert.equal((await search(call, roomId, 'no-such-word', alice.token)).body.memories.length, 0)
    assert.equal((await search(call, roomId, '', alice.token)).status, 400)
    assert.equal((await search(call, roomId, 'x'.repeat(201), alice.token)).status, 400)
  })
})

test('search does not return another room memory', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const other = await call('POST', '/rooms', { name: 'Engineering' }, alice.token)
    await remember(call, roomId, 'shared word alpha', alice.token)
    await remember(call, other.body.room.id, 'shared word beta', alice.token)
    const found = await search(call, roomId, 'shared word', alice.token)
    assert.equal(found.body.memories.length, 1)
    assert.match(found.body.memories[0].body, /alpha/)
  })
})

test('a page is filled with visible entries, so a scoped entry cannot push one past the limit', async (t) => {
  await withHub(async ({ db, scene, call }) => {
    const { alice, bob, roomId } = await scene()
    // Five author-scoped entries and one room-scoped, all matching. A filter applied after LIMIT
    // would return only the shared one when the page size is two; the query must do the filtering.
    for (let index = 0; index < 5; index += 1) await remember(call, roomId, `needle private ${index}`, alice.token, { scope: 'author' })
    await remember(call, roomId, 'needle shared', alice.token, { scope: 'room' })

    const visible = await searchMemories(db, { roomId, viewerUserId: bob.userId, query: 'needle', limit: 2 })
    assert.equal(visible.length, 1)
    assert.match(visible[0].body, /shared/)
    const authorView = await searchMemories(db, { roomId, viewerUserId: alice.userId, query: 'needle', limit: 2 })
    assert.equal(authorView.length, 2, 'the author sees their own entries filling the page')
  })
})

// ---------------------------------------------------------------- revision and correction

test('a correction keeps the previous text and raises the revision', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, '口径以开票日为准', alice.token)
    const memoryId = created.body.memory.id

    const revised = await call('PATCH', `/memories/${memoryId}`, { body: '口径以发货日为准', expectedRevision: 1 }, alice.token)
    assert.equal(revised.status, 200, revised.raw)
    assert.equal(revised.body.memory.revision, 2)
    assert.equal(revised.body.memory.body, '口径以发货日为准')

    const detail = await call('GET', `/memories/${memoryId}`, undefined, alice.token)
    assert.equal(detail.body.revisions.length, 1)
    // The earlier text is the evidence that a correction happened, so it is kept verbatim.
    assert.equal(detail.body.revisions[0].previousBody, '口径以开票日为准')
    assert.equal(detail.body.revisions[0].newBody, '口径以发货日为准')
    assert.equal(detail.body.revisions[0].editorUserId, alice.userId)
  })
})

test('a second correction appends rather than replacing, so the whole trail survives', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'v1', alice.token)
    const memoryId = created.body.memory.id
    await call('PATCH', `/memories/${memoryId}`, { body: 'v2', expectedRevision: 1 }, alice.token)
    await call('PATCH', `/memories/${memoryId}`, { body: 'v3', expectedRevision: 2 }, alice.token)
    const detail = await call('GET', `/memories/${memoryId}`, undefined, alice.token)
    assert.deepEqual(detail.body.revisions.map(r => [r.revision, r.previousBody, r.newBody]), [
      [2, 'v1', 'v2'],
      [3, 'v2', 'v3'],
    ])
  })
})

test('only the author may correct an entry, and an admin cannot rewrite what someone said', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, 'alice said this', alice.token)
    const memoryId = created.body.memory.id
    assert.equal((await call('PATCH', `/memories/${memoryId}`, { body: 'bob says otherwise' }, bob.token)).status, 403)
    // Promote Bob: even an admin may not rewrite the author's words through this route.
    await call('POST', `/rooms/${roomId}/members/${bob.userId}/role`, { role: 'admin' }, alice.token)
    const asAdmin = await call('PATCH', `/memories/${memoryId}`, { body: 'admin rewrite' }, bob.token)
    assert.equal(asAdmin.status, 403)
    assert.equal(asAdmin.body.error.code, 'NOT_THE_AUTHOR')
    assert.equal((await call('GET', `/memories/${memoryId}`, undefined, alice.token)).body.memory.body, 'alice said this')
  })
})

test('a stale revision is refused rather than overwriting a correction', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'v1', alice.token)
    const memoryId = created.body.memory.id
    await call('PATCH', `/memories/${memoryId}`, { body: 'v2', expectedRevision: 1 }, alice.token)
    const stale = await call('PATCH', `/memories/${memoryId}`, { body: 'from a stale tab', expectedRevision: 1 }, alice.token)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT')
    assert.equal((await call('GET', `/memories/${memoryId}`, undefined, alice.token)).body.memory.body, 'v2')
  })
})

test('correcting a deleted entry is refused, so a deletion is not undone by an edit', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'v1', alice.token)
    const memoryId = created.body.memory.id
    await call('DELETE', `/memories/${memoryId}`, undefined, alice.token)
    const revised = await call('PATCH', `/memories/${memoryId}`, { body: 'v2' }, alice.token)
    assert.equal(revised.status, 409)
    assert.equal(revised.body.error.code, 'MEMORY_DELETED')
  })
})

// ---------------------------------------------------------------- deletion

test('the author may delete, and the trail stays readable', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, 'a decision that can be withdrawn', alice.token)
    const memoryId = created.body.memory.id
    await call('PATCH', `/memories/${memoryId}`, { body: 'a corrected decision' }, alice.token)

    const deleted = await call('DELETE', `/memories/${memoryId}`, undefined, alice.token)
    assert.equal(deleted.status, 200, deleted.raw)
    assert.equal(deleted.body.memory.deleted, true)
    // The body is cleared, so a deleted entry cannot leak through a later read.
    assert.equal(deleted.body.memory.body, '')
    assert.equal((await call('GET', `/memories/${memoryId}`, undefined, alice.token)).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, bob.token)).body.memories.length, 0)
    assert.equal((await search(call, roomId, 'decision', bob.token)).body.memories.length, 0)

    // The revision trail survives: the group can see that a correction happened before the
    // deletion, which is the record a deletion must not erase.
    const revisions = await call('GET', `/memories/${memoryId}/revisions`, undefined, bob.token)
    assert.equal(revisions.status, 200)
    assert.deepEqual(revisions.body.revisions.map(r => [r.previousBody, r.newBody]), [
      ['a decision that can be withdrawn', 'a corrected decision'],
    ])
  })
})

test('a room admin may delete another member entry, and the audit says it was an admin', async (t) => {
  await withHub(async ({ call, scene, db }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, 'bob said this', bob.token)
    const memoryId = created.body.memory.id
    assert.equal((await call('DELETE', `/memories/${memoryId}`, undefined, alice.token)).status, 200)
    const events = db.prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'memory.deleted%'").all().map(r => r.event_type)
    // The admin action is recorded as an admin action, not disguised as the author's own.
    assert.ok(events.includes('memory.deleted_by_admin'), events.join(', '))
  })
})

test('a plain member cannot delete an entry that is not theirs, and a stranger cannot either', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, stranger, roomId } = await scene()
    const created = await remember(call, roomId, 'alice said this', alice.token)
    const memoryId = created.body.memory.id
    const byMember = await call('DELETE', `/memories/${memoryId}`, undefined, bob.token)
    assert.equal(byMember.status, 403)
    assert.equal(byMember.body.error.code, 'NOT_ALLOWED_TO_DELETE')
    assert.equal((await call('DELETE', `/memories/${memoryId}`, undefined, stranger.token)).status, 404)
    assert.equal((await call('GET', `/memories/${memoryId}`, undefined, alice.token)).status, 200)
  })
})

test('deleting twice succeeds, so a retry is harmless', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'x', alice.token)
    const memoryId = created.body.memory.id
    assert.equal((await call('DELETE', `/memories/${memoryId}`, undefined, alice.token)).status, 200)
    assert.equal((await call('DELETE', `/memories/${memoryId}`, undefined, alice.token)).status, 200)
  })
})

// ---------------------------------------------------------------- validity

test('an expired memory stops being returned, and is not silently deleted', async (t) => {
  await withHub(async ({ call, scene, db }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, 'a temporary convention', alice.token, { expiresAt: '2000-01-01T00:00:00.000Z' })
    assert.equal(created.status, 201, created.raw)
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, bob.token)).body.memories.length, 0)
    assert.equal((await search(call, roomId, 'temporary', bob.token)).body.memories.length, 0)
    // The row and its trail still exist, because expiry is not deletion.
    const row = db.prepare('SELECT deleted_at, expires_at FROM group_memories WHERE id = ?').get(created.body.memory.id)
    assert.equal(row.deleted_at, null)
    assert.equal(row.expires_at, '2000-01-01T00:00:00.000Z')
  })
})

test('a memory may be given a validity window when it is corrected', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'a convention', alice.token)
    const revised = await call('PATCH', `/memories/${created.body.memory.id}`, {
      body: 'a convention for this quarter only', expectedRevision: 1, expiresAt: '2000-01-01T00:00:00.000Z',
    }, alice.token)
    assert.equal(revised.status, 200, revised.raw)
    assert.equal(revised.body.memory.expiresAt, '2000-01-01T00:00:00.000Z')
    assert.equal((await call('GET', `/rooms/${roomId}/memories`, undefined, alice.token)).body.memories.length, 0)
  })
})

// ---------------------------------------------------------------- audit and store-level guards

test('memory changes are audited with the actor and without the body', async (t) => {
  await withHub(async ({ call, scene, db }) => {
    const { alice, roomId } = await scene()
    const created = await remember(call, roomId, 'confidential text that must not be audited', alice.token)
    await call('PATCH', `/memories/${created.body.memory.id}`, { body: 'confidential corrected text' }, alice.token)
    await call('DELETE', `/memories/${created.body.memory.id}`, undefined, alice.token)

    const rows = db.prepare("SELECT event_type, safe_details_json, outcome FROM audit_events WHERE object_type = 'group_memory'").all()
    const types = rows.map(r => r.event_type)
    for (const expected of ['memory.created', 'memory.revised', 'memory.deleted']) {
      assert.ok(types.includes(expected), `expected ${expected} in ${types.join(', ')}`)
    }
    assert.equal(rows.every(r => r.outcome === 'success'), true)
    const details = rows.map(r => r.safe_details_json).join(' ')
    assert.equal(details.includes('confidential'), false)
  })
})

test('the store enforces membership even when called directly, so a future route cannot skip it', async (t) => {
  await withHub(async ({ db, scene }) => {
    const { stranger, roomId } = await scene()
    assert.throws(() => listMemories(db, { roomId, viewerUserId: stranger.userId }), /not a member/)
    assert.throws(() => searchMemories(db, { roomId, viewerUserId: stranger.userId, query: 'x' }), /not a member/)
  })
})

test('an author-scoped entry is readable by its author, and by nobody else in the room', async (t) => {
  await withHub(async ({ db, scene, call }) => {
    const { alice, bob, roomId } = await scene()
    const created = await remember(call, roomId, 'mine alone', alice.token, { scope: 'author' })
    const row = db.prepare('SELECT * FROM group_memories WHERE id = ?').get(created.body.memory.id)
    assert.equal(mayRead(row, alice.userId), true)
    assert.equal(mayRead(row, bob.userId), false)
  })
})
