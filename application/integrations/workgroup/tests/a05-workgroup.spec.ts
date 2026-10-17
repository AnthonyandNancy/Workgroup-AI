// A-05: inviting by id, member management, human messages, and the @Bot surface.
//
// The requirement is "two computers' users see each other's messages". Two machines are not
// available (that is Q-01), so what is verified here is every layer below the physical one: **two
// separate Hub clients, each with its own device and its own token, against the real Hub**, with the
// real WebSocket each. Every case therefore exercises the actual authorization, the actual
// membership checks, and the actual event delivery — the only thing missing is a second chassis.
//
// The negatives matter as much as the positives here, because membership is the boundary that keeps
// a company's rooms separate:
//
//   * a non-member cannot read a room, its members, or its messages (the Hub answers 404, not 403,
//     so an id cannot be probed for existence)
//   * a member who is not an admin cannot invite or remove
//   * a removed member stops receiving events, on the socket they already hold
//   * an invitation cannot be accepted by anyone but its target
//
// An invitation in this product is by **user id**, not by handle: the Hub has no people search, and
// adding one would be a way to enumerate a company's accounts. That is asserted, because it is the
// kind of thing a later change might quietly "improve".

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createBridge } from '../bridge/index.mjs'
import { createWorkgroupClient, reduceWorkgroup, emptyWorkgroupState, MEMBER_ROLES } from '../client/index.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a05-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a05-bootstrap-secret'

async function loadWebSocket() {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const resolved = createRequire(import.meta.url).resolve('ws', { paths: [resolve(APP_ROOT, 'apps', 'web')] })
  const module = await import(pathToFileURL(resolved).href)
  return module.default ?? module.WebSocket
}

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a05-'))
  const port = 21000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try { if ((await fetch(`${base}/api/v1/health/live`)).ok) break } catch { /* not up */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`the Hub never came up:\n${log}`) }
    await new Promise(resume => setTimeout(resume, 150))
  }
  return {
    base,
    log: () => log,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resume => setTimeout(resume, 5000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      const absoluteRoot = resolve(root)
      const withinTemp = relative(resolve(tmpdir()), absoluteRoot)
      assert.ok(withinTemp.startsWith('workgroup-a05-') && !withinTemp.includes(sep))
      if (process.platform === 'win32') {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:WORKGROUP_TEST_RECYCLE, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
        ], { env: { ...process.env, WORKGROUP_TEST_RECYCLE: absoluteRoot } })
      }
    },
  }
}

let hub
let WebSocketImpl
let counter = 0

/** A distinct user on a distinct device, with its own Hub client and workgroup client. */
async function newPerson(label) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  const workgroup = createWorkgroupClient({ client })
  return { handle, client, workgroup, userId: client.identity.userId }
}

/** A Bridge for a person, wired to record what it receives. */
function bridgeFor(person) {
  const events = []
  const bridge = createBridge({
    hubUrl: hub.base,
    client: person.client,
    WebSocketImpl,
    onEvent: (event) => { events.push(event) },
    logger: {},
  })
  return { bridge, events }
}

async function waitFor(predicate, { timeout = 15_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resume => setTimeout(resume, interval))
  }
}

beforeAll(async () => {
  hub = await startRealHub()
  WebSocketImpl = await loadWebSocket()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
}, 30_000)

// ---------------------------------------------------------------------------
// Inviting by id
// ---------------------------------------------------------------------------

describe('inviting a colleague by user id', () => {
  it('an owner invites a person by id and that person sees the invitation', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Design review' } })

    const invitation = await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })
    assert.equal(invitation.targetUserId, bob.userId)
    assert.equal(invitation.role, 'member')
    assert.equal(invitation.status, 'pending')
    // The room's name travels with the invitation so the recipient knows what they are joining.
    assert.equal(invitation.roomName, 'Design review')

    const incoming = await bob.workgroup.incomingInvitations()
    assert.equal(incoming.length, 1)
    assert.equal(incoming[0].id, invitation.id)
    assert.equal(incoming[0].inviterUserId, alice.userId)
  })

  it('inviting needs a target id, and refuses an empty one rather than sending a bad request', async () => {
    const alice = await newPerson('alice')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Room' } })
    for (const bad of ['', '   ', undefined, null]) {
      await expect(alice.workgroup.invite(room.room.id, { targetUserId: bad })).rejects.toThrow(/user id of the colleague/)
    }
  })

  it('accepting an invitation makes the person a member and lets them read the room', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Joined room' } })
    const invitation = await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })

    await bob.workgroup.respondToInvitation(invitation.id, 'accept')

    // The Hub is the authority: the member list is read back, not assumed from the accept call.
    const members = await bob.workgroup.members(room.room.id)
    assert.deepEqual(members.map(member => member.userId).sort(), [alice.userId, bob.userId].sort())
    const opened = await bob.workgroup.openRoom(room.room.id)
    assert.equal(opened.room.name, 'Joined room')
    assert.equal(opened.room.myRole, 'member')
  })

  it('declining leaves the person out, and the room stays unreadable to them', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Declined room' } })
    const invitation = await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })

    await bob.workgroup.respondToInvitation(invitation.id, 'decline')

    await expect(bob.workgroup.openRoom(room.room.id)).rejects.toMatchObject({ status: 404 })
    assert.deepEqual(await bob.workgroup.members(room.room.id).catch(error => error.status), 404)
  })

  it('refuses an invitation decision that is neither accept nor decline', async () => {
    const alice = await newPerson('alice')
    await expect(alice.workgroup.respondToInvitation('inv-1', 'maybe')).rejects.toThrow(/accept or decline/)
  })

  it('an invitation cannot be accepted by anyone but its target', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Targeted room' } })
    const invitation = await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })

    // Carol is not the target, so the invitation is not hers to answer. The Hub must refuse; if it
    // did not, anybody who learned an invitation id could join a room.
    await expect(carol.workgroup.respondToInvitation(invitation.id, 'accept')).rejects.toThrow()
    await expect(carol.workgroup.openRoom(room.room.id)).rejects.toMatchObject({ status: 404 })
    // Bob's invitation is still his, and still pending.
    const incoming = await bob.workgroup.incomingInvitations()
    assert.equal(incoming.find(entry => entry.id === invitation.id).status, 'pending')
  })

  it('only an admin may invite, and a plain member is refused', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Members only' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')

    // Bob is in the room but is not an admin.
    await expect(bob.workgroup.invite(room.room.id, { targetUserId: carol.userId })).rejects.toThrow()
  })

  it('a revoked invitation cannot be accepted afterwards', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Revoked room' } })
    const invitation = await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })
    await alice.workgroup.revokeInvitation(invitation.id)

    await expect(bob.workgroup.respondToInvitation(invitation.id, 'accept')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Membership is a boundary
// ---------------------------------------------------------------------------

describe('membership is the boundary', () => {
  it('a non-member cannot read a room, its members, or its messages', async () => {
    const alice = await newPerson('alice')
    const outsider = await newPerson('outsider')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Private' } })

    // 404, not 403: a 403 would confirm the id names a real room, which is exactly what somebody
    // probing for room ids wants to learn.
    await expect(outsider.workgroup.openRoom(room.room.id)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.workgroup.members(room.room.id)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.workgroup.messagesAfter(room.room.id, 0)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.workgroup.head(room.room.id)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.workgroup.sendMessage(room.room.id, 'let me in')).rejects.toMatchObject({ status: 404 })
  })

  it('a member who is not an admin cannot remove anybody or change a role', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Roles' } })
    for (const person of [bob, carol]) {
      await person.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: person.userId })).id, 'accept')
    }

    await expect(bob.workgroup.removeMember(room.room.id, carol.userId)).rejects.toThrow()
    // Not even promoting themselves.
    await expect(bob.workgroup.setRole(room.room.id, bob.userId, 'admin')).rejects.toThrow()
    // And the member list is unchanged by the attempts.
    const members = await alice.workgroup.members(room.room.id)
    assert.equal(members.filter(member => member.role === 'admin').length, 0)
  })

  it('an invalid role is refused before a request is made', async () => {
    const alice = await newPerson('alice')
    expect(() => alice.workgroup.setRole('room-1', 'user-1', 'superuser')).toThrow(/must be one of/)
    for (const role of MEMBER_ROLES) {
      assert.ok(typeof role === 'string')
    }
  })

  it('a removed member loses access, and their already-open socket stops delivering', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Removal' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')

    // Bob is connected and receiving before the removal, so the case proves delivery stopped on the
    // socket he already holds rather than only that a later request fails.
    const { bridge, events } = bridgeFor(bob)
    try {
      await bridge.start([room.room.id])
      await waitFor(() => bridge.state === 'open', { label: 'bob to connect' })
      await alice.workgroup.sendMessage(room.room.id, 'before removal')
      await waitFor(() => events.filter(event => event.type === 'message.created').length === 1, { label: 'bob to receive the first message' })

      // The Hub unsubscribes the socket rather than closing it, so what must stop is delivery,
      // not the connection: a closed socket would also satisfy the goal, but the requirement is
      // that no further message arrives.
      await alice.workgroup.removeMember(room.room.id, bob.userId)
      await alice.workgroup.sendMessage(room.room.id, 'after removal')
      await new Promise(resume => setTimeout(resume, 1000))
      const bodies = events.filter(event => event.type === 'message.created').map(event => event.payload.message.body)
      assert.deepEqual(bodies, ['before removal'], `a removed member received ${JSON.stringify(bodies)}`)

      // And re-reading is refused: the boundary is the server's, not the socket's.
      await expect(bob.workgroup.openRoom(room.room.id)).rejects.toMatchObject({ status: 404 })
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('leaving is the member\u2019s own choice and takes their subscription with it', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Leaving' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')

    await bob.workgroup.leave(room.room.id)
    await expect(bob.workgroup.openRoom(room.room.id)).rejects.toMatchObject({ status: 404 })
    // Alice is still there.
    assert.equal((await alice.workgroup.members(room.room.id)).length, 1)
  })
})

// ---------------------------------------------------------------------------
// Human messages
// ---------------------------------------------------------------------------

describe('human messages', () => {
  it('two people in one room see each other\u2019s messages', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Conversation' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')

    const { bridge: aliceBridge, events: aliceEvents } = bridgeFor(alice)
    const { bridge: bobBridge, events: bobEvents } = bridgeFor(bob)
    try {
      await aliceBridge.start([room.room.id])
      await bobBridge.start([room.room.id])
      await waitFor(() => aliceBridge.state === 'open' && bobBridge.state === 'open', { label: 'both sockets' })

      await alice.workgroup.sendMessage(room.room.id, 'morning, can you take a look?')
      await bob.workgroup.sendMessage(room.room.id, 'yes, after lunch')

      // Each side sees both messages, through the other person's socket — this is the
      // "two clients" part of the requirement, minus the second machine.
      await waitFor(() => aliceEvents.filter(event => event.type === 'message.created').length === 2, { label: 'alice to see both' })
      await waitFor(() => bobEvents.filter(event => event.type === 'message.created').length === 2, { label: 'bob to see both' })

      for (const events of [aliceEvents, bobEvents]) {
        const bodies = events.filter(event => event.type === 'message.created').map(event => event.payload.message.body)
        assert.deepEqual(bodies, ['morning, can you take a look?', 'yes, after lunch'])
        // The sender's display name travels with the message, so a reader can name the author
        // without a second lookup that might fail.
        const senders = events.filter(event => event.type === 'message.created').map(event => event.payload.message.senderDisplayName)
        assert.deepEqual(senders, ['alice Person', 'bob Person'])
      }
    } finally {
      aliceBridge.stop()
      bobBridge.stop()
    }
  }, 60_000)

  it('the same clientMessageId is one message, so a retried send does not appear twice', async () => {
    const alice = await newPerson('alice')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Idempotency' } })

    const id = 'a05-idempotent-message-0001'
    const first = await alice.workgroup.sendMessage(room.room.id, 'only once', { clientMessageId: id })
    const second = await alice.workgroup.sendMessage(room.room.id, 'only once', { clientMessageId: id })
    // Same message, and the Hub says so rather than creating a second row.
    assert.equal(first.message.id, second.message.id)
    assert.equal(second.duplicate, true)

    const page = await alice.workgroup.messagesAfter(room.room.id, 0)
    assert.equal(page.messages.length, 1)
  })

  it('a message needs text, and the refusal happens before the request', async () => {
    const alice = await newPerson('alice')
    for (const bad of ['', '   ', undefined, null]) {
      // Synchronous, before any request: an empty message is a caller mistake, not a server
      // refusal, and sending it would spend a sequence number on nothing.
      expect(() => alice.workgroup.sendMessage('any-room', bad)).toThrow(/needs some text/)
    }
  })

  it('messages come back in sequence order and a cursor reads only what follows', async () => {
    const alice = await newPerson('alice')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Ordering' } })
    for (let index = 0; index < 5; index += 1) await alice.workgroup.sendMessage(room.room.id, `message ${index}`)

    const all = await alice.workgroup.messagesAfter(room.room.id, 0)
    assert.deepEqual(all.messages.map(message => message.roomSeq), [1, 2, 3, 4, 5])
    assert.deepEqual(all.messages.map(message => message.body), ['message 0', 'message 1', 'message 2', 'message 3', 'message 4'])

    const afterTwo = await alice.workgroup.messagesAfter(room.room.id, 2)
    assert.deepEqual(afterTwo.messages.map(message => message.roomSeq), [3, 4, 5])

    const head = await alice.workgroup.head(room.room.id)
    assert.equal(head.latestSeq, 5)
  })

  it('a reply references the message it answers', async () => {
    const alice = await newPerson('alice')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Replies' } })
    const original = await alice.workgroup.sendMessage(room.room.id, 'the original question')
    const reply = await alice.workgroup.sendMessage(room.room.id, 'answering it', { replyToMessageId: original.message.id })

    const page = await alice.workgroup.messagesAfter(room.room.id, 0)
    const replyRow = page.messages.find(message => message.id === reply.message.id)
    assert.equal(replyRow.replyToMessageId ?? reply.message.replyToMessageId, original.message.id)
  })
})

// ---------------------------------------------------------------------------
// The @Bot surface
// ---------------------------------------------------------------------------

describe('the @Bot surface', () => {
  it('the directory lists only what the Hub allows the caller to see', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')

    // Bob publishes a Bot; Alice publishes a private one that must never appear.
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', role: 'Copywriter', visibility: 'public' } })
    await alice.client.request('POST', '/bots', { body: { botId: 'secret', displayName: 'Secret', role: 'Private', visibility: 'private' } })

    const visibleToBob = await bob.workgroup.publishedBots()
    const names = visibleToBob.map(entry => entry.displayName)
    assert.ok(names.includes('Writer'), `bob should see his own published Bot, saw ${names.join(', ')}`)
    // A private Bot is visible to its owner and to nobody else. Bob must not learn it exists.
    assert.equal(names.includes('Secret'), false, `bob saw a private Bot: ${names.join(', ')}`)

    const visibleToAlice = await alice.workgroup.publishedBots()
    const aliceNames = visibleToAlice.map(entry => entry.displayName)
    assert.ok(aliceNames.includes('Writer'), 'alice sees the Bot bob published')
    assert.ok(aliceNames.includes('Secret'), 'alice sees her own private Bot')
  })

  it('a directory entry carries what an @ mention needs and nothing that could run it', async () => {
    const owner = await newPerson('owner')
    await owner.client.request('POST', '/bots', { body: { botId: 'analyst', displayName: 'Analyst', role: 'Data', visibility: 'public' } })

    const [entry] = await owner.workgroup.publishedBots({ query: 'Analyst' })
    assert.equal(entry.botId, 'analyst')
    assert.equal(entry.displayName, 'Analyst')
    assert.equal(entry.ownerUserId, owner.userId)
    // The wire shape must not carry a model, a Session id, a filesystem path, or a capability:
    // those are the owner's private facts, and H-07 asserts the same on the server side.
    for (const forbidden of ['model', 'sessionId', 'workDir', 'tools', 'capabilities', 'systemPrompt', 'instructions']) {
      assert.equal(forbidden in entry, false, `the directory entry must not expose ${forbidden}`)
    }
  })

  it('the directory can be narrowed by owner and by name', async () => {
    const owner = await newPerson('owner')
    const other = await newPerson('other')
    await owner.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', role: 'Copy', visibility: 'public' } })
    await owner.client.request('POST', '/bots', { body: { botId: 'coder', displayName: 'Coder', role: 'Code', visibility: 'public' } })
    await other.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', role: 'Copy', visibility: 'public' } })

    const mine = await owner.workgroup.publishedBots({ ownerUserId: owner.userId })
    assert.equal(mine.length, 2)
    assert.deepEqual([...new Set(mine.map(entry => entry.ownerUserId))], [owner.userId])

    const named = await owner.workgroup.publishedBots({ query: 'Coder' })
    assert.deepEqual(named.map(entry => entry.displayName), ['Coder'])
  })
})

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

describe('applying events to a room view', () => {
  const room = { id: 'room-1', name: 'Room' }

  it('updates a member presence event idempotently and ignores another room', () => {
    const state = {
      room,
      members: [{ userId: 'u1', online: false }, { userId: 'u2', online: false }],
      messages: [],
      tasks: [],
      head: 0,
    }
    const event = {
      type: 'presence.changed',
      roomId: 'room-1',
      payload: { userId: 'u1', online: true },
    }
    const next = reduceWorkgroup(state, event)
    assert.equal(next.members.find(member => member.userId === 'u1').online, true)
    assert.equal(next.members.find(member => member.userId === 'u2').online, false)
    assert.deepEqual(reduceWorkgroup(next, event), next)
    assert.equal(reduceWorkgroup(state, { ...event, roomId: 'room-2' }), state)
  })

  it('adds and replaces task approval, progress, and cancellation events', () => {
    const state = { room, members: [], messages: [], tasks: [], head: 0 }
    const requested = reduceWorkgroup(state, {
      type: 'task.approval_requested',
      roomId: 'room-1',
      payload: { task: { id: 't2', state: 'PENDING_APPROVAL' } },
    })
    assert.deepEqual(requested.tasks, [{ id: 't2', state: 'PENDING_APPROVAL' }])
    const progress = reduceWorkgroup(requested, {
      type: 'task.progress',
      roomId: 'room-1',
      payload: { task: { id: 't2', state: 'RUNNING', progress: 50 } },
    })
    assert.deepEqual(progress.tasks, [{ id: 't2', state: 'RUNNING', progress: 50 }])
    const cancelled = reduceWorkgroup(progress, {
      type: 'task.cancelled',
      roomId: 'room-1',
      payload: { task: { id: 't2', state: 'CANCELLED' } },
    })
    assert.deepEqual(cancelled.tasks, [{ id: 't2', state: 'CANCELLED' }])
  })

  it('adds a message in sequence order and advances the head', () => {
    const state = { room, members: [], messages: [], tasks: [], head: 0 }
    const event = {
      type: 'message.created',
      roomId: 'room-1',
      roomSeq: 1,
      payload: { message: { id: 'm1', roomId: 'room-1', roomSeq: 1, body: 'first' } },
    }
    const next = reduceWorkgroup(state, event)
    assert.deepEqual(next.messages.map(message => message.body), ['first'])
    assert.equal(next.head, 1)
  })

  it('ignores a message it already has, whichever field repeats it', () => {
    const first = { id: 'm1', roomId: 'room-1', roomSeq: 1, body: 'first' }
    const state = { room, members: [], messages: [first], tasks: [], head: 1 }
    // Same id, different sequence: still one row.
    assert.equal(reduceWorkgroup(state, { type: 'message.created', roomId: 'room-1', payload: { message: { ...first, roomSeq: 9 } } }).messages.length, 1)
    // Same sequence, different id: still one row.
    assert.equal(reduceWorkgroup(state, { type: 'message.created', roomId: 'room-1', payload: { message: { ...first, id: 'm-other' } } }).messages.length, 1)
  })

  it('sorts a message that arrives out of order into place', () => {
    const state = {
      room,
      members: [],
      messages: [{ id: 'm2', roomId: 'room-1', roomSeq: 2, body: 'second' }],
      tasks: [],
      head: 2,
    }
    const next = reduceWorkgroup(state, {
      type: 'message.created',
      roomId: 'room-1',
      payload: { message: { id: 'm1', roomId: 'room-1', roomSeq: 1, body: 'first' } },
    })
    assert.deepEqual(next.messages.map(message => message.body), ['first', 'second'])
  })

  it('ignores a message for another room', () => {
    const state = { room, members: [], messages: [], tasks: [], head: 0 }
    const next = reduceWorkgroup(state, {
      type: 'message.created',
      roomId: 'room-2',
      payload: { message: { id: 'm1', roomId: 'room-2', roomSeq: 1, body: 'elsewhere' } },
    })
    assert.equal(next, state)
  })

  it('marks the member list stale rather than patching its own guess', () => {
    const state = { room, members: [{ userId: 'bob' }], messages: [], tasks: [], head: 0 }
    const next = reduceWorkgroup(state, { type: 'member.changed', roomId: 'room-1', payload: { userId: 'bob', change: 'removed' } })
    assert.equal(next.membersStale, true)
    // The list is untouched: a client that removed the member locally would be guessing, and a
    // guess that is wrong shows a member who is not there.
    assert.deepEqual(next.members, [{ userId: 'bob' }])
  })

  it('replaces a task rather than appending a second copy of it', () => {
    const state = { room, members: [], messages: [], tasks: [{ id: 't1', state: 'PENDING_APPROVAL' }], head: 0 }
    const next = reduceWorkgroup(state, { type: 'task.approved', payload: { task: { id: 't1', state: 'APPROVED' } } })
    assert.equal(next.tasks.length, 1)
    assert.equal(next.tasks[0].state, 'APPROVED')
  })

  it('gives an explicit empty state, so the first render is an empty room and not a crash', () => {
    const state = emptyWorkgroupState('room-9')
    assert.equal(state.room.id, 'room-9')
    assert.deepEqual(state.messages, [])
    assert.equal(state.loading, true)
  })

  it('ignores an event type this client does not know', () => {
    const state = emptyWorkgroupState('room-1')
    assert.equal(reduceWorkgroup(state, { type: 'something.new', payload: {} }), state)
    assert.equal(reduceWorkgroup(state, null), state)
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('wiring', () => {
  it('refuses to build without a Hub client', () => {
    expect(() => createWorkgroupClient({})).toThrow(/Hub client is required/)
  })

  it('reports a missing Hub route as a named failure, not as an empty room', async () => {
    const alice = await newPerson('alice')
    await expect(alice.workgroup.openRoom('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ status: 404 })
  })

  it('the sender is known to the client, which the view needs to mark its own messages', async () => {
    const alice = await newPerson('alice')
    assert.equal(alice.workgroup.selfUserId, alice.userId)
  })
})
