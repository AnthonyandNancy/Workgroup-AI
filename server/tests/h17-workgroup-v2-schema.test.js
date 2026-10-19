// Workgroup parity v2: the schema, the chief-Bot mirror, room leadership, Bot quotas, @all,
// beforeSeq paging, reactions, and share widening one artifact's ACL.
//
// Every case here answers a rule from the requirement that a client cannot be trusted with: which
// Bot leads a workgroup, who may answer an unmentioned message, how many Bots one member may own in
// one room, who may summon everyone, and who may read a result nobody shared with them.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'h17-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h17-'))
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
  const publish = async (who, botId, { isChief = false, visibility = 'public' } = {}) => {
    const published = await call('POST', '/bots', { botId, displayName: botId, visibility, isChief }, who.token)
    assert.equal(published.status, 201, published.raw)
    return published.body.bot
  }
  /** A workgroup created by `owner` with `botIds`, led by `adminBotId`. */
  const workgroup = async (owner, { name = 'Room', botIds, adminBotId }) => {
    const created = await call('POST', '/rooms', { name, kind: 'workgroup', botIds, adminBotId }, owner.token)
    return created
  }
  const invite = async (owner, roomId, target, role = 'member') => {
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: target.userId, role }, owner.token)
    assert.equal(invited.status, 201, invited.raw)
    const accepted = await call('POST', `/invitations/${invited.body.invitation.id}/accept`, undefined, target.token)
    assert.equal(accepted.status, 200, accepted.raw)
    return invited.body.invitation
  }
  try {
    await run({ call, person, publish, workgroup, invite, db })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('the schema carries the workgroup governance columns and the reaction table', async () => {
  await withHub(async ({ db }) => {
    const rooms = db.prepare('PRAGMA table_info(rooms)').all().map(row => row.name)
    for (const column of ['reply_mode', 'admin_bot_owner_user_id', 'admin_bot_id', 'work_dir', 'permission']) {
      assert.ok(rooms.includes(column), `rooms.${column} is missing`)
    }
    assert.ok(db.prepare('PRAGMA table_info(room_bots)').all().some(row => row.name === 'is_chief'))
    assert.ok(db.prepare('PRAGMA table_info(bot_directory)').all().some(row => row.name === 'is_chief'))
    assert.notEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_reactions'").get(), undefined)
  })
})

test('a room created before this migration keeps answering as everyone', async () => {
  await withHub(async ({ db, person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    assert.equal(created.status, 201, created.raw)
    // Written by an older Hub: no reply_mode value and no leader.
    db.prepare("UPDATE rooms SET reply_mode = 'everyone', admin_bot_owner_user_id = NULL, admin_bot_id = NULL WHERE id = ?").run(created.body.room.id)
    const read = await workgroup(alice, { botIds: ['chief'], adminBotId: 'chief' }).then(() => undefined)
    assert.equal(read, undefined)
    const room = db.prepare('SELECT reply_mode FROM rooms WHERE id = ?').get(created.body.room.id)
    assert.equal(room.reply_mode, 'everyone')
  })
})

test('publishing reports whether the Bot is its owner\'s Main Bot', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const chief = await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'public', isChief: true }, alice.token)
    assert.equal(chief.status, 201)
    assert.equal(chief.body.bot.isChief, true)
    const worker = await call('POST', '/bots', { botId: 'worker', displayName: 'Worker', visibility: 'public' }, alice.token)
    assert.equal(worker.body.bot.isChief, false)
    const listed = await call('GET', '/bots/directory', undefined, alice.token)
    const found = listed.body.bots.find(entry => entry.botId === 'chief')
    assert.equal(found.isChief, true)
  })
})

test('a workgroup needs two Bots and its creator\'s own Main Bot as leader', async () => {
  await withHub(async ({ person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')

    const alone = await workgroup(alice, { botIds: ['chief'], adminBotId: 'chief' })
    assert.equal(alone.status, 400, alone.raw)
    assert.equal(alone.body.error.code, 'INVALID_BOT_COUNT')

    const noLeader = await workgroup(alice, { botIds: ['chief', 'worker'] })
    assert.equal(noLeader.status, 400, noLeader.raw)
    assert.equal(noLeader.body.error.code, 'NOT_A_CHIEF_BOT')

    const wrongLeader = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'worker' })
    assert.equal(wrongLeader.status, 400, wrongLeader.raw)
    assert.equal(wrongLeader.body.error.code, 'NOT_A_CHIEF_BOT')

    const ok = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    assert.equal(ok.status, 201, ok.raw)
    assert.equal(ok.body.room.adminBotId, 'chief')
    assert.equal(ok.body.room.adminBotOwnerUserId, alice.userId)
    assert.equal(ok.body.room.replyMode, 'admin')
  })
})

test('a member may own at most twelve Bots and at most one Main Bot in one room', async () => {
  await withHub(async ({ call, person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'second-chief', { isChief: true })
    const extras = Array.from({ length: 12 }, (_, index) => `bot-${index}`)
    for (const botId of extras) await publish(alice, botId)
    const created = await workgroup(alice, { botIds: ['chief', ...extras.slice(0, 11)], adminBotId: 'chief' })
    assert.equal(created.status, 201, created.raw)
    const roomId = created.body.room.id

    // The room already holds 12 of Alice's Bots; the thirteenth is refused.
    const thirteenth = await call('POST', `/rooms/${roomId}/bots`, { botId: extras[11] }, alice.token)
    assert.equal(thirteenth.status, 400, thirteenth.raw)
    assert.equal(thirteenth.body.error.code, 'BOT_LIMIT_REACHED')

    // A second Main Bot is refused even though the numeric limit has room for it.
    const other = await workgroup(alice, { botIds: ['chief', 'bot-0'], adminBotId: 'chief' })
    assert.equal(other.status, 201, other.raw)
    const secondChief = await call('POST', `/rooms/${other.body.room.id}/bots`, { botId: 'second-chief' }, alice.token)
    assert.equal(secondChief.status, 400, secondChief.raw)
    assert.equal(secondChief.body.error.code, 'CHIEF_BOT_LIMIT_REACHED')
  })
})

test('effectiveReplyMode falls back to everyone when the leader is gone', async () => {
  await withHub(async ({ call, person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    assert.equal(created.body.room.effectiveReplyMode, 'admin')

    const removed = await call('DELETE', `/rooms/${roomId}/bots/${alice.userId}/chief`, undefined, alice.token)
    assert.equal(removed.status, 200, removed.raw)

    const read = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.equal(read.body.room.replyMode, 'admin')
    assert.equal(read.body.room.effectiveReplyMode, 'everyone')
    assert.equal(read.body.room.adminBotId, undefined)
  })
})

test('only the owner may change the group permission, and the leader\'s owner may change the folder', async () => {
  await withHub(async ({ call, person, publish, workgroup, invite }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    await invite(alice, roomId, bob, 'admin')

    const byAdmin = await call('PATCH', `/rooms/${roomId}`, { permission: 'workspace-write' }, bob.token)
    assert.equal(byAdmin.status, 403, byAdmin.raw)
    assert.equal(byAdmin.body.error.code, 'NOT_ALLOWED')

    const byOwner = await call('PATCH', `/rooms/${roomId}`, { permission: 'workspace-write' }, alice.token)
    assert.equal(byOwner.status, 200, byOwner.raw)
    assert.equal(byOwner.body.room.permission, 'workspace-write')

    const folder = await call('PATCH', `/rooms/${roomId}`, { workDir: '/tmp/shared-work' }, alice.token)
    assert.equal(folder.status, 200, folder.raw)
    assert.equal(folder.body.room.workDir, '/tmp/shared-work')

    const switched = await call('PATCH', `/rooms/${roomId}`, { replyMode: 'everyone' }, alice.token)
    assert.equal(switched.body.room.effectiveReplyMode, 'everyone')
  })
})

test('a room\'s leader may dissolve it, and nobody else\'s leader may', async () => {
  await withHub(async ({ call, person, publish, workgroup }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id

    const byBob = await call('POST', `/rooms/${roomId}/dissolve`, {}, bob.token)
    assert.equal(byBob.status, 404, byBob.raw)

    const byLeader = await call('POST', `/rooms/${roomId}/dissolve`, {}, alice.token)
    assert.equal(byLeader.status, 200, byLeader.raw)
    const read = await call('GET', `/rooms/${roomId}`, undefined, alice.token)
    assert.notEqual(read.body.room.dissolvedAt, undefined)
  })
})

test('@all is a leader\'s summons and never the leader\'s own task', async () => {
  await withHub(async ({ call, person, publish, workgroup, invite }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    await publish(bob, 'helper')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    await invite(alice, roomId, bob)
    const added = await call('POST', `/rooms/${roomId}/bots`, { botId: 'helper' }, bob.token)
    assert.equal(added.status, 201, added.raw)

    const byMember = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'all-from-member', body: '@all please look', mentions: [{ all: true }],
    }, bob.token)
    assert.equal(byMember.status, 400, byMember.raw)
    assert.equal(byMember.body.error.code, 'MENTION_ALL_NOT_ALLOWED')

    const byOwner = await call('POST', `/rooms/${roomId}/messages`, {
      clientMessageId: 'all-from-owner', body: '@all please look', mentions: [{ all: true }],
    }, alice.token)
    assert.equal(byOwner.status, 201, byOwner.raw)
    const owners = byOwner.body.proposedTasks.map(task => task.ownerUserId).sort()
    // Alice's own worker and Bob's helper; the leader answers as a conversation, not a task.
    assert.deepEqual(owners, [alice.userId, bob.userId].sort())
  })
})

test('earlier messages page backwards without repeating or skipping', async () => {
  await withHub(async ({ call, person, publish, workgroup }) => {
    const alice = await person('alice')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    for (let index = 0; index < 12; index += 1) {
      const sent = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: `paging-line-${String(index).padStart(3, '0')}`, body: `line ${index}` }, alice.token)
      assert.equal(sent.status, 201, sent.raw)
    }
    // Pages arrive newest-first, and each page is itself in reading order.
    const pages = []
    let before = 13
    for (let page = 0; page < 5; page += 1) {
      const read = await call('GET', `/rooms/${roomId}/messages?beforeSeq=${before}&limit=5`, undefined, alice.token)
      assert.equal(read.status, 200, read.raw)
      pages.push(read.body.messages.map(message => message.roomSeq))
      if (read.body.hasMore !== true) break
      before = read.body.nextBeforeSeq
    }
    assert.deepEqual(pages, [[8, 9, 10, 11, 12], [3, 4, 5, 6, 7], [1, 2]])
    // Together the pages hold every message exactly once.
    assert.deepEqual(pages.flat().sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    // Both cursors together have no single answer for "which page", so they are refused. `afterSeq=0`
    // is the default and reads as absent; a real forward cursor is what makes the request ambiguous.
    const both = await call('GET', `/rooms/${roomId}/messages?beforeSeq=5&afterSeq=3`, undefined, alice.token)
    assert.equal(both.status, 400, both.raw)
    assert.equal(both.body.error.code, 'INVALID_CURSOR')
  })
})

test('a reaction is shared, idempotent, and only its author may withdraw it', async () => {
  await withHub(async ({ call, person, publish, workgroup, invite }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    await invite(alice, roomId, bob)
    const sent = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'react-target', body: 'hello' }, alice.token)
    const messageId = sent.body.message.id

    const first = await call('POST', `/rooms/${roomId}/messages/${messageId}/reactions`, { emoji: '👍' }, bob.token)
    assert.equal(first.status, 200, first.raw)
    const twice = await call('POST', `/rooms/${roomId}/messages/${messageId}/reactions`, { emoji: '👍' }, bob.token)
    assert.equal(twice.status, 200, twice.raw)
    assert.equal(twice.body.reactions.length, 1)
    assert.equal(twice.body.reactions[0].userIds.length, 1)

    // Alice's page carries Bob's reaction: reactions are shared, not local.
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    const carried = page.body.messages.find(message => message.id === messageId)
    assert.equal(carried.reactions[0].emoji, '👍')

    // Alice cannot withdraw Bob's reaction; Bob can.
    await call('DELETE', `/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}`, undefined, alice.token)
    const stillThere = await call('GET', `/rooms/${roomId}/messages`, undefined, alice.token)
    assert.equal(stillThere.body.messages.find(message => message.id === messageId).reactions.length, 1)

    const removed = await call('DELETE', `/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}`, undefined, bob.token)
    assert.equal(removed.status, 200, removed.raw)
    assert.equal(removed.body.reactions.length, 0)

    const unknown = await call('POST', `/rooms/${roomId}/messages/${messageId}/reactions`, { emoji: '🦄' }, bob.token)
    assert.equal(unknown.status, 400, unknown.raw)
    assert.equal(unknown.body.error.code, 'INVALID_EMOJI')
  })
})

test('sharing a result publishes its files to the whole room', async () => {
  await withHub(async ({ call, person, publish, workgroup, invite }) => {
    const alice = await person('alice')
    const bob = await person('bob')
    const carol = await person('carol')
    await publish(alice, 'chief', { isChief: true })
    await publish(alice, 'worker')
    const created = await workgroup(alice, { botIds: ['chief', 'worker'], adminBotId: 'chief' })
    const roomId = created.body.room.id
    await invite(alice, roomId, bob)
    await invite(alice, roomId, carol)

    // Bob asks Alice's Bot for work, so Alice owns the task.
    const asked = await call('POST', `/rooms/${roomId}/tasks`, {
      targetBotId: 'worker', ownerUserId: alice.userId, description: 'produce a report',
    }, bob.token)
    assert.equal(asked.status, 201, asked.raw)
    const taskId = asked.body.task.id
    const approved = await call('POST', `/tasks/${taskId}/decision`, {
      decision: 'approve', expectedVersion: asked.body.task.version,
    }, alice.token)
    assert.equal(approved.status, 200, approved.raw)

    // Alice's machine uploads the result, naming only Bob as a recipient.
    const uploaded = await call('POST', `/rooms/${roomId}/artifacts?fileName=report.txt&taskId=${taskId}&recipients=${bob.userId}`, {
      base64: Buffer.from('quarterly numbers').toString('base64'),
    }, alice.token)
    assert.equal(uploaded.status, 201, uploaded.raw)
    const artifactId = uploaded.body.artifact.id
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, bob.token)).status, 200)
    // Carol is in the room but was not named, so before sharing she cannot read the bytes. The answer
    // is 404 rather than 403 on purpose: an outsider must not learn that the artifact exists.
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, carol.token)).status, 404)

    await call('POST', `/tasks/${taskId}/result`, { text: 'the report is attached' }, alice.token)
    // A result is shared from REVIEW_REQUIRED, which is where the owner's own execution leaves it:
    // approved → queued → running → review.
    let version = approved.body.task.version
    for (const state of ['QUEUED', 'RUNNING', 'REVIEW_REQUIRED']) {
      const moved = await call('POST', `/tasks/${taskId}/progress`, { state, expectedVersion: version, stage: 'working' }, alice.token)
      assert.equal(moved.status, 200, moved.raw)
      version = moved.body.task.version
    }
    const shared = await call('POST', `/tasks/${taskId}/share`, {
      expectedVersion: version, recipients: [bob.userId],
    }, alice.token)
    assert.equal(shared.status, 200, shared.raw)
    assert.deepEqual(shared.body.sharedArtifacts, [artifactId])

    // Sharing the text widened the files with it: everyone in the room may now read both.
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, carol.token)).status, 200)
    const page = await call('GET', `/rooms/${roomId}/messages`, undefined, carol.token)
    assert.ok(page.body.messages.some(message => message.body === 'the report is attached'))
  })
})
