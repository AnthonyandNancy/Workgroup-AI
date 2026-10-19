// A Bot's words reaching the room: recording a result, then publishing it by sharing.
//
// The requirement this file guards is the one that turns a task card into a conversation: the Bot
// that did the work must be able to *speak* in the room it worked in. Three rules keep that from
// becoming a way to put words in somebody's mouth:
//
//   * the result text is recorded only by the task's owner, because only the owner's machine ran it;
//   * the text is born private — a progress line never carries it — and only `share` publishes it;
//   * the Bot that speaks is the one the owner approved for this task, chosen by the server, so no
//     request body can name a Bot its sender does not own.
//
// `keep` is deliberately silent: keeping a result is the decision *not* to publish it.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { transition } from '../src/modules/tasks/store.js'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { makeWorkgroup } from './helpers/workgroup.js'

const SIGNING_KEY = 'i-bot-messages-test-signing-key-long-enough'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-i-'))
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
  /**
   * A room with one member, who owns one published Bot in it, and one task already approved for that
   * Bot: the state a Host is in right after the owner says yes and the work finishes.
   */
  const scene = async ({ ready = true } = {}) => {
    const alice = await person('botmsg.a')
    const created = await makeWorkgroup(call, alice, { name: 'Bot room' })
    const roomId = created.body.room.id
    await call('POST', '/bots', { botId: 'mine', displayName: 'Mine', visibility: 'room' }, alice.token)
    const joined = await call('POST', `/rooms/${roomId}/bots`, { botId: 'mine' }, alice.token)
    assert.equal(joined.status, 201, joined.raw)
    const task = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: alice.userId, targetBotId: 'mine', description: '整理纪要' }, alice.token)
    assert.equal(task.status, 201, task.raw)
    const decided = await call('POST', `/tasks/${task.body.task.id}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'mine',
    }, alice.token)
    assert.equal(decided.status, 200, decided.raw)
    const taskId = task.body.task.id
    if (ready) {
      // The owner's machine starts the work and reports that it finished; only then is there a
      // result to record and a task in the state a share acts on. These moves are the Host's, and the
      // store enforces them so no route can skip one.
      transition(db, { taskId, to: 'QUEUED', expectedVersion: 1 })
      transition(db, { taskId, to: 'RUNNING', expectedVersion: 2 })
      transition(db, { taskId, to: 'REVIEW_REQUIRED', expectedVersion: 3 })
    }
    return { alice, roomId, taskId }
  }
  try {
    await run({ config, db, server, call, person, scene })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('a shared result becomes a message from the Bot that produced it', async () => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId, taskId } = await scene()
    const recorded = await call('POST', `/tasks/${taskId}/result`, { text: '本周三份纪要已整理完成。' }, alice.token)
    assert.equal(recorded.status, 200, recorded.raw)
    assert.equal(recorded.body.task.resultText, '本周三份纪要已整理完成。')

    const shared = await call('POST', `/tasks/${taskId}/share`, { expectedVersion: 4, recipients: [alice.userId] }, alice.token)
    assert.equal(shared.status, 200, shared.raw)
    assert.equal(shared.body.message.senderBotId, 'mine')
    assert.equal(shared.body.message.senderBotDisplayName, 'Mine')
    assert.equal(shared.body.message.body, '本周三份纪要已整理完成。')
    // The accountable person is still recorded: the Bot speaks, but its owner answers for it.
    assert.equal(shared.body.message.senderUserId, alice.userId)

    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    const botLines = page.body.messages.filter(message => message.senderBotId === 'mine')
    assert.equal(botLines.length, 1, 'the result appears exactly once in the room')
    assert.equal(botLines[0].senderBotDisplayName, 'Mine')
  })
})

test('keeping a result publishes nothing', async () => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId, taskId } = await scene()
    await call('POST', `/tasks/${taskId}/result`, { text: '保留，不发布。' }, alice.token)
    const before = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    const kept = await call('POST', `/tasks/${taskId}/keep`, { expectedVersion: 4 }, alice.token)
    assert.equal(kept.status, 200, kept.raw)
    const after = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(after.body.messages.length, before.body.messages.length)
  })
})

test('only the owner records a result, and only a decided task with text', async () => {
  await withHub(async ({ call, person, scene }) => {
    const { alice, taskId } = await scene()
    const stranger = await person('botmsg.b')
    const refused = await call('POST', `/tasks/${taskId}/result`, { text: 'mine now' }, stranger.token)
    assert.equal(refused.status, 403, refused.raw)
    assert.equal(refused.body.error.code, 'NOT_TASK_OWNER')

    const empty = await call('POST', `/tasks/${taskId}/result`, { text: '   ' }, alice.token)
    assert.equal(empty.status, 400, empty.raw)
    assert.equal(empty.body.error.code, 'INVALID_RESULT')
  })
})

test('a result is private until it is shared', async () => {
  await withHub(async ({ call, person, scene }) => {
    const { alice, roomId, taskId } = await scene()
    await call('POST', `/tasks/${taskId}/result`, { text: '内部草稿，尚未分享。' }, alice.token)
    // A second member of the same room reads the task list and the event stream; neither carries the
    // text, because a result belongs to the owner until they publish it.
    const bob = await person('botmsg.c')
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    const asBob = await call('GET', `/rooms/${roomId}/tasks`, undefined, bob.token)
    assert.equal(asBob.status, 200, asBob.raw)
    assert.equal(JSON.stringify(asBob.body).includes('内部草稿'), false)
    const events = await call('GET', `/rooms/${roomId}/task-events`, undefined, bob.token)
    assert.equal(JSON.stringify(events.body).includes('内部草稿'), false)
    // And nothing was written to the room yet.
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(page.body.messages.some(message => message.senderBotId === 'mine'), false)
  })
})

test('sharing twice does not duplicate the Bot line', async () => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId, taskId } = await scene()
    await call('POST', `/tasks/${taskId}/result`, { text: '只出现一次。' }, alice.token)
    await call('POST', `/tasks/${taskId}/share`, { expectedVersion: 4, recipients: [alice.userId] }, alice.token)
    // The second share meets the state machine's refusal; the message written by the first stays one.
    await call('POST', `/tasks/${taskId}/share`, { expectedVersion: 4, recipients: [alice.userId] }, alice.token)
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(page.body.messages.filter(message => message.senderBotId === 'mine').length, 1)
  })
})

test('a Bot message cannot be attributed to a Bot its sender does not own', async () => {
  await withHub(async ({ call, person, scene }) => {
    const { alice, roomId } = await scene()
    const mallory = await person('botmsg.d')
    // Mallory is in the room but owns no Bot, so claiming one produces a refusal rather than a
    // message that puts words in a colleague's Bot's mouth.
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: mallory.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, mallory.token)
    const forged = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'forged-bot-line-id', body: 'not mine', senderBotId: 'mine',
    }, mallory.token)
    // The route never reads a Bot id from the body, so the forged field is simply not a message from
    // that Bot; the line is Mallory's own.
    assert.equal(forged.status, 201, forged.raw)
    assert.equal(forged.body.message.senderBotId, undefined)
    assert.equal(forged.body.message.senderUserId, mallory.userId)
  })
})

test('a hidden Bot is refused when the message names it directly', async () => {
  await withHub(async ({ call, db, scene }) => {
    const { alice, roomId } = await scene()
    const { sendMessage } = await import('../src/modules/messages/store.js')
    db.prepare('UPDATE room_bots SET removed_at = ? WHERE room_id = ? AND bot_id = ?')
      .run(new Date().toISOString(), roomId, 'mine')
    assert.throws(() => sendMessage(db, {
      roomId,
      senderUserId: alice.userId,
      clientMessageId: 'bot-left-the-room',
      body: 'still here?',
      senderBotId: 'mine',
    }), /not a member of this workgroup/)
  })
})

test('every page carries the human sender name, so a reload can show who spoke', async () => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const sent = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'plain-message-id', body: 'hello' }, alice.token)
    assert.equal(sent.status, 201, sent.raw)
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    const plain = page.body.messages.find(message => message.id === sent.body.message.id)
    assert.equal(plain.senderDisplayName, 'botmsg.a')
    assert.equal('senderBotId' in plain, false)
  })
})
