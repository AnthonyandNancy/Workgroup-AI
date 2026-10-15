// Local Bridge: the device's live connection to the Hub.
//
// One WebSocket, one connection state machine, and one job: keep this device's view of the rooms
// it belongs to current, without duplicates and without silently missing anything.
//
// The three failure modes a naive client has, and what this module does instead:
//
//   1. **A dropped socket loses events with no record.** The Hub tracks unacknowledged events per
//      socket; this client answers every event with an `ack` and keeps its own high-water sequence
//      per room. When the socket comes back it asks the Hub for messages *after* that sequence, so
//      what it missed is defined by a number rather than by a guess.
//   2. **A reconnect replays events the client already has.** Every event is de-duplicated by
//      `eventId` before it reaches a subscriber, and room messages are also filtered by `roomSeq`.
//      A subscriber is therefore allowed to be at-least-once at the transport level.
//   3. **Reconnect storms.** Attempts back off exponentially with jitter, and a Hub that refuses
//      the credentials (revoked device, disabled account) is *not* retried at all — retrying an
//      authentication failure forever is how a client looks like an attack and hides a real error.
//
// The Bridge never executes anything a remote peer asks. It delivers events to local subscribers;
// the one thing that acts on a task is `bot-adapter`, and only after the local policy checks
// (A-07) have approved it. That separation is the reason a compromised Hub cannot make a client
// run a command: there is no code path from an inbound frame to an execution.

import { apiRootOf, HubProtocolError, HUB_ERROR_CODES } from '../protocol/index.mjs'

/** Websocket close codes this client treats as "do not retry": the credential is not accepted. */
const FATAL_CLOSE_CODES = new Set([4401, 4403])

/** Backoff shape. Chosen so a Hub restart is recovered from quickly and an outage is not hammered. */
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

const ROOM_EVENT_PREFIXES = ['message.created', 'invitation.created', 'member.changed', 'task.', 'group_memory.changed']

export class BridgeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * A room's catch-up position.
 *
 * `seq` is the highest `roomSeq` this client has *delivered*. It is intentionally advanced only
 * after a subscriber has seen the event, so a crash mid-delivery re-fetches rather than skips.
 */
class RoomCursor {
  constructor(roomId) {
    this.roomId = roomId
    this.seq = 0
    /** @type {Set<string>} event ids already delivered, bounded below by `seq`. */
    this.seen = new Set()
  }
}

/**
 * Create a Bridge.
 *
 * @param {{
 *   hubUrl: string,
 *   client: object,
 *   WebSocketImpl?: typeof WebSocket,
 *   onEvent?: (event: object) => void | Promise<void>,
 *   onStateChange?: (state: string, detail?: object) => void,
 *   now?: () => number,
 *   random?: () => number,
 *   logger?: { warn?: Function, info?: Function },
 * }} options
 */
export function createBridge(options) {
  const {
    hubUrl,
    client,
    WebSocketImpl = globalThis.WebSocket,
    onEvent = () => {},
    onStateChange = () => {},
    now = () => Date.now(),
    random = Math.random,
    logger = {},
  } = options
  if (typeof WebSocketImpl !== 'function') throw new BridgeError('This runtime has no WebSocket implementation', 'NO_WEBSOCKET')

  const root = apiRootOf(hubUrl)
  const socketUrl = `${root.replace(/^http/, 'ws')}/realtime`

  /** @type {Map<string, RoomCursor>} */
  const rooms = new Map()
  let socket
  let state = 'idle'
  let attempt = 0
  let timer
  let stopped = true
  let generation = 0
  const delivered = new Set()
  const stats = { received: 0, delivered: 0, duplicates: 0, acknowledged: 0, reconnects: 0, catchUpFetches: 0 }

  const setState = (next, detail) => {
    if (state === next) return
    state = next
    onStateChange(next, detail)
  }

  const cursorFor = (roomId) => {
    let cursor = rooms.get(roomId)
    if (cursor === undefined) {
      cursor = new RoomCursor(roomId)
      rooms.set(roomId, cursor)
    }
    return cursor
  }

  const send = (frame) => {
    if (socket === undefined || socket.readyState !== 1) return false
    socket.send(JSON.stringify({ schemaVersion: 'wg.v1', ...frame }))
    return true
  }

  /** Answer an event so the Hub can drop it from its unacknowledged set. */
  const acknowledge = (eventId) => {
    if (send({ type: 'ack', eventId })) stats.acknowledged += 1
  }

  const isRoomEvent = (event) => typeof event.type === 'string' && ROOM_EVENT_PREFIXES.some(prefix => event.type === prefix || event.type.startsWith(prefix))

  /**
   * Hand one event to the subscriber, once.
   *
   * The ack is sent *after* the subscriber returns, so a crash during processing leaves the event
   * unacknowledged and the Hub still holds it. Acking first would be faster and would lose events
   * exactly when they matter.
   */
  const deliver = async (event) => {
    stats.received += 1
    if (typeof event?.eventId !== 'string') return
    if (event.type === 'ack' || event.type === 'hello' || event.type === 'error') {
      // Transport-level frames are answered but not published: a subscriber cares about the
      // domain, and `hello`/`error` are surfaced through `onStateChange` instead.
      if (event.type === 'error') onStateChange('hub-error', { code: event.payload?.code, message: event.payload?.message })
      return
    }
    const cursor = event.roomId === undefined ? undefined : cursorFor(event.roomId)
    if (delivered.has(event.eventId)) {
      stats.duplicates += 1
      acknowledge(event.eventId)
      return
    }
    if (cursor !== undefined && typeof event.roomSeq === 'number' && event.roomSeq <= cursor.seq) {
      // Already covered by the catch-up fetch or by an earlier delivery. Skipping is the point:
      // at-least-once delivery is only safe if the client is the one that removes the duplicates.
      stats.duplicates += 1
      acknowledge(event.eventId)
      return
    }

    await onEvent(event)
    stats.delivered += 1
    delivered.add(event.eventId)
    if (cursor !== undefined) {
      if (typeof event.roomSeq === 'number' && event.roomSeq > cursor.seq) cursor.seq = event.roomSeq
      cursor.seen.add(event.eventId)
      // `seen` is bounded: the cursor already filters by sequence, so ids below it can be released.
      if (cursor.seen.size > 512) cursor.seen.clear()
    }
    if (delivered.size > 4096) {
      // Bound the global de-duplication set too. It only needs to cover a reconnect window, and an
      // unbounded set is a memory leak in a process that is meant to run for weeks.
      delivered.clear()
    }
    acknowledge(event.eventId)
  }

  /**
   * Fetch whatever this client missed while it was disconnected.
   *
   * This is the offline backfill: for each room, ask the Hub for messages after the cursor and
   * deliver them in order. It runs *after* subscription and before the socket's own events are
   * trusted, so a message that arrived during the gap is delivered once, from one source.
   */
  const catchUp = async (roomIds) => {
    for (const roomId of roomIds) {
      const cursor = cursorFor(roomId)
      let guard = 0
      for (;;) {
        guard += 1
        if (guard > 100) {
          // A room with more than 100 pages of backlog is a misconfiguration or a runaway; stop
          // rather than fetch forever, and say so.
          logger.warn?.({ roomId, afterSeq: cursor.seq }, 'catch-up stopped after 100 pages')
          break
        }
        stats.catchUpFetches += 1
        const page = await client.request('GET', `/rooms/${roomId}/messages?afterSeq=${cursor.seq}&limit=200`)
        const messages = page?.messages ?? []
        for (const message of messages) {
          if (typeof message.roomSeq !== 'number' || message.roomSeq <= cursor.seq) continue
          // A backfilled page is delivered through the same path as a live event, so a subscriber
          // cannot tell (and does not need to tell) which one it is.
          await onEvent({
            schemaVersion: 'wg.v1',
            eventId: `catchup:${roomId}:${message.roomSeq}`,
            type: 'message.created',
            roomId,
            roomSeq: message.roomSeq,
            issuedAt: message.createdAt,
            payload: { message },
          })
          stats.delivered += 1
          cursor.seq = message.roomSeq
        }
        if (page?.hasMore !== true) break
        if (messages.length === 0) break
      }
    }
  }

  const subscribeTo = (roomId) => {
    const cursor = cursorFor(roomId)
    cursorFor(roomId)
    send({ type: 'subscribe', roomId, requestId: `subscribe:${roomId}` })
  }

  const scheduleReconnect = () => {
    if (stopped) return
    // Exponential backoff with jitter. Without jitter, every client of a restarted Hub reconnects
    // in lockstep and the Hub is hit by a synchronised burst.
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt)
    const delay = Math.round(ceiling / 2 + random() * (ceiling / 2))
    attempt += 1
    stats.reconnects += 1
    setState('reconnecting', { attempt, delayMs: delay })
    timer = setTimeout(() => { void connect() }, delay)
  }

  const connect = async () => {
    if (stopped) return
    const myGeneration = ++generation
    setState('connecting')
    try {
      await client.ensureFreshToken()
    } catch (error) {
      // The credential could not be refreshed, so there is nothing to connect with. This is not a
      // transient network problem and retrying it would be a loop, so the Bridge stops and says why.
      setState('fatal', { code: error.code, message: error.message })
      stopped = true
      return
    }

    const token = client.accessToken
    if (token === undefined) {
      setState('fatal', { code: HUB_ERROR_CODES.UNAUTHENTICATED, message: 'This device is not signed in to the Hub' })
      stopped = true
      return
    }

    // The token rides in the header rather than the query string: URLs end up in access logs, and a
    // bearer token in a log is a credential leak.
    const next = new WebSocketImpl(socketUrl, { headers: { authorization: `Bearer ${token}` } })
    socket = next

    next.addEventListener('open', () => {
      if (myGeneration !== generation) {
        // A newer attempt superseded this socket while it was connecting; closing it is what keeps
        // two live sockets from delivering the same events twice.
        try { next.close(4409, 'superseded') } catch { /* already gone */ }
        return
      }
      attempt = 0
      setState('open')
      const roomIds = [...rooms.keys()]
      for (const roomId of roomIds) send({ type: 'subscribe', roomId, requestId: `subscribe:${roomId}` })
    })

    next.addEventListener('message', (message) => {
      let event
      try {
        event = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data))
      } catch {
        logger.warn?.({ raw: typeof message.data }, 'the Hub sent a frame that is not JSON')
        return
      }
      void deliver(event).catch((error) => {
        logger.warn?.({ err: error }, 'a subscriber failed to handle an event')
      })
    })

    next.addEventListener('close', (close) => {
      if (myGeneration !== generation) return
      const code = close?.code ?? 0
      if (FATAL_CLOSE_CODES.has(code)) {
        // The Hub refused this device's credentials. Retrying cannot fix that; the user has to
        // register the device again, and a client that loops here would hide the message.
        setState('fatal', { code: 'CREDENTIALS_REFUSED', message: `The Hub refused this device (close code ${code})` })
        stopped = true
        return
      }
      scheduleReconnect()
    })

    next.addEventListener('error', () => {
      // An error is always followed by a close; the close handler owns reconnection.
      logger.warn?.({ url: socketUrl }, 'the Hub socket reported an error')
    })
  }

  return {
    /**
     * Connect and subscribe to `roomIds`.
     *
     * Rooms are remembered before the socket opens, so a reconnect re-subscribes without the
     * caller having to replay its own state.
     */
    async start(roomIds = []) {
      stopped = false
      attempt = 0
      for (const roomId of roomIds) cursorFor(roomId)
      // The catch-up runs before connecting: whatever was missed while offline is delivered first,
      // so a subscriber sees history in order and the live socket can only add newer events.
      if (client.signedIn) {
        try {
          await catchUp([...rooms.keys()])
        } catch (error) {
          // A failed catch-up must not prevent connecting: live events are still worth having, and
          // the cursor is unchanged so the next reconnect tries again.
          logger.warn?.({ err: error }, 'catch-up failed; the cursor is unchanged so a later attempt will retry it')
        }
      }
      await connect()
    },

    /** Add a room to the subscription set, live and across reconnects. */
    async watch(roomId) {
      const known = rooms.has(roomId)
      cursorFor(roomId)
      if (!known && client.signedIn) {
        // A newly watched room has no cursor yet, so its whole history is fetched once. This is what
        // makes "join a room and see the conversation" work without a separate code path.
        try {
          await catchUp([roomId])
        } catch (error) {
          logger.warn?.({ err: error, roomId }, 'initial catch-up for a newly watched room failed')
        }
      }
      subscribeTo(roomId)
    },

    /** Stop watching a room and unsubscribe. */
    unwatch(roomId) {
      if (!rooms.has(roomId)) return
      send({ type: 'unsubscribe', roomId })
      rooms.delete(roomId)
    },

    /**
     * Disconnect and cancel any pending reconnect.
     *
     * **Cursors survive**: `start()` after `stop()` is a reconnect that resumes where the last
     * connection left off, which is what a caller wants across a network outage. A caller that
     * wants to start over builds a new Bridge, because "forget what I have seen" and "reconnect"
     * are different intentions and one of them loses events.
     */
    stop() {
      stopped = true
      generation += 1
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (socket !== undefined) {
        try { socket.close(1000, 'the client is shutting down') } catch { /* already gone */ }
      }
      socket = undefined
      setState('closed')
    },

    /** The highest sequence delivered per room, so a caller can persist its position. */
    cursors() {
      return Object.fromEntries([...rooms].map(([roomId, cursor]) => [roomId, cursor.seq]))
    },

    get state() {
      return state
    },

    /** Counters a UI or a diagnostic can show without reading internals. */
    get stats() {
      return { ...stats, state, rooms: rooms.size }
    },

    /** Exposed for tests and for a caller that needs to force a reconnect. */
    reconnect: () => { void connect() },
  }
}
