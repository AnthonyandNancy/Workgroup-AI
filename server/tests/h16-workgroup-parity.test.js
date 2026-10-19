import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { makeWorkgroup } from './helpers/workgroup.js'

const SIGNING_KEY = 'h16-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h16-'))
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
    try { json = response.json() } catch { json = undefined }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  const person = async (handle) => {
    const password = `${handle}-password-long-enough`
    const registered = await call('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
    assert.equal(registered.status, 201, registered.raw)
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken, handle }
  }
  try {
    await run({ call, person, db })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('room notice is readable and writable by an admin', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const created = await makeWorkgroup(call, alice, { name: 'Finance' })
    assert.equal(created.status, 201, created.raw)
    const id = created.body.room.id
    const patched = await call('PATCH', `/rooms/${id}`, { notice: 'Read this first' }, alice.token)
    assert.equal(patched.status, 200, patched.raw)
    assert.equal(patched.body.room.notice, 'Read this first')
    const opened = await call('GET', `/rooms/${id}`, undefined, alice.token)
    assert.equal(opened.status, 200, opened.raw)
    assert.equal(opened.body.room.notice, 'Read this first')
  })
})

test('a dissolved room refuses notice changes', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const created = await makeWorkgroup(call, alice, { name: 'Finance' })
    const id = created.body.room.id
    const dissolved = await call('POST', `/rooms/${id}/dissolve`, {}, alice.token)
    assert.equal(dissolved.status, 200, dissolved.raw)
    const patched = await call('PATCH', `/rooms/${id}`, { notice: 'Too late' }, alice.token)
    assert.equal(patched.status, 409, patched.raw)
    assert.equal(patched.body.error.code, 'ROOM_DISSOLVED')
  })
})

test('a member can add an owned Bot and remove it again', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    assert.equal(room.status, 201, room.raw)
    const roomId = room.body.room.id
    const published = await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'private' }, alice.token)
    assert.equal(published.status, 201, published.raw)
    const added = await call('POST', `/rooms/${roomId}/bots`, { botId: 'writer' }, alice.token)
    assert.equal(added.status, 201, added.raw)
    const opened = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.ok(opened.body.bots.some(bot => bot.botId === 'writer'))
    assert.equal(opened.body.bots.length, 3)
    const removed = await call('DELETE', `/rooms/${roomId}/bots/${alice.userId}/writer`, undefined, alice.token)
    assert.equal(removed.status, 200, removed.raw)
    const after = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(after.body.bots.some(bot => bot.botId === 'writer'), false)
    assert.equal(after.body.bots.length, 2)
  })
})

test('another member needs the Bot owner to accept a Bot invitation', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    assert.equal(invited.status, 201, invited.raw)
    const accepted = await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    assert.equal(accepted.status, 200, accepted.raw)
    const published = await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'public' }, bob.token)
    assert.equal(published.status, 201, published.raw)
    const request = await call('POST', `/rooms/${roomId}/bot-invitations`, { ownerUserId: bob.userId, botId: 'writer' }, alice.token)
    assert.equal(request.status, 201, request.raw)
    const inbox = await call('GET', '/bot-invitations', undefined, bob.token)
    assert.equal(inbox.status, 200, inbox.raw)
    assert.equal(inbox.body.invitations.length, 1)
    const acceptedBot = await call('POST', `/bot-invitations/${inbox.body.invitations[0].id}/accept`, {}, bob.token)
    assert.equal(acceptedBot.status, 200, acceptedBot.raw)
    const opened = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(opened.body.bots.some(bot => bot.botId === 'writer' && bot.ownerUserId === bob.userId), true)
  })
})

test('creating a workgroup adds the creator’s Bots in the same transaction', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    assert.equal((await call('POST', '/bots', { botId: 'analyst', displayName: 'Analyst', visibility: 'private', isChief: true }, alice.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'private' }, alice.token)).status, 201)

    const created = await call('POST', '/rooms', {
      name: 'Finance', kind: 'workgroup', botIds: ['analyst', 'writer', 'analyst'], adminBotId: 'analyst',
    }, alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.deepEqual(created.body.bots.map(bot => bot.botId).sort(), ['analyst', 'writer'])
    // The room is readable with the same Bots, so creation returned what the Hub stored.
    const opened = await call('GET', `/rooms/${created.body.room.id}`, undefined, alice.token)
    assert.deepEqual(opened.body.bots.map(bot => bot.botId).sort(), ['analyst', 'writer'])

    // An unpublished Bot refuses the whole creation: no room is left behind and the caller can fix
    // the request and try again.
    const before = await call('GET', '/rooms', undefined, alice.token)
    const refused = await call('POST', '/rooms', {
      name: 'Broken', kind: 'workgroup', botIds: ['analyst', 'never-published'], adminBotId: 'analyst',
    }, alice.token)
    assert.equal(refused.status, 404, refused.raw)
    assert.equal(refused.body.error.code, 'NO_SUCH_BOT')
    const after = await call('GET', '/rooms', undefined, alice.token)
    assert.equal(after.body.rooms.length, before.body.rooms.length)
    assert.equal(after.body.rooms.some(room => room.name === 'Broken'), false)
  })
})

test('declining a Bot invitation answers with the public invitation and resolves it once', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    assert.equal((await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'public' }, bob.token)).status, 201)
    const request = await call('POST', `/rooms/${roomId}/bot-invitations`, { ownerUserId: bob.userId, botId: 'writer' }, alice.token)
    assert.equal(request.status, 201, request.raw)

    const declined = await call('POST', `/bot-invitations/${request.body.invitation.id}/decline`, {}, bob.token)
    assert.equal(declined.status, 200, declined.raw)
    // The wire shape is the public invitation, not the stored row: no internal columns leak.
    assert.deepEqual(Object.keys(declined.body.invitation).sort(), [
      'botDisplayName', 'botId', 'createdAt', 'expiresAt', 'id', 'invitedByUserId', 'ownerUserId', 'roomId', 'roomName', 'status',
    ])
    assert.equal(declined.body.invitation.status, 'declined')

    // A resolved invitation cannot be resolved twice.
    const again = await call('POST', `/bot-invitations/${request.body.invitation.id}/decline`, {}, bob.token)
    assert.equal(again.status, 409, again.raw)
    assert.equal(again.body.error.code, 'INVITATION_NOT_PENDING')

    // And the room never gained the Bot.
    const opened = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(opened.body.bots.some(bot => bot.botId === 'writer'), false)
  })
})

test('a Bot mention is accepted only after the Bot is a room member', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'public' }, bob.token)

    const rejected = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'mention-before-add',
      body: '@Writer please draft',
      mentions: [{ userId: bob.userId, botId: 'writer' }],
    }, alice.token)
    assert.equal(rejected.status, 400, rejected.raw)

    const added = await call('POST', `/rooms/${roomId}/bots`, { botId: 'writer' }, bob.token)
    assert.equal(added.status, 201, added.raw)
    const sent = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'mention-after-add',
      body: '@Writer please draft',
      mentions: [{ userId: bob.userId, botId: 'writer' }],
    }, alice.token)
    assert.equal(sent.status, 201, sent.raw)
    const tasks = await call('GET', `/rooms/${roomId}/tasks`, undefined, alice.token)
    assert.equal(tasks.status, 200, tasks.raw)
    assert.equal(tasks.body.tasks.length, 1)
    assert.equal(tasks.body.tasks[0].targetBotId, 'writer')

    const removed = await call('DELETE', `/rooms/${roomId}/bots/${bob.userId}/writer`, undefined, bob.token)
    assert.equal(removed.status, 200, removed.raw)
    const after = await call('GET', `/rooms/${roomId}/tasks`, undefined, alice.token)
    assert.equal(after.body.tasks[0].state, 'CANCELLED')

    const events = await call('GET', `/rooms/${roomId}/task-events`, undefined, alice.token)
    assert.equal(events.status, 200, events.raw)
    assert.ok(events.body.events.some(event => event.eventType === 'task.cancelled'))
  })
})

test('the room list carries a batched summary of members, Bots, last message and caller approvals', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    await call('POST', '/bots', { botId: 'alice-bot', displayName: 'Alice Bot', visibility: 'private' }, alice.token)
    await call('POST', '/bots', { botId: 'bob-bot', displayName: 'Bob Bot', visibility: 'room' }, bob.token)
    assert.equal((await call('POST', `/rooms/${roomId}/bots`, { botId: 'alice-bot' }, alice.token)).status, 201)
    assert.equal((await call('POST', `/rooms/${roomId}/bots`, { botId: 'bob-bot' }, bob.token)).status, 201)

    const before = await call('GET', '/rooms', undefined, alice.token)
    const empty = before.body.rooms.find(item => item.id === roomId)
    assert.equal(empty.memberCount, 2)
    assert.equal(empty.botCount, 4)
    assert.equal(empty.lastMessageAt, null)
    assert.equal(empty.lastMessagePreview, '')
    assert.equal(empty.lastMessageSeq, 0)
    assert.equal(empty.pendingApprovalCount, 0)

    const first = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'summary-alice-one',
      body: 'Alice asks Bob',
      mentions: [{ userId: bob.userId, botId: 'bob-bot' }],
    }, alice.token)
    assert.equal(first.status, 201, first.raw)
    const second = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'summary-bob-one',
      body: 'Bob asks Alice once',
      mentions: [{ userId: alice.userId, botId: 'alice-bot' }],
    }, bob.token)
    assert.equal(second.status, 201, second.raw)
    const finalBody = `first line\nsecond line ${'x'.repeat(100)}`
    const third = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'summary-bob-two',
      body: finalBody,
      mentions: [{ userId: alice.userId, botId: 'alice-bot' }],
    }, bob.token)
    assert.equal(third.status, 201, third.raw)

    const other = await makeWorkgroup(call, alice, { name: 'Other' })
    assert.equal(other.status, 201, other.raw)
    const listed = await call('GET', '/rooms', undefined, alice.token)
    const summary = listed.body.rooms.find(item => item.id === roomId)
    assert.equal(summary.memberCount, 2)
    assert.equal(summary.botCount, 4)
    assert.equal(summary.lastMessageAt, third.body.message.createdAt)
    assert.equal(summary.lastMessageSeq, third.body.message.roomSeq)
    const expectedPreview = finalBody.replace(/\s+/g, ' ').trim().slice(0, 80)
    assert.equal(summary.lastMessagePreview, expectedPreview)
    assert.equal(summary.lastMessagePreview.length, 80)
    assert.equal(summary.lastMessagePreview.includes('\n'), false)
    // Bob's two mentions of Alice's Bot are Alice's approvals, not Bob's, and Alice's mention of
    // Bob's Bot is Bob's. The count must follow the caller, not the room.
    assert.equal(summary.pendingApprovalCount, 2)
    const seenByBob = await call('GET', '/rooms', undefined, bob.token)
    assert.equal(seenByBob.body.rooms.find(item => item.id === roomId).pendingApprovalCount, 1)
    const otherSummary = listed.body.rooms.find(item => item.id === other.body.room.id)
    assert.equal(otherSummary.lastMessageAt, null)
    assert.equal(otherSummary.lastMessagePreview, '')
    assert.equal(otherSummary.lastMessageSeq, 0)
    assert.equal(otherSummary.pendingApprovalCount, 0)
  })
})

test('a room with no messages or Bots has a zero summary', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const room = await makeWorkgroup(call, alice, { name: 'Quiet' })
    const listed = await call('GET', '/rooms', undefined, alice.token)
    const summary = listed.body.rooms.find(item => item.id === room.body.room.id)
    assert.equal(summary.memberCount, 1)
    assert.equal(summary.botCount, 2)
    assert.equal(summary.lastMessageAt, null)
    assert.equal(summary.lastMessagePreview, '')
    assert.equal(summary.lastMessageSeq, 0)
    assert.equal(summary.pendingApprovalCount, 0)
  })
})

test('Bot candidates include own and visible member Bots and mark room membership', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)

    assert.equal((await call('POST', '/bots', { botId: 'alpha-private', displayName: 'Alpha Private', visibility: 'private' }, alice.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'alpha-room', displayName: 'Alpha Room', visibility: 'room' }, alice.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'beta-public', displayName: 'Beta Public', visibility: 'public' }, bob.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'beta-private', displayName: 'Beta Private', visibility: 'private' }, bob.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'beta-room', displayName: 'Beta Room', visibility: 'room' }, bob.token)).status, 201)
    assert.equal((await call('POST', '/bots', { botId: 'carol-public', displayName: 'Carol Public', visibility: 'public' }, carol.token)).status, 201)
    assert.equal((await call('POST', '/bots/beta-public/heartbeat', { state: 'busy' }, bob.token)).status, 200)
    assert.equal((await call('POST', `/rooms/${roomId}/bots`, { botId: 'alpha-private' }, alice.token)).status, 201)
    assert.equal((await call('POST', `/rooms/${roomId}/bots`, { botId: 'beta-public' }, bob.token)).status, 201)

    const candidates = await call('GET', `/rooms/${roomId}/bot-candidates`, undefined, alice.token)
    assert.equal(candidates.status, 200, candidates.raw)
    const keyOf = bot => `${bot.ownerUserId}:${bot.botId}`
    const byKey = new Map(candidates.body.bots.map(bot => [keyOf(bot), bot]))

    assert.equal(byKey.has(`${alice.userId}:alpha-private`), true)
    assert.equal(byKey.has(`${alice.userId}:alpha-room`), true)
    assert.equal(byKey.has(`${bob.userId}:beta-public`), true)
    assert.equal(byKey.has(`${bob.userId}:beta-room`), true)
    assert.equal(byKey.has(`${bob.userId}:beta-private`), false)
    assert.equal(byKey.has(`${carol.userId}:carol-public`), false)

    const own = byKey.get(`${alice.userId}:alpha-private`)
    assert.equal(own.ownerDisplayName, 'alice')
    assert.equal(own.mine, true)
    assert.equal(own.visibility, 'private')
    assert.equal(own.inRoom, true)
    const betaPublic = byKey.get(`${bob.userId}:beta-public`)
    assert.equal(betaPublic.ownerDisplayName, 'bob')
    assert.equal(betaPublic.mine, false)
    assert.equal(betaPublic.visibility, 'public')
    assert.equal(betaPublic.presence, 'online')
    assert.equal(betaPublic.state, 'busy')
    assert.equal(betaPublic.inRoom, true)
    assert.equal(byKey.get(`${alice.userId}:alpha-room`).inRoom, false)
    assert.equal(byKey.get(`${bob.userId}:beta-room`).inRoom, false)

    // The candidate wire shape is a whitelist: no Session, model, path, tool or other owner-private
    // field can ride along even if the directory later grows one.
    const expectedKeys = ['botId', 'displayName', 'inRoom', 'mine', 'ownerDisplayName', 'ownerUserId', 'presence', 'state', 'visibility']
    for (const bot of candidates.body.bots) {
      assert.deepEqual(Object.keys(bot).sort(), expectedKeys)
    }
  })
})

test('Bot candidates answer a non-member with the room 404', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const carol = await person('carol')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const candidates = await call('GET', `/rooms/${room.body.room.id}/bot-candidates`, undefined, carol.token)
    assert.equal(candidates.status, 404, candidates.raw)
    assert.equal(candidates.body.error.code, 'NO_SUCH_ROOM')
  })
})

test('removing a member removes their Bots and cancels their open tasks', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const room = await makeWorkgroup(call, alice, { name: 'Finance' })
    const roomId = room.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    await call('POST', '/bots', { botId: 'writer', displayName: 'Writer', visibility: 'public' }, bob.token)
    await call('POST', `/rooms/${roomId}/bots`, { botId: 'writer' }, bob.token)
    await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'before-removal',
      body: '@Writer draft',
      mentions: [{ userId: bob.userId, botId: 'writer' }],
    }, alice.token)

    const removed = await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    assert.equal(removed.status, 200, removed.raw)
    const opened = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(opened.body.bots.some(bot => bot.botId === 'writer'), false)
    assert.equal(opened.body.bots.length, 2)
    const tasks = await call('GET', `/rooms/${roomId}/tasks`, undefined, alice.token)
    assert.equal(tasks.body.tasks[0].state, 'CANCELLED')
  })
})
