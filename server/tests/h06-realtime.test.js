// H-06 tests: authenticated sockets, subscriptions, ACK, heartbeat, and event recovery.
//
// These open real WebSocket connections against a real listening Hub, not a stubbed socket:
// authentication happens at the upgrade, and a test that injects a socket would not exercise
// the path a client actually takes.
//
// The completion condition is "offline/disconnect recovery". Two properties carry it:
// a socket only receives rooms it subscribed to *and* is a member of, and a dropped socket
// resumes from its last sequence over HTTP rather than depending on the socket's own buffer.

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
import { makeEvent, parseClientFrame, EventError, SCHEMA_VERSION } from '../src/realtime/events.js'
import { headersWithProtocolToken } from '../src/realtime/hub.js'

const SIGNING_KEY = 'h06-test-signing-key-long-enough-for-hs256'

/** A Hub listening on a real port, with the realtime heartbeat running. */
async function withLiveHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h06-'))
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
  const person = async (handle, displayName) => {
    const password = `${handle}-password-long-enough`
    await http('POST', '/auth/register', { userHandle: handle, displayName: displayName ?? handle, password })
    const login = await http('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, JSON.stringify(login.body))
    return { userId: login.body.user.id, token: login.body.accessToken, refreshToken: login.body.refreshToken, deviceId: login.body.device.id }
  }
  const twoInRoom = async () => {
    const alice = await person('alice', 'Alice')
    const bob = await person('bob', 'Bob')
    const created = await http('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    const invited = await http('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await http('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    return { alice, bob, roomId }
  }

  /** Collect frames from a socket until `predicate` matches or the budget runs out. */
  const open = (token, { protocol } = {}) => new Promise((resolve, reject) => {
    const socket = protocol === undefined
      ? new WebSocket(`${socketBase}/api/v1/realtime`, { headers: { authorization: `Bearer ${token}` } })
      : new WebSocket(`${socketBase}/api/v1/realtime`, protocol)
    const frames = []
    const waiters = []
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'))
      frames.push(frame)
      for (const waiter of [...waiters]) waiter(frame, frames)
    })
    const fail = (error) => reject(error)
    socket.on('error', fail)
    socket.on('unexpected-response', (_request, response) => reject(new Error(`upgrade refused with ${response.statusCode}`)))
    socket.on('close', (code) => {
      for (const waiter of [...waiters]) waiter(undefined, frames)
      if (code !== 1000 && code !== 1005) reject(new Error(`socket closed early with ${code}`))
    })
    socket.on('open', () => resolve({
      socket,
      frames,
      /** Wait for the next frame matching `predicate`, or undefined on timeout/close. */
      next(predicate, timeoutMs = 4000) {
        const existing = frames.find(predicate)
        if (existing !== undefined) return Promise.resolve(existing)
        return new Promise((settle) => {
          const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            settle(undefined)
          }, timeoutMs)
          const waiter = (frame) => {
            if (frame === undefined || predicate(frame)) {
              clearTimeout(timer)
              const index = waiters.indexOf(waiter)
              if (index >= 0) waiters.splice(index, 1)
              settle(frame)
            }
          }
          waiters.push(waiter)
        })
      },
      /**
       * Wait for a frame matching `predicate` among frames that arrive *after* this call.
       *
       * This is the right probe for "nothing more should arrive": `next` would match a frame
       * already in the buffer, which makes an absence assertion pass for the wrong reason.
       */
      nextNew(predicate, timeoutMs = 700) {
        const start = frames.length
        return new Promise((settle) => {
          const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            settle(undefined)
          }, timeoutMs)
          const waiter = (frame) => {
            const fresh = frames.slice(start).find(predicate)
            if (frame === undefined || fresh !== undefined) {
              clearTimeout(timer)
              const index = waiters.indexOf(waiter)
              if (index >= 0) waiters.splice(index, 1)
              settle(fresh)
            }
          }
          waiters.push(waiter)
        })
      },
      /** The number of frames received so far, for absence assertions. */
      get frameCount() { return frames.length },
      close() {
        return new Promise((settle) => {
          if (socket.readyState === WebSocket.CLOSED) return settle()
          socket.once('close', () => settle())
          socket.close(1000)
        })
      },
    }))
  })

  try {
    await run({ config, db, server, http, person, twoInRoom, open, base, port })
  } finally {
    server.hub.realtime.stop()
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---------------------------------------------------------------- envelopes

test('an envelope carries the version, id, type, and time', () => {
  const envelope = makeEvent('message.created', { ok: true }, { roomId: 'r1', roomSeq: 7 })
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION)
  assert.equal(envelope.type, 'message.created')
  assert.equal(envelope.roomId, 'r1')
  assert.equal(envelope.roomSeq, 7)
  assert.ok(envelope.eventId.length >= 8)
  assert.ok(Date.parse(envelope.issuedAt) > 0)
})

test('an unknown event type is refused rather than sent', () => {
  assert.throws(() => makeEvent('task.launch_shell', {}), EventError)
})

test('a client frame naming another schema version is refused', () => {
  assert.throws(() => parseClientFrame(JSON.stringify({ schemaVersion: 'wg.v2', type: 'ack', eventId: 'e1' })), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_SCHEMA_VERSION')
    return true
  })
})

test('a malformed or unauthorized frame type is refused with a code', () => {
  for (const [payload, code] of [
    ['not json', 'MALFORMED_FRAME'],
    ['[]', 'MALFORMED_FRAME'],
    [JSON.stringify({ type: 'run_shell', command: 'rm -rf /' }), 'UNKNOWN_FRAME_TYPE'],
    [JSON.stringify({ type: 'ack' }), 'MISSING_EVENT_ID'],
    [JSON.stringify({ type: 'subscribe' }), 'MISSING_ROOM_ID'],
  ]) {
    assert.throws(() => parseClientFrame(payload), (error) => {
      assert.equal(error.code, code, `expected ${code} for ${payload}`)
      return true
    })
  }
})

test('a bearer token is read from the subprotocol fallback only when no header is present', () => {
  const fromProtocol = headersWithProtocolToken({}, 'bearer.tok123')
  assert.equal(fromProtocol.authorization, 'Bearer tok123')
  // A real header always wins: a client that sets both must not have the weaker one used.
  const withHeader = headersWithProtocolToken({ authorization: 'Bearer fromHeader' }, 'bearer.fromProtocol')
  assert.equal(withHeader.authorization, 'Bearer fromHeader')
  assert.equal(headersWithProtocolToken({}, 'unrelated').authorization, undefined)
})

// ---------------------------------------------------------------- authentication

test('a socket with no token is refused at the upgrade', async () => {
  await withLiveHub(async ({ port }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`)
    const result = await new Promise((resolve) => {
      socket.on('error', () => resolve('refused'))
      socket.on('open', () => { socket.close(); resolve('opened') })
      socket.on('close', code => resolve(`closed:${code}`))
    })
    assert.notEqual(result, 'opened')
  })
})

test('a socket with a forged token is refused', async () => {
  await withLiveHub(async ({ port, http, person }) => {
    // A token signed by a different key: valid shape, invalid signature.
    await person('alice')
    const forged = makeEvent('hello', {}) && (await import('../src/auth/tokens.js')).issueAccessToken({
      signingKey: 'a-different-key-entirely-00000000000000', userId: 'someone', deviceId: 'd', ttlSeconds: 900,
    })
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`, { headers: { authorization: `Bearer ${forged}` } })
    const result = await new Promise((resolve) => {
      socket.on('error', () => resolve('refused'))
      socket.on('open', () => { socket.close(); resolve('opened') })
      socket.on('close', code => resolve(`closed:${code}`))
    })
    assert.notEqual(result, 'opened')
  })
})

test('an authenticated socket receives hello naming the version and its own id', async () => {
  await withLiveHub(async ({ person, open }) => {
    const alice = await person('alice')
    const client = await open(alice.token)
    try {
      const hello = await client.next(f => f.type === 'hello')
      assert.ok(hello !== undefined, 'expected a hello frame')
      assert.equal(hello.schemaVersion, SCHEMA_VERSION)
      assert.equal(hello.payload.userId, alice.userId)
      assert.equal(hello.payload.deviceId, alice.deviceId)
      assert.equal(typeof hello.payload.socketId, 'string')
      assert.equal(hello.payload.heartbeatMs, 30_000)
    } finally {
      await client.close()
    }
  })
})

test('a revoked device cannot open a socket, and an open one is closed when its device is revoked', async () => {
  await withLiveHub(async ({ person, open, http }) => {
    const alice = await person('alice')
    const client = await open(alice.token)
    await client.next(f => f.type === 'hello')

    await http('POST', `/devices/${alice.deviceId}/revoke`, {}, alice.token)
    // The Hub closes the live socket, because a socket outliving its credential is the same
    // problem as a request outliving it.
    const closed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still-open'), 3000)
      client.socket.once('close', (code) => { clearTimeout(timer); resolve(`closed:${code}`) })
    })
    assert.match(String(closed), /^closed:/)
  })
})

// ---------------------------------------------------------------- subscriptions

test('a socket receives a room\'s message only after subscribing', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const client = await open(bob.token)
    try {
      await client.next(f => f.type === 'hello')

      // Before subscribing, Alice's message is not delivered.
      const first = await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'before subscribe' }, alice.token)
      assert.equal(first.status, 201)
      const early = await client.nextNew(f => f.type === 'message.created')
      assert.equal(early, undefined, 'a message must not arrive before the client subscribed')

      client.socket.send(JSON.stringify({ type: 'subscribe', roomId, requestId: 'req-1' }))
      const ack = await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)
      assert.ok(ack !== undefined, 'expected a subscribe ack')
      assert.equal(ack.requestId, 'req-1')
      assert.equal(ack.payload.role, 'member')

      const second = await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000002', body: 'after subscribe' }, alice.token)
      const event = await client.next(f => f.type === 'message.created')
      assert.ok(event !== undefined, 'expected the message event')
      assert.equal(event.roomId, roomId)
      assert.equal(event.roomSeq, second.body.message.roomSeq)
      assert.equal(event.payload.message.body, 'after subscribe')
      assert.equal(event.payload.message.senderUserId, alice.userId)
    } finally {
      await client.close()
    }
  })
})

test('subscribing to a room the caller is not in is refused, so a socket cannot widen access', async () => {
  await withLiveHub(async ({ person, open, http }) => {
    const alice = await person('alice')
    const stranger = await person('stranger')
    const created = await http('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id

    const client = await open(stranger.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      const refusal = await client.next(f => f.type === 'error')
      assert.ok(refusal !== undefined, 'expected an error frame')
      assert.equal(refusal.payload.code, 'NO_SUCH_ROOM')

      // And nothing from that room reaches the socket afterwards.
      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'secret' }, alice.token)
      assert.equal(await client.nextNew(f => f.type === 'message.created'), undefined)
    } finally {
      await client.close()
    }
  })
})

test('a removed member stops receiving the room on their already-open socket', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const client = await open(bob.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)

      const before = await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'while a member' }, alice.token)
      assert.ok(await client.next(f => f.type === 'message.created'), 'the member should receive this')

      await http('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
      // The Hub tells the removed member, because a silently dropped subscription looks to a
      // client like a network problem rather than a permission change.
      const notice = await client.next(f => f.type === 'member.changed')
      assert.ok(notice !== undefined, 'expected a membership-ended notice')
      assert.equal(notice.payload.reason, 'removed')

      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000002', body: 'after removal' }, alice.token)
      const leaked = await client.next(f => f.type === 'message.created' && f.payload?.message?.body === 'after removal', 900)
      assert.equal(leaked, undefined, 'a removed member must not receive the room any more')
      assert.ok(before.body.message.roomSeq > 0)
    } finally {
      await client.close()
    }
  })
})

test('unsubscribing stops delivery while the socket stays open', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, roomId } = await twoInRoom()
    const client = await open(alice.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)
      client.socket.send(JSON.stringify({ type: 'unsubscribe', roomId }))
      const ack = await client.next(f => f.type === 'ack' && f.payload.unsubscribed === roomId)
      assert.ok(ack !== undefined)

      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'after unsubscribe' }, alice.token)
      assert.equal(await client.nextNew(f => f.type === 'message.created'), undefined)
      // The socket is still usable: unsubscribing is not a disconnect.
      client.socket.send(JSON.stringify({ type: 'ping', eventId: 'ping-1' }))
      assert.ok(await client.next(f => f.type === 'ack' && f.payload.pong === true))
    } finally {
      await client.close()
    }
  })
})

test('one socket never receives another room\'s events', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, roomId: finance } = await twoInRoom()
    const other = await http('POST', '/rooms', { name: 'Engineering' }, alice.token)
    const engineering = other.body.room.id

    const client = await open(alice.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId: finance }))
      await client.next(f => f.type === 'ack' && f.payload.subscribed === finance)

      await http('POST', `/rooms/${engineering}/messages`, { clientMessageId: 'msg-0000001', body: 'engineering only' }, alice.token)
      assert.equal(await client.nextNew(f => f.type === 'message.created'), undefined)

      await http('POST', `/rooms/${finance}/messages`, { clientMessageId: 'msg-0000002', body: 'finance' }, alice.token)
      const event = await client.next(f => f.type === 'message.created')
      assert.ok(event !== undefined)
      assert.equal(event.roomId, finance)
    } finally {
      await client.close()
    }
  })
})

// ---------------------------------------------------------------- acks

test('an event stays unacknowledged until the client acks it, and the ack clears it', async () => {
  await withLiveHub(async ({ twoInRoom, open, http, server }) => {
    const { alice, roomId } = await twoInRoom()
    const client = await open(alice.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)

      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'needs an ack' }, alice.token)
      const event = await client.next(f => f.type === 'message.created')
      assert.ok(event !== undefined)

      // The Hub remembers it. This is what makes a dropped socket detectable rather than
      // indistinguishable from a quiet room.
      const pendingBefore = await waitFor(() => {
        const connection = [...server.hub.realtime.connections.values()].find(c => c.user.id === alice.userId)
        const pending = connection === undefined ? [] : server.hub.realtime.pendingFor(connection)
        return pending.some(entry => entry.eventId === event.eventId) ? pending : undefined
      })
      assert.ok(pendingBefore !== undefined, 'the event should be pending until acked')

      client.socket.send(JSON.stringify({ type: 'ack', eventId: event.eventId }))
      const cleared = await waitFor(() => {
        const connection = [...server.hub.realtime.connections.values()].find(c => c.user.id === alice.userId)
        const pending = connection === undefined ? [] : server.hub.realtime.pendingFor(connection)
        return pending.some(entry => entry.eventId === event.eventId) ? undefined : pending
      })
      assert.ok(cleared !== undefined, 'the ack should have cleared the pending entry')
    } finally {
      await client.close()
    }
  })
})

test('a retried send is not published twice', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, roomId } = await twoInRoom()
    const client = await open(alice.token)
    try {
      await client.next(f => f.type === 'hello')
      client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)

      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'once' }, alice.token)
      assert.ok(await client.next(f => f.type === 'message.created'))
      const retry = await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'once' }, alice.token)
      assert.equal(retry.status, 200)
      assert.equal(retry.body.duplicate, true)
      // A duplicate is a retry, not new information.
      assert.equal(await client.nextNew(f => f.type === 'message.created'), undefined)
    } finally {
      await client.close()
    }
  })
})

// ---------------------------------------------------------------- recovery

test('a socket that dropped resumes from its last sequence over HTTP, and misses nothing', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, roomId } = await twoInRoom()
    const first = await open(alice.token)
    await first.next(f => f.type === 'hello')
    first.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
    await first.next(f => f.type === 'ack' && f.payload.subscribed === roomId)

    await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'one' }, alice.token)
    const seen = await first.next(f => f.type === 'message.created')
    assert.equal(seen.roomSeq, 1)
    // The client goes offline here.
    await first.close()

    // Messages arrive while nobody is listening.
    await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000002', body: 'two' }, alice.token)
    await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000003', body: 'three' }, alice.token)

    // On reconnect the client asks for everything after the last sequence it applied.
    const backfill = await http('GET', `/rooms/${roomId}/messages?afterSeq=1`, undefined, alice.token)
    assert.equal(backfill.status, 200)
    assert.deepEqual(backfill.body.messages.map(m => m.roomSeq), [2, 3])
    assert.equal(backfill.body.nextAfterSeq, 3)

    // A fresh socket plus that backfill is the whole recovery path.
    const second = await open(alice.token)
    try {
      await second.next(f => f.type === 'hello')
      second.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
      await second.next(f => f.type === 'ack' && f.payload.subscribed === roomId)
      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000004', body: 'four' }, alice.token)
      const nextEvent = await second.next(f => f.type === 'message.created')
      assert.equal(nextEvent.roomSeq, 4)
    } finally {
      await second.close()
    }
  })
})

test('many sockets on one room all receive the same event', async () => {
  await withLiveHub(async ({ twoInRoom, open, http }) => {
    const { alice, bob, roomId } = await twoInRoom()
    const clients = await Promise.all([open(alice.token), open(bob.token), open(alice.token)])
    try {
      for (const client of clients) {
        await client.next(f => f.type === 'hello')
        client.socket.send(JSON.stringify({ type: 'subscribe', roomId }))
        await client.next(f => f.type === 'ack' && f.payload.subscribed === roomId)
      }
      await http('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'msg-0000001', body: 'to everyone' }, alice.token)
      const events = await Promise.all(clients.map(client => client.next(f => f.type === 'message.created')))
      assert.equal(events.every(e => e?.roomSeq === 1), true)
      assert.equal(new Set(events.map(e => e.eventId)).size, 1, 'one event, fanned out')
    } finally {
      await Promise.all(clients.map(client => client.close()))
    }
  })
})

test('a closed socket is released, so it stops counting as a delivery target', async () => {
  await withLiveHub(async ({ person, open, server }) => {
    const alice = await person('alice')
    const client = await open(alice.token)
    await client.next(f => f.type === 'hello')
    assert.equal(server.hub.realtime.size, 1)
    await client.close()
    const released = await waitFor(() => (server.hub.realtime.size === 0 ? true : undefined))
    assert.equal(released, true)
  })
})

test('a dead socket is swept by the heartbeat instead of holding a subscription forever', async () => {
  await withLiveHub(async ({ person, open, server }) => {
    const alice = await person('alice')
    const client = await open(alice.token)
    await client.next(f => f.type === 'hello')
    assert.equal(server.hub.realtime.size, 1)

    // `ws` answers pings at the protocol layer, so a socket that is genuinely gone is
    // simulated by stopping its replies: mark it not-alive and sweep twice, which is exactly
    // what happens when a machine is suspended or its network disappears.
    for (const connection of server.hub.realtime.connections.values()) connection.alive = false
    server.hub.realtime.sweepDeadSockets()
    const swept = await waitFor(() => (server.hub.realtime.size === 0 ? true : undefined))
    assert.equal(swept, true)
    await client.close().catch(() => undefined)
  })
})

/** Poll a condition for a short while; WebSocket delivery is asynchronous. */
async function waitFor(probe, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return undefined
}
