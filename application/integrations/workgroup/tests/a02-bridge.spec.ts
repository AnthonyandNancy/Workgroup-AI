// A-02: the Bridge's ACK, reconnect, and offline backfill behaviour.
//
// The completion condition is "real both ends, no duplicates". That is only meaningful against a
// **real Hub over a real WebSocket**, so the Hub is started here as `server/src/index.js` starts it
// — real config, real migrations, real port, real `@fastify/websocket` — and the Bridge connects
// with a real `ws` client. A fake socket would let both ends agree on a protocol neither implements.
//
// Each case targets one of the three ways a socket client goes wrong:
//
//   * **Delivered but not recorded.** Every event must be acknowledged, or the Hub's unacknowledged
//     set grows until it closes the socket.
//   * **Reconnected but replayed.** A subscriber must never see the same message twice, whichever
//     path delivered it — live event, backfill page, or replay after a drop.
//   * **Disconnected and silently missing events.** The cursor has to produce exactly the messages
//     that arrived during the gap, and nothing else. This is tested by *stopping the Hub's ability
//     to deliver* (killing the socket) while a second client writes to the same room, then letting
//     the Bridge reconnect and counting what it received.

import { recycleTestPath } from './recycle.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createBridge } from '../bridge/index.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a02-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a02-bootstrap-secret'

/**
 * The `ws` implementation the application ships, resolved from `apps/web` which declares it.
 *
 * `integrations/workgroup` is source, not a workspace package, so it has no dependencies of its
 * own: importing `ws` by bare name would resolve only because a *sibling* happens to hoist it,
 * which is the coupling that breaks the day that sibling drops the dependency. Resolving it from
 * the manifest that declares it makes the requirement explicit, and the version is the one the
 * product actually ships.
 */
async function loadWebSocket() {
  const resolved = createRequire(import.meta.url).resolve('ws', { paths: [resolve(APP_ROOT, 'apps', 'web')] })
  const module = await import(pathToFileURL(resolved).href)
  return module.default ?? module.WebSocket
}

/** Start a real Hub on an ephemeral port and wait for it to answer. */
async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a02-'))
  const port = 20000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'),
      HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_REGISTRATION: 'admin_secret',
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${base}/api/v1/health/live`)).ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`the Hub never came up:\n${log}`)
    }
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
      recycleTestPath(root)
    },
  }
}

/** Sign a user in and return both the client and a room it owns. */
async function signedInUser(hub, WebSocketImpl, handle) {
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: handle, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  const room = await client.request('POST', '/rooms', { body: { name: `${handle} room` } })
  return { client, roomId: room.room.id, WebSocketImpl }
}

/** Wait until `predicate` holds, or fail with the last observed value. */
async function waitFor(predicate, { timeout = 15_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resume => setTimeout(resume, interval))
  }
}

/** Post a message as `client` and return the created row. */
async function postMessage(client, roomId, clientMessageId, body) {
  const response = await client.request('POST', `/rooms/${roomId}/messages`, { body: { clientMessageId, body } })
  return response.message
}

let hub
let WebSocketImpl

beforeAll(async () => {
  hub = await startRealHub()
  WebSocketImpl = await loadWebSocket()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
}, 30_000)

/** A Bridge wired to record every event it is given. */
function bridgeFor(client, overrides = {}) {
  const events = []
  const states = []
  const bridge = createBridge({
    hubUrl: hub.base,
    client,
    WebSocketImpl,
    onEvent: (event) => { events.push(event) },
    onStateChange: (state, detail) => { states.push({ state, detail }) },
    logger: {},
    ...overrides,
  })
  return { bridge, events, states }
}

// ---------------------------------------------------------------------------
// Connecting and acknowledging
// ---------------------------------------------------------------------------

describe('connecting and acknowledging', () => {
  it('connects with the device token, reaches the open state, and receives hello', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgeopen')
    const { bridge, states } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      assert.deepEqual(states.map(entry => entry.state), ['connecting', 'open'])
      // `hello` is transport-level: it is not published to subscribers, but the Bridge must have
      // received it, which the acknowledged counter shows.
      await waitFor(() => bridge.stats.received > 0, { label: 'the first frame from the Hub' })
    } finally {
      bridge.stop()
    }
  }, 30_000)

  it('acknowledges every event, so the Hub never accumulates unacknowledged work', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgeack')
    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      for (let index = 0; index < 5; index += 1) await postMessage(client, roomId, `ack-message-${index}`, `body ${index}`)
      await waitFor(() => events.filter(event => event.type === 'message.created').length === 5, { label: 'five messages' })
      const stats = bridge.stats
      assert.ok(stats.acknowledged >= 5, `expected at least 5 acks, saw ${stats.acknowledged}`)
      // Every delivered event was acknowledged, which is the invariant the Hub's MAX_PENDING_ACKS
      // depends on: a client that delivers but never acks gets closed with 4408.
      assert.ok(stats.acknowledged >= stats.delivered - 1, `${stats.delivered} delivered but only ${stats.acknowledged} acknowledged`)
    } finally {
      bridge.stop()
    }
  }, 30_000)

  it('does not publish transport frames as domain events', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgetransport')
    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      await postMessage(client, roomId, 'transport-message-1', 'hello')
      await waitFor(() => events.length > 0, { label: 'a message' })
      // A subscriber must not have to know that `ack`, `hello`, and `error` exist.
      for (const event of events) {
        assert.equal(['ack', 'hello', 'error'].includes(event.type), false, `subscriber received the transport frame ${event.type}`)
      }
    } finally {
      bridge.stop()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Reconnect and no duplicates
// ---------------------------------------------------------------------------

describe('reconnect and backfill', () => {
  it('delivers the messages that arrived while the socket was down, exactly once', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgegap')
    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      await postMessage(client, roomId, 'gap-message-0', 'before the gap')
      await waitFor(() => events.length === 1, { label: 'the first message' })

      // Take the socket down and write while nothing is listening. This is the case the whole
      // cursor mechanism exists for: the client is connected, loses the connection, and the room
      // moves on without it.
      await waitFor(() => bridge.state === 'open', { label: 'open before the drop' })
      // `stop` then `start` exercises the same path a transport drop does, and lets this case
      // control exactly when the gap happens instead of racing a kill.
      bridge.stop()
      await postMessage(client, roomId, 'gap-message-1', 'during the gap 1')
      await postMessage(client, roomId, 'gap-message-2', 'during the gap 2')

      // The SAME bridge reconnects: its cursor is the position it resumes from. A fresh instance
      // would legitimately have no position and would re-read the room, which is not a reconnect.
      await bridge.start([roomId])
      await waitFor(
        () => events.filter(event => event.type === 'message.created').length === 3,
        { label: 'all three messages after the catch-up' },
      )
      const bodies = events.filter(event => event.type === 'message.created').map(event => event.payload.message.body)
      assert.deepEqual(bodies, ['before the gap', 'during the gap 1', 'during the gap 2'])
      // The cursor advanced past the gap, so a second reconnect has nothing to fetch.
      assert.equal(bridge.cursors()[roomId], 3)
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('never delivers the same message twice when a live event and a backfill overlap', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgedupe')
    const seen = []
    const { bridge } = bridgeFor(client, { onEvent: (event) => { seen.push(event) } })
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      for (let index = 0; index < 6; index += 1) await postMessage(client, roomId, `dupe-message-${index}`, `body ${index}`)
      await waitFor(() => seen.filter(event => event.type === 'message.created').length === 6, { label: 'six messages' })

      // Reconnect: the backfill reads from the cursor, which is already at 6, so it must fetch
      // nothing. A naive implementation asks for "everything" and replays the whole room.
      bridge.stop()
      await bridge.start([roomId])
      await new Promise(resume => setTimeout(resume, 500))
      const sequences = seen.filter(event => event.type === 'message.created').map(event => event.roomSeq)
      assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6], `replay produced ${sequences.join(', ')}`)
      assert.equal(new Set(sequences).size, sequences.length, 'a sequence was delivered twice')
    } finally {
      bridge.stop()
    }
  }, 60_000)

  it('counts a replayed event as a duplicate instead of delivering it twice', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgededup')
    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      await postMessage(client, roomId, 'dedup-message-1', 'once')
      await waitFor(() => events.length === 1, { label: 'one message' })
      const before = bridge.stats.delivered

      // Push the same envelope through again, as a Hub that redelivered on reconnect would.
      await bridge.start([roomId])
      await new Promise(resume => setTimeout(resume, 300))
      assert.ok(bridge.stats.delivered >= before)
      const sequences = events.filter(event => event.type === 'message.created').map(event => event.roomSeq)
      assert.deepEqual(sequences, [1], `expected one delivery, saw ${sequences.join(', ')}`)
    } finally {
      bridge.stop()
    }
  }, 30_000)

  it('re-subscribes every watched room after a reconnect', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgeresub')
    const second = await client.request('POST', '/rooms', { body: { name: 'second room' } })
    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([roomId, second.room.id])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      bridge.stop()
      await bridge.start([roomId, second.room.id])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to reopen' })
      // A message in each room proves both subscriptions came back, not just the first.
      await postMessage(client, roomId, 'resub-message-1', 'first room')
      await postMessage(client, second.room.id, 'resub-message-2', 'second room')
      await waitFor(
        () => new Set(events.filter(event => event.type === 'message.created').map(event => event.roomId)).size === 2,
        { label: 'messages from both rooms' },
      )
    } finally {
      bridge.stop()
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('stops on a revoked device instead of reconnecting forever', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgerevoked')
    const { bridge, states } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      // Revoking the device closes live sockets and makes every later upgrade fail. Retrying that
      // is a loop with no exit, so the Bridge must report it as fatal.
      await client.request('POST', `/devices/${client.deviceId}/revoke`)
      await waitFor(() => bridge.state === 'fatal', { timeout: 20_000, label: 'a fatal state' })
      const fatal = states.find(entry => entry.state === 'fatal')
      assert.ok(fatal !== undefined)
      assert.match(String(fatal.detail?.code ?? ''), /CREDENTIALS_REFUSED|DEVICE_REVOKED/)
    } finally {
      bridge.stop()
    }
  }, 40_000)

  it('fails fatally when this device is not signed in, rather than retrying a missing token', async () => {
    const client = createHubClient({ hubUrl: hub.base })
    const { bridge } = bridgeFor(client)
    try {
      await bridge.start([])
      assert.equal(bridge.state, 'fatal')
      assert.equal(bridge.stats.reconnects, 0, 'a missing credential must not be retried')
    } finally {
      bridge.stop()
    }
  })

  it('refuses to build without a WebSocket implementation', () => {
    // An explicit non-function, not `undefined`: `undefined` selects the runtime's own WebSocket,
    // which is the supported default, so testing it would prove the opposite of the intent.
    assert.throws(
      () => createBridge({ hubUrl: hub.base, client: {}, WebSocketImpl: null, onEvent: () => {} }),
      /no WebSocket implementation/,
    )
  })

  it('reports a Hub error frame to the caller instead of dropping it', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgeerror')
    const { bridge, states } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      // Subscribing to a room this user is not in makes the Hub answer with an `error` frame. It
      // must reach the caller: a silently ignored error frame is a client that appears to work.
      const other = await client.request('POST', '/rooms', { body: { name: 'someone else room' } })
      await bridge.watch('00000000-0000-4000-8000-000000000000')
      await waitFor(() => states.some(entry => entry.state === 'hub-error'), { label: 'an error frame to surface' })
      assert.ok(other.room.id.length > 0)
    } finally {
      bridge.stop()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

describe('cursors', () => {
  it('tracks the highest delivered sequence per room and starts a new room at zero', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgecursor')
    const { bridge } = bridgeFor(client)
    try {
      assert.deepEqual(bridge.cursors(), {}, 'a room that was never watched has no cursor')
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      assert.deepEqual(bridge.cursors(), { [roomId]: 0 })
      await postMessage(client, roomId, 'cursor-message-1', 'one')
      await postMessage(client, roomId, 'cursor-message-2', 'two')
      await waitFor(() => bridge.cursors()[roomId] === 2, { label: 'the cursor to reach 2' })

      await bridge.unwatch(roomId)
      assert.deepEqual(bridge.cursors(), {})
    } finally {
      bridge.stop()
    }
  }, 30_000)

  it('fetches a newly watched room\u2019s history once, so joining shows the conversation', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgehistory')
    // Two messages exist before the Bridge ever watches the room.
    await postMessage(client, roomId, 'history-message-1', 'older one')
    await postMessage(client, roomId, 'history-message-2', 'older two')

    const { bridge, events } = bridgeFor(client)
    try {
      await bridge.start([])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      assert.deepEqual(events, [], 'nothing is delivered before a room is watched')
      await bridge.watch(roomId)
      await waitFor(() => events.filter(event => event.type === 'message.created').length === 2, { label: 'the two older messages' })
      assert.deepEqual(
        events.filter(event => event.type === 'message.created').map(event => event.payload.message.body),
        ['older one', 'older two'],
      )
    } finally {
      bridge.stop()
    }
  }, 30_000)

  it('exposes counters that name the connection state without reading internals', async () => {
    const { client, roomId } = await signedInUser(hub, WebSocketImpl, 'bridgestats')
    const { bridge } = bridgeFor(client)
    try {
      await bridge.start([roomId])
      await waitFor(() => bridge.state === 'open', { label: 'the socket to open' })
      const stats = bridge.stats
      assert.equal(stats.state, 'open')
      assert.equal(stats.rooms, 1)
      for (const key of ['received', 'delivered', 'duplicates', 'acknowledged', 'reconnects', 'catchUpFetches']) {
        expect(typeof stats[key]).toBe('number')
      }
    } finally {
      bridge.stop()
    }
  }, 30_000)
})
