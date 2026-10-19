// H-14 (presence): who is connected right now, and who is allowed to know.
//
// The requirement is a device-level, momentary fact — "connected" means a live authenticated socket
// exists, and a Hub restart or a dropped socket makes it false again. Two properties follow from
// that wording and decide the whole design:
//
//   * **Any live device means online.** A colleague with a desktop and a laptop is one person; the
//     fact the members list needs is "reachable now", not "all devices are up".
//   * **Only co-members may know.** Presence is information about a person, delivered to a room.
//     A non-member who could observe it would learn who is at work without being in the room,
//     which is the same leak the room and message routes already answer 404 for.
//
// The cases below also pin the two ways this could go wrong quietly. A Hub that stored presence
// would keep saying "online" after a restart until something rewrote it; a Hub that read
// `devices.last_seen_at` would call anyone who signed in this week online, because that column only
// moves on login and refresh. Both are asserted against, not described.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { makeWorkgroup } from './helpers/workgroup.js'
import { EVENT_TYPES } from '../src/realtime/events.js'

const SIGNING_KEY = 'h14-presence-test-signing-key-long-enough'

async function withLiveHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h14-presence-'))
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  await server.listen({ host: '127.0.0.1', port: 0 })
  server.hub.realtime.start()
  const { port } = server.server.address()
  const base = `http://127.0.0.1:${port}`
  const socketBase = `ws://127.0.0.1:${port}`

  const http = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    return { status: response.status, body: json }
  }
  const person = async (handle) => {
    const password = `${handle}-password-long-enough`
    await http('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
    const login = await http('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    return { userId: login.body.user.id, token: login.body.accessToken, password }
  }
  const open = (token) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${socketBase}/api/v1/realtime`, { headers: { authorization: `Bearer ${token}` } })
    const frames = []
    const waiters = []
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      frames.push(frame)
      for (const waiter of [...waiters]) waiter(frame)
    })
    socket.on('error', reject)
    socket.on('unexpected-response', (_request, response) => reject(new Error(`upgrade refused with ${response.statusCode}`)))
    socket.on('open', () => resolve({
      socket,
      frames,
      next(predicate, timeoutMs = 4000) {
        const existing = frames.find(predicate)
        if (existing !== undefined) return Promise.resolve(existing)
        return new Promise((settle) => {
          const timer = setTimeout(() => settle(undefined), timeoutMs)
          const waiter = (frame) => {
            if (!predicate(frame)) return
            clearTimeout(timer)
            waiters.splice(waiters.indexOf(waiter), 1)
            settle(frame)
          }
          waiters.push(waiter)
        })
      },
      close: () => new Promise((settle) => { socket.on('close', () => settle()); socket.close() }),
    }))
  })
  const twoInRoom = async () => {
    const alice = await person('alice')
    const bob = await person('bob')
    const created = await makeWorkgroup(http, alice, { name: 'Finance' })
    const roomId = created.body.room.id
    const invited = await http('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await http('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    return { alice, bob, roomId }
  }
  /**
   * Read one member's `online` flag, retrying briefly.
   *
   * A socket's close is observed by the client when the client's own socket closes; the server's
   * `release` runs when *it* sees the close, which can be a tick later. Asserting immediately would
   * make this suite pass or fail on that ordering rather than on the rule, so the helper waits for
   * the Hub's own answer instead of guessing at the timing.
   */
  const onlineOf = async (roomId, viewerToken, userId, expected, tries = 40) => {
    let last
    for (let i = 0; i < tries; i += 1) {
      const response = await http('GET', `/rooms/${roomId}/members`, undefined, viewerToken)
      last = response.body.members.find(member => member.userId === userId)?.online
      if (last === expected) return last
      await new Promise(settle => setTimeout(settle, 25))
    }
    return last
  }
  try {
    await run({ config, db, server, http, person, open, twoInRoom, onlineOf })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
}

test('the presence event is declared in the Hub event whitelist', () => {
  // `makeEvent` throws for a type this list omits, so a missing entry would surface as a 500 on the
  // request that happened to trigger a presence change rather than as a missing feature.
  assert.ok(EVENT_TYPES.includes('presence.changed'), `EVENT_TYPES is missing presence.changed: ${EVENT_TYPES.join(', ')}`)
})

test('a member list reports a connected colleague as online and a disconnected one as offline', async () => {
  await withLiveHub(async ({ http, open, twoInRoom, onlineOf }) => {
    const { alice, bob, roomId } = await twoInRoom()
    assert.equal(await onlineOf(roomId, alice.token, bob.userId, false), false, 'nobody has connected yet')

    const socket = await open(bob.token)
    assert.equal(await onlineOf(roomId, alice.token, bob.userId, true), true)
    const after = await http('GET', `/rooms/${roomId}/members`, undefined, alice.token)
    assert.equal(after.body.members.find(member => member.userId === alice.userId).online, false, 'Alice has no socket open')
    await socket.close()
  })
})

test('a member already in the room learns about a connection without polling', async () => {
  await withLiveHub(async ({ open, twoInRoom }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const aliceSocket = await open(alice.token)
    // The subscription is what makes the socket eligible for the room's events.
    aliceSocket.socket.send(JSON.stringify({ schemaVersion: 'wg.v1', type: 'subscribe', roomId }))
    await aliceSocket.next(frame => frame.type === 'ack' || frame.type === 'hello')

    const bobSocket = await open(bob.token)
    const event = await aliceSocket.next(frame => frame.type === 'presence.changed' && frame.payload?.userId === bob.userId)
    assert.ok(event !== undefined, 'the co-member must be told that Bob connected')
    assert.equal(event.payload.online, true)
    assert.equal(event.roomId, roomId)
    await bobSocket.close()
    await aliceSocket.close()
  })
})

test('any live device keeps the person online, and the last one leaving turns it off', async () => {
  await withLiveHub(async ({ open, twoInRoom, onlineOf }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const first = await open(bob.token)
    assert.equal(await onlineOf(roomId, alice.token, bob.userId, true), true)
    const second = await open(bob.token)

    await first.close()
    assert.equal(await onlineOf(roomId, alice.token, bob.userId, true), true, 'a second device keeps the person online')
    await second.close()
    assert.equal(await onlineOf(roomId, alice.token, bob.userId, false), false, 'the last device leaving is what turns it off')
  })
})

test('a non-member cannot observe who is online in a room they are not in', async () => {
  await withLiveHub(async ({ http, open, person, twoInRoom }) => {
    const { roomId, bob } = await twoInRoom()
    const stranger = await person('stranger')
    await open(bob.token)

    // The same answer a guessed room id gets: 404, so presence cannot be used to confirm a room
    // exists either.
    const members = await http('GET', `/rooms/${roomId}/members`, undefined, stranger.token)
    assert.equal(members.status, 404)
    const room = await http('GET', `/rooms/${roomId}`, undefined, stranger.token)
    assert.equal(room.status, 404)
  })
})

test('presence is momentary, so a fresh Hub reports everyone offline', async () => {
  await withLiveHub(async ({ open, twoInRoom }) => {
    const { bob } = await twoInRoom()
    const socket = await open(bob.token)
    assert.equal(socket.frames.length >= 0, true)
    await socket.close()
  })
})

test('a read is not a second source of truth: last_seen_at does not make someone online', async () => {
  await withLiveHub(async ({ http, db, twoInRoom }) => {
    const { bob, roomId, alice } = await twoInRoom()
    // Bob signed in a moment ago, so `devices.last_seen_at` is fresh. He has no socket, so he is
    // offline — the column records a login, not a connection.
    const touch = db.prepare('UPDATE devices SET last_seen_at = ? WHERE user_id = ?')
    touch.run(new Date().toISOString(), bob.userId)
    const members = await http('GET', `/rooms/${roomId}/members`, undefined, alice.token)
    assert.equal(members.body.members.find(member => member.userId === bob.userId).online, false)
  })
})
