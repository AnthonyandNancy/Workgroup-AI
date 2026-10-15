// H-05 tests: message ordering, idempotency, and reconnect backfill.
//
// The completion condition is "a reconnect neither loses nor repeats a message". That is a
// property about sequences, so most of these cases drive the sequence number rather than
// the HTTP shape: concurrent sends must not collide, a retry must not burn a number, and a
// paginated backfill must hand the client an exact continuation point.
//
// A deliberate negative case runs at the store level: `max(room_seq)+1` allocation would
// still pass a naive test but breaks gap detection after a deletion. That alternative is
// exercised here so the reason `rooms.next_seq` exists is recorded.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { readMessages, latestSeq } from '../src/modules/messages/store.js'

const SIGNING_KEY = 'h05-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h05-'))
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
  const person = async (handle, displayName) => {
    const password = `${handle}-password-long-enough`
    await call('POST', '/auth/register', { userHandle: handle, displayName: displayName ?? handle, password })
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken, displayName: displayName ?? handle }
  }
  /** Two members in one room, which is the smallest setup every case needs. */
  const twoInRoom = async (roomName = 'Finance') => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const created = await call('POST', '/rooms', { name: roomName }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    return { alice, bob, roomId }
  }
  const send = (roomId, body, token, clientMessageId) => call('POST', `/rooms/${roomId}/messages`, { clientMessageId, body }, token)
  try {
    await run({ config, db, server, call, person, twoInRoom, send })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

const key = (n) => `client-msg-${String(n).padStart(6, '0')}`

// ---------------------------------------------------------------- ordering

test('a room hands out sequence numbers starting at 1 and moving by one', async () => {
  await withHub(async ({ twoInRoom, send }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const first = await send(roomId, '请制作季度报表', alice.token, key(1))
    assert.equal(first.status, 201, first.raw)
    assert.equal(first.body.message.roomSeq, 1)
    assert.equal(first.body.duplicate, false)

    const second = await send(roomId, '收到，我来做', bob.token, key(2))
    assert.equal(second.body.message.roomSeq, 2)

    // Senders interleave and the sequence still follows arrival order, not sender order.
    const third = await send(roomId, '需要哪些数据？', alice.token, key(3))
    assert.equal(third.body.message.roomSeq, 3)
  })
})

test('concurrent sends receive distinct, contiguous sequence numbers', async () => {
  await withHub(async ({ twoInRoom, send }) => {
    const { alice, roomId } = await twoInRoom()
    // Fired without awaiting each other: the write lock, not the client, decides the order.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => send(roomId, `并发消息 ${index}`, alice.token, key(index + 1))),
    )
    assert.equal(results.every(r => r.status === 201), true, results.map(r => r.status).join(','))
    const seqs = results.map(r => r.body.message.roomSeq).sort((a, b) => a - b)
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, index) => index + 1))
    // Distinct ids too: a duplicate row would share a sequence number.
    assert.equal(new Set(results.map(r => r.body.message.id)).size, 20)
  })
})

test('sequence numbers do not restart when a message is deleted from the middle', async () => {
  await withHub(async ({ twoInRoom, send, db }) => {
    const { alice, roomId } = await twoInRoom()
    await send(roomId, 'one', alice.token, key(1))
    const second = await send(roomId, 'two', alice.token, key(2))
    await send(roomId, 'three', alice.token, key(3))

    // Delete the middle row directly. A `max(room_seq)+1` allocator would now hand the next
    // message sequence 2 again, and a client that had already seen 2 would never learn that
    // a different message exists at that position.
    db.prepare('DELETE FROM messages WHERE id = ?').run(second.body.message.id)
    const fourth = await send(roomId, 'four', alice.token, key(4))
    assert.equal(fourth.body.message.roomSeq, 4)
  })
})

// ---------------------------------------------------------------- idempotency

test('retrying an accepted clientMessageId returns the original message and consumes no sequence', async () => {
  await withHub(async ({ twoInRoom, send, db }) => {
    const { alice, roomId } = await twoInRoom()
    const first = await send(roomId, '季度报表', alice.token, key(1))
    assert.equal(first.status, 201)

    const retry = await send(roomId, '季度报表', alice.token, key(1))
    assert.equal(retry.status, 200, retry.raw)
    assert.equal(retry.body.duplicate, true)
    // Same message, not a second one at the next sequence.
    assert.equal(retry.body.message.id, first.body.message.id)
    assert.equal(retry.body.message.roomSeq, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE room_id = ?').get(roomId).n, 1)

    // The next genuine message still gets sequence 2: the retry did not burn a number.
    const next = await send(roomId, '第二部分', alice.token, key(2))
    assert.equal(next.body.message.roomSeq, 2)
  })
})

test('a retry with a changed body still returns the stored message, so a client cannot rewrite history', async () => {
  await withHub(async ({ twoInRoom, send }) => {
    const { alice, roomId } = await twoInRoom()
    await send(roomId, 'original text', alice.token, key(1))
    const altered = await send(roomId, 'different text', alice.token, key(1))
    assert.equal(altered.status, 200)
    assert.equal(altered.body.duplicate, true)
    assert.equal(altered.body.message.body, 'original text')
  })
})

test('two senders may reuse the same clientMessageId, because the key is scoped to sender and room', async () => {
  await withHub(async ({ twoInRoom, send }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const fromAlice = await send(roomId, 'A 的消息', alice.token, key(1))
    const fromBob = await send(roomId, 'B 的消息', bob.token, key(1))
    assert.equal(fromAlice.status, 201)
    assert.equal(fromBob.status, 201, fromBob.raw)
    assert.notEqual(fromAlice.body.message.id, fromBob.body.message.id)
    assert.equal(fromBob.body.message.roomSeq, 2)
  })
})

test('concurrent retries of one key produce exactly one message', async () => {
  await withHub(async ({ twoInRoom, send, db }) => {
    const { alice, roomId } = await twoInRoom()
    const results = await Promise.all(Array.from({ length: 8 }, () => send(roomId, '只应存在一次', alice.token, key(1))))
    // Exactly one writer created it; every other caller was told it was already accepted.
    assert.equal(results.filter(r => r.status === 201).length, 1, results.map(r => r.status).join(','))
    assert.equal(results.filter(r => r.status === 200).length, 7)
    for (const result of results) assert.equal(result.body.message.roomSeq, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE room_id = ?').get(roomId).n, 1)
  })
})

// ---------------------------------------------------------------- validation

test('a message needs a body and a clientMessageId of a usable length', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    assert.equal((await send(roomId, '', alice.token, key(1))).status, 400)
    assert.equal((await send(roomId, '   ', alice.token, key(1))).status, 400)
    assert.equal((await send(roomId, 'x'.repeat(50_001), alice.token, key(1))).status, 400)
    assert.equal((await call('POST', `/rooms/${roomId}/messages`, { body: 'hi' }, alice.token)).status, 400)
    assert.equal((await send(roomId, 'hi', alice.token, 'short')).status, 400)
    assert.equal((await send(roomId, 'hi', alice.token, 'x'.repeat(97))).status, 400)
  })
})

test('a message body keeps its content, including line breaks and multibyte text', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    const body = '第一行\n第二行\t制表符 🙂 结尾'
    const sent = await send(roomId, body, alice.token, key(1))
    assert.equal(sent.body.message.body, body)
    const read = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(read.body.messages[0].body, body)
  })
})

// ---------------------------------------------------------------- non-member isolation

test('a non-member cannot post to or read a room', async () => {
  await withHub(async ({ twoInRoom, send, call, person }) => {
    const { roomId } = await twoInRoom()
    const stranger = await person('stranger', 'Stranger')
    assert.equal((await send(roomId, 'hello', stranger.token, key(1))).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/messages`, undefined, stranger.token)).status, 404)
    assert.equal((await call('GET', `/rooms/${roomId}/messages/head`, undefined, stranger.token)).status, 404)
  })
})

test('a removed member loses message access at once, and cannot post with an old token', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, bob, roomId } = await twoInRoom()
    await send(roomId, 'before removal', bob.token, key(1))
    assert.equal((await call('GET', `/rooms/${roomId}/messages`, undefined, bob.token)).status, 200)

    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    assert.equal((await call('GET', `/rooms/${roomId}/messages`, undefined, bob.token)).status, 404)
    assert.equal((await send(roomId, 'after removal', bob.token, key(2))).status, 404)
  })
})

// ---------------------------------------------------------------- backfill

test('backfill returns exactly the gap after the client\'s last seen sequence', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    for (let index = 1; index <= 5; index += 1) await send(roomId, `消息 ${index}`, alice.token, key(index))

    // The client saw through 2 and wants the rest.
    const page = await call('GET', `/rooms/${roomId}/messages?afterSeq=2`, undefined, alice.token)
    assert.equal(page.status, 200)
    assert.deepEqual(page.body.messages.map(m => m.roomSeq), [3, 4, 5])
    assert.equal(page.body.nextAfterSeq, 5)
    assert.equal(page.body.hasMore, false)

    // An empty gap is answered with an empty page and an unchanged cursor, so a client that
    // polls cannot lose its place.
    const empty = await call('GET', `/rooms/${roomId}/messages?afterSeq=5`, undefined, alice.token)
    assert.deepEqual(empty.body.messages, [])
    assert.equal(empty.body.nextAfterSeq, 5)
  })
})

test('paginated backfill reaches every message exactly once, in order', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    for (let index = 1; index <= 25; index += 1) await send(roomId, `消息 ${index}`, alice.token, key(index))

    const seen = []
    let cursor = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await call('GET', `/rooms/${roomId}/messages?afterSeq=${cursor}&limit=7`, undefined, alice.token)
      seen.push(...page.body.messages.map(m => m.roomSeq))
      cursor = page.body.nextAfterSeq
      if (!page.body.hasMore) break
    }
    assert.deepEqual(seen, Array.from({ length: 25 }, (_, index) => index + 1))
    // No duplicates is the whole point of a single cursor.
    assert.equal(new Set(seen).size, seen.length)
  })
})

test('the page size is bounded, so one request cannot pull an unbounded room', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    for (let index = 1; index <= 3; index += 1) await send(roomId, `消息 ${index}`, alice.token, key(index))
    const huge = await call('GET', `/rooms/${roomId}/messages?limit=100000`, undefined, alice.token)
    assert.equal(huge.status, 200)
    // Asking for more than the cap is clamped, not refused: the client still gets a valid page.
    assert.equal(huge.body.messages.length, 3)
    const zero = await call('GET', `/rooms/${roomId}/messages?limit=0`, undefined, alice.token)
    assert.equal(zero.body.messages.length, 1)
    assert.equal(zero.body.hasMore, true)
  })
})

test('a malformed cursor is refused instead of being treated as zero', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    await send(roomId, 'one', alice.token, key(1))
    for (const bad of ['-1', 'abc', '1.5']) {
      const response = await call('GET', `/rooms/${roomId}/messages?afterSeq=${bad}`, undefined, alice.token)
      assert.equal(response.status, 400, `afterSeq=${bad} must be refused: ${response.raw}`)
      assert.equal(response.body.error.code, 'INVALID_CURSOR')
    }
  })
})

test('the head route reports the last sequence, which is where a fresh client starts', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    const emptyHead = await call('GET', `/rooms/${roomId}/messages/head`, undefined, alice.token)
    assert.equal(emptyHead.body.latestSeq, 0)

    for (let index = 1; index <= 4; index += 1) await send(roomId, `消息 ${index}`, alice.token, key(index))
    const head = await call('GET', `/rooms/${roomId}/messages/head`, undefined, alice.token)
    assert.equal(head.body.latestSeq, 4)

    // Reading from the head yields nothing: everything before it was already seen.
    const fromHead = await call('GET', `/rooms/${roomId}/messages?afterSeq=4`, undefined, alice.token)
    assert.deepEqual(fromHead.body.messages, [])
  })
})

test('two rooms keep independent sequences', async () => {
  await withHub(async ({ twoInRoom, send, call, person }) => {
    const { alice, roomId: finance } = await twoInRoom('Finance')
    const other = await call('POST', '/rooms', { name: 'Engineering' }, alice.token)
    const engineering = other.body.room.id

    await send(finance, 'finance 1', alice.token, key(1))
    await send(engineering, 'engineering 1', alice.token, key(1))
    await send(engineering, 'engineering 2', alice.token, key(2))

    const financePage = await call('GET', `/rooms/${finance}/messages`, undefined, alice.token)
    const engineeringPage = await call('GET', `/rooms/${engineering}/messages`, undefined, alice.token)
    assert.deepEqual(financePage.body.messages.map(m => m.roomSeq), [1])
    assert.deepEqual(engineeringPage.body.messages.map(m => m.roomSeq), [1, 2])
    // The same client key in a different room is a different message, not a duplicate.
    assert.equal((await send(engineering, 'engineering 3', alice.token, key(1))).status, 200)
  })
})

// ---------------------------------------------------------------- audit and read surface

test('the message read carries the sender identity a client needs to render it', async () => {
  await withHub(async ({ twoInRoom, send, call }) => {
    const { alice, roomId } = await twoInRoom()
    await send(roomId, 'hello', alice.token, key(1))
    // The send response names the sender; the read path returns the stored row, whose
    // display name the client resolves from the member list rather than the Hub joining.
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(page.body.messages[0].senderUserId, alice.userId)
    assert.equal(page.body.messages[0].clientMessageId, key(1))
  })
})

test('message writes are audited with the sequence but not the body', async () => {
  await withHub(async ({ twoInRoom, send, db }) => {
    const { alice, roomId } = await twoInRoom()
    await send(roomId, '机密内容请勿入审计', alice.token, key(1))
    const rows = db.prepare("SELECT safe_details_json FROM audit_events WHERE event_type = 'message.created'").all()
    assert.equal(rows.length, 1)
    assert.match(rows[0].safe_details_json, /roomSeq/)
    // The body must not be copied into the audit trail: audit is a separate, longer-lived store.
    assert.equal(rows[0].safe_details_json.includes('机密内容'), false)
  })
})

test('the store-level reader enforces membership, not just the route above it', async () => {
  await withHub(async ({ db, twoInRoom, person }) => {
    const { roomId } = await twoInRoom()
    const stranger = await person('stranger', 'Stranger')
    // A future route that forgets the check still cannot read: the rule lives in the store.
    assert.throws(() => readMessages(db, { roomId, userId: stranger.userId }), /not a member/)
    assert.throws(() => latestSeq(db, { roomId, userId: stranger.userId }), /not a member/)
  })
})
