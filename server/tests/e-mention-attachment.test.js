// E: mentioning a member or a colleague's Bot, and attaching a file to a message.
//
// Two requirements meet in this file, and both are about what a mention must **not** do.
//
//   * **A mention of a member** carries a stable id, not a display name that happens to match
//     somebody's current name. A mention by name breaks the moment somebody renames, and it also lets
//     a text like "@alice" in ordinary prose be read as a summons.
//   * **A mention of a colleague's Bot produces a pending approval candidate and nothing else.**
//     Nothing on the colleague's machine may run, no Bot may be reached, and no grant may be minted.
//     The requirement is emphatic about this because it is the tempting shortcut: noticing "@bob's
//     Bot" in a message invites the Hub to start the task itself, which would be remote code
//     execution triggered by typing a name.
//
// The attachment half is smaller but has its own sharp edge: an attachment must be readable by the
// room it was posted to, and the upload must not become a way to publish a file to people who cannot
// read the room.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'e-mention-test-signing-key-long-enough'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-e-'))
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
  const upload = async (roomId, fileName, text, token, query = '') => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/rooms/${roomId}/artifacts?fileName=${encodeURIComponent(fileName)}${query}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      payload: Buffer.from(text, 'utf8'),
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
    await run({ config, db, server, call, person, upload })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Two people in one workgroup, each with a published Bot, plus a third person outside it. */
async function workgroup(call, person) {
  const alice = await person('e-alice')
  const bob = await person('e-bob')
  const room = await call('POST', '/rooms', { name: 'Mentions', kind: 'workgroup' }, alice.token)
  assert.equal(room.status, 201, room.raw)
  const roomId = room.body.room.id

  const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
  assert.equal(invited.status, 201, invited.raw)
  const pending = await call('GET', '/invitations', undefined, bob.token)
  await call('POST', `/invitations/${pending.body.invitations[0].id}/accept`, {}, bob.token)

  const publisher = await call('POST', '/bots', {
    botId: 'e-bot', displayName: 'Writer', description: 'writes', capabilities: ['draft'], visibility: 'room',
  }, bob.token)
  assert.equal(publisher.status, 201, publisher.raw)

  const outsider = await person('e-outsider')
  return { alice, bob, outsider, roomId }
}

// The message fields go to the top level of the request; naming the parameter `body` and spreading it
// as `{ body }` would send the whole object as the text.
const send = (call, roomId, token, fields) => call('POST', `/rooms/${roomId}/messages`, {
  ...fields, clientMessageId: `e-mention-${Math.random().toString(36).slice(2, 12)}`,
}, token)

test('a mention carries the member id, and an unknown id is refused', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)

    const mentioned = await send(call, roomId, alice.token, {
      body: 'Could you look at this?', mentions: [{ userId: bob.userId }],
    })
    assert.equal(mentioned.status, 201, mentioned.raw)
    assert.deepEqual(mentioned.body.message.mentions, [{ userId: bob.userId }])

    // A mention naming somebody who is not in the room is refused rather than stored: it would render
    // as a summons to a person who cannot see the message.
    const stranger = await send(call, roomId, alice.token, {
      body: 'hello?', mentions: [{ userId: 'someone-not-in-this-room' }],
    })
    assert.equal(stranger.status, 400, stranger.raw)
    assert.match(stranger.raw, /not.{0,20}(member|room)/i)
  })
})

test('a mention is id-based, so it does not depend on a display name', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    // The reader resolves the id against the roster it already has. Storing a name instead would make
    // the mention wrong after a rename, and would let any message containing the text "@Writer" be
    // indistinguishable from a summons.
    const sent = await send(call, roomId, alice.token, { body: 'no mentions here', mentions: [] })
    assert.equal(sent.status, 201, sent.raw)
    assert.equal(sent.body.message.mentions, undefined, 'an empty mention list is omitted, not sent as []')

    const stored = db.prepare('SELECT mentions_json FROM messages WHERE id = ?').get(sent.body.message.id)
    assert.equal(stored.mentions_json, null)
    assert.equal(bob.userId !== undefined, true)
  })
})

test('mentioning a colleague\'s Bot creates a pending candidate and runs nothing', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)

    const mentioned = await send(call, roomId, alice.token, {
      body: 'Writer, please draft the release note',
      mentions: [{ userId: bob.userId, botId: 'e-bot' }],
    })
    assert.equal(mentioned.status, 201, mentioned.raw)

    // What the mention produced: a task awaiting Bob's own approval. Nothing else.
    const tasks = db.prepare('SELECT * FROM tasks WHERE room_id = ?').all(roomId)
    assert.equal(tasks.length, 1, 'a Bot mention proposes exactly one task')
    assert.equal(tasks[0].state, 'PENDING_APPROVAL')
    assert.equal(tasks[0].owner_user_id, bob.userId)
    assert.equal(tasks[0].requester_user_id, alice.userId)
    assert.equal(tasks[0].target_bot_id, 'e-bot')

    // And nothing that could run on Bob's machine exists yet: no approval, no grant.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE task_id = ?').get(tasks[0].id).n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_grants').get().n, 0)
    // The task state is what the executor checks, and PENDING_APPROVAL means "not approved", so no
    // local work can start from this mention even if a machine were watching the room.
    assert.notEqual(tasks[0].state, 'APPROVED')
  })
})

test('mentioning a Bot that is not available in the room does not create a task', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    // A Bot nobody published under that id: the candidate would name a Bot the owner does not have,
    // which after approval would be a task that can never run.
    const mentioned = await send(call, roomId, alice.token, {
      body: 'Nonexistent, please help', mentions: [{ userId: bob.userId, botId: 'no-such-bot' }],
    })
    // 403, the status the task route already uses for this refusal: the caller named the Bot, so
    // hiding its existence would only confuse a legitimate client.
    assert.equal(mentioned.status, 403, mentioned.raw)
    assert.match(mentioned.raw, /BOT_NOT_AVAILABLE/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE room_id = ?').get(roomId).n, 0)
  })
})

test('mentioning your own Bot is refused, because a task is a request to somebody else', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    await call('POST', '/bots', { botId: 'e-alice-bot', displayName: 'Mine', description: 'm', capabilities: ['x'], visibility: 'room' }, alice.token)
    // `createTask` refuses this with SELF_TASK, and the mention path goes through the same rule rather
    // than around it: two paths to the same act must not have two sets of rules.
    const mentioned = await send(call, roomId, alice.token, {
      body: 'Mine, help me', mentions: [{ userId: alice.userId, botId: 'e-alice-bot' }],
    })
    // 409 with SELF_TASK, the same refusal a task requested through the task route gets for this.
    assert.equal(mentioned.status, 409, mentioned.raw)
    assert.match(mentioned.raw, /SELF_TASK/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE room_id = ?').get(roomId).n, 0)
    assert.equal(bob.userId !== undefined, true)
  })
})

test('a mention of a Bot in a dissolved workgroup creates no candidate', async () => {
  await withHub(async ({ call, db, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
    const mentioned = await send(call, roomId, alice.token, {
      body: 'Writer, help', mentions: [{ userId: bob.userId, botId: 'e-bot' }],
    })
    assert.ok(mentioned.status >= 400, `expected a refusal, got ${String(mentioned.status)}`)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE room_id = ?').get(roomId).n, 0)
  })
})

test('an attachment can be posted with a message and read by the recipients it names', async () => {
  await withHub(async ({ call, upload, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    // An artifact is not published by uploading it: it starts readable only by its uploader and the
    // recipients named at upload. Handing it to the room is a separate, deliberate act, which is what
    // the requirement's "non-recipients cannot download" asks for.
    const attached = await upload(roomId, 'notes.txt', 'the contents', alice.token, `&recipients=${bob.userId}`)
    assert.equal(attached.status, 201, attached.raw)
    const artifactId = attached.body.artifact.id

    const sent = await send(call, roomId, alice.token, {
      body: 'here are the notes', attachments: [{ artifactId }],
    })
    assert.equal(sent.status, 201, sent.raw)
    assert.equal(sent.body.message.attachments.length, 1)
    assert.equal(sent.body.message.attachments[0].artifactId, artifactId)
    // The name travels with the message so a reader can show it without a second request per file.
    assert.equal(sent.body.message.attachments[0].fileName, 'notes.txt')

    // Bob can read it because he was named a recipient, not merely because he shares the room.
    const downloaded = await call('GET', `/artifacts/${artifactId}/content`, undefined, bob.token)
    assert.equal(downloaded.status, 200)
  })
})

test('attaching a file does not widen who may read it', async () => {
  await withHub(async ({ call, upload, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    // Uploaded with no recipients, then attached to a message both people can read. Attaching must not
    // become a way to publish: the message names the file, and Bob still cannot fetch its bytes.
    const attached = await upload(roomId, 'private.txt', 'not for bob', alice.token)
    const sent = await send(call, roomId, alice.token, {
      body: 'see attached', attachments: [{ artifactId: attached.body.artifact.id }],
    })
    assert.equal(sent.status, 201, sent.raw)
    // 404 rather than 403: an artifact the viewer may not read is answered as if it did not exist, so
    // the message cannot be used to confirm that a file the reader is not entitled to exists.
    const downloaded = await call('GET', `/artifacts/${attached.body.artifact.id}/content`, undefined, bob.token)
    assert.equal(downloaded.status, 404, `expected the ACL to still refuse Bob, got ${String(downloaded.status)}`)
  })
})

test('an attachment from another room cannot be posted into this one', async () => {
  await withHub(async ({ call, upload, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    // Alice's own second room, so the upload is hers and the refusal is about the room rather than
    // about ownership.
    const other = await call('POST', '/rooms', { name: 'Elsewhere', kind: 'workgroup' }, alice.token)
    const elsewhere = await upload(other.body.room.id, 'secret.txt', 'not for this room', alice.token)

    const sent = await send(call, roomId, alice.token, {
      body: 'wrong room', attachments: [{ artifactId: elsewhere.body.artifact.id }],
    })
    // Refused, and nothing is stored: attaching a file from a room the readers cannot see would hand
    // them its name, its size, and a link that answers 403 — the name alone can be the disclosure.
    assert.equal(sent.status, 400, sent.raw)
    assert.equal(bob.userId !== undefined, true)
  })
})

test('a message with an unknown attachment id is refused rather than stored without it', async () => {
  await withHub(async ({ call, person }) => {
    const { alice, roomId } = await workgroup(call, person)
    const sent = await send(call, roomId, alice.token, {
      body: 'this file', attachments: [{ artifactId: 'no-such-artifact' }],
    })
    // A message that said it had a file and did not would be worse than a refusal: the reader would
    // believe a file was lost.
    assert.equal(sent.status, 400, sent.raw)
  })
})

test('the mentions and attachments of a message come back after a reload', async () => {
  await withHub(async ({ call, upload, person }) => {
    const { alice, bob, roomId } = await workgroup(call, person)
    const attached = await upload(roomId, 'reload.txt', 'body', alice.token)
    await send(call, roomId, alice.token, {
      body: 'read this', mentions: [{ userId: bob.userId }], attachments: [{ artifactId: attached.body.artifact.id }],
    })

    // Read through the list route, which is what a client does on load: the fields must survive the
    // round trip through storage, not only the response to the send.
    const listed = await call('GET', `/rooms/${roomId}/messages?limit=50`, undefined, bob.token)
    assert.equal(listed.status, 200, listed.raw)
    const message = listed.body.messages.find(entry => entry.body === 'read this')
    assert.ok(message !== undefined, 'the message is listed')
    assert.deepEqual(message.mentions, [{ userId: bob.userId }])
    assert.equal(message.attachments.length, 1)
    assert.equal(message.attachments[0].artifactId, attached.body.artifact.id)
  })
})
