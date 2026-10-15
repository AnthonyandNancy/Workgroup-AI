// Realtime hub: authenticated sockets, room subscriptions, delivery with ACK tracking, and
// heartbeat.
//
// What each part is for:
//
//  * **Authentication at the upgrade.** The token is read from the `Authorization` header,
//    never from the query string: a URL ends up in access logs, browser history, and proxy
//    traces, and a bearer token there is a leak. The `Sec-WebSocket-Protocol` fallback
//    exists only because a browser cannot set headers on `new WebSocket`, and it is marked
//    as a fallback in the docs.
//  * **Subscriptions are authorization, not filtering.** `subscribe` re-checks membership in
//    the database before a room is added, and `removeMember`/`leave` revoke it immediately.
//    A socket cannot receive a room's events by claiming to be subscribed.
//  * **Delivery is tracked per event.** Every event gets an id; the socket keeps unacked ids
//    so a reconnecting client can ask what it missed, and so a slow consumer can be seen
//    rather than silently buffered forever.
//  * **Heartbeat closes dead sockets.** A half-open TCP connection is indistinguishable from
//    an idle client until something is sent, so the Hub pings and drops what does not answer.
//    Without it, a laptop that closed its lid keeps a subscription slot and its user keeps
//    believing they are online.
//
// The Hub never sends a command. Every outbound frame is a notification about Hub state;
// nothing here can ask a client to run anything.

import { makeEvent, parseClientFrame, EventError, SCHEMA_VERSION } from './events.js'

/** How long a socket may go without answering a ping before it is closed. */
const HEARTBEAT_INTERVAL_MS = 30_000
/** Frames a socket may have outstanding before the Hub stops adding more work. */
const MAX_PENDING_ACKS = 512

export class RealtimeHub {
  /**
   * @param {{ db: object, config: object, authenticate: Function, log?: object }} deps
   */
  constructor({ db, config, authenticate, log }) {
    this.db = db
    this.config = config
    // Exposed so the upgrade route authenticates with the same function the HTTP routes use;
    // a second copy would be a weaker door on one of the two paths.
    this.authenticate = authenticate
    this.log = log
    this.heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS
    /** @type {Map<string, object>} socketId -> connection record */
    this.connections = new Map()
    this.heartbeat = undefined
  }

  /** Start the heartbeat timer. Called once when the server is listening. */
  start() {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => this.sweepDeadSockets(), HEARTBEAT_INTERVAL_MS)
    // Node keeps the process alive for a pending timer; the Hub's own shutdown owns the exit.
    this.heartbeat.unref?.()
  }

  stop() {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close(1001, 'the Hub is shutting down')
      } catch {
        // A socket that is already gone needs no closing.
      }
    }
    this.connections.clear()
  }

  /**
   * Admit an already-authenticated socket.
   *
   * Authentication belongs to the upgrade hook, which runs before the handshake completes;
   * by the time this is called the caller is known. Keeping the split explicit is what makes
   * "a rejected client never gets an open socket" true rather than aspirational.
   *
   * Two ceilings apply here, both from configuration: a per-user one, so one account with a
   * connection leak cannot fill the Hub's table, and a whole-process one, so the Hub refuses a
   * new socket with a diagnosable code instead of being pushed into an out-of-memory exit that
   * takes every existing session with it. `0` configures no ceiling.
   *
   * @param {{ socket: object, auth: { user: object, deviceId: string } }} options
   */
  admitFor({ socket, auth }) {
    if (socket === undefined || auth === undefined) {
      return { ok: false, code: 'NOT_AUTHENTICATED' }
    }
    const perUser = this.config?.security?.maxConnectionsPerUser ?? 0
    const total = this.config?.security?.maxConnectionsTotal ?? 0
    if (total > 0 && this.connections.size >= total) {
      return { ok: false, code: 'TOO_MANY_CONNECTIONS' }
    }
    if (perUser > 0 && this.countForUser(auth.user.id) >= perUser) {
      return { ok: false, code: 'TOO_MANY_CONNECTIONS_FOR_USER' }
    }
    const id = globalThis.crypto.randomUUID()
    const connection = {
      id,
      socket,
      user: auth.user,
      deviceId: auth.deviceId,
      /** @type {Set<string>} room ids this socket receives events for */
      rooms: new Set(),
      /** @type {Map<string, {type: string, roomId?: string, roomSeq?: number, sentAt: number}>} unacked events */
      unacked: new Map(),
      alive: true,
      closed: false,
    }
    this.connections.set(id, connection)
    return { ok: true, connection, auth }
  }

  /** Open sockets belonging to one user. Counting them is what makes a per-user cap possible. */
  countForUser(userId) {
    let count = 0
    for (const connection of this.connections.values()) {
      if (connection.user.id === userId) count += 1
    }
    return count
  }

  /** Remove a socket. Its subscriptions go with it; nothing else is affected. */
  release(connection) {
    connection.closed = true
    this.connections.delete(connection.id)
  }

  /** Subscribe a socket to a room, re-checking membership every time. */
  subscribe(connection, roomId) {
    const membership = this.db.prepare(
      'SELECT role FROM room_members WHERE room_id = ? AND user_id = ? AND removed_at IS NULL',
    ).get(roomId, connection.user.id)
    if (membership === undefined) return { ok: false, code: 'NO_SUCH_ROOM' }
    connection.rooms.add(roomId)
    return { ok: true, roomId, role: membership.role }
  }

  unsubscribe(connection, roomId) {
    connection.rooms.delete(roomId)
    return { ok: true, roomId }
  }

  /**
   * Drop a room from every live socket, for example after a member is removed.
   *
   * Without this, a removed member's open socket would keep receiving the room's events
   * until something else closed it — the subscription check happens at subscribe time, not
   * per event, which is exactly why this must be called on removal.
   */
  revokeRoom(roomId, { keepUserId } = {}) {
    let revoked = 0
    for (const connection of this.connections.values()) {
      if (!connection.rooms.has(roomId)) continue
      if (keepUserId !== undefined && connection.user.id === keepUserId) continue
      connection.rooms.delete(roomId)
      revoked += 1
      this.send(connection, makeEvent('member.changed', { roomId, reason: 'membership-ended' }))
    }
    return revoked
  }

  /** Drop every socket belonging to one user, for example after a device is revoked. */
  revokeUser(userId) {
    let closed = 0
    for (const connection of [...this.connections.values()]) {
      if (connection.user.id !== userId) continue
      try {
        connection.socket.close(4403, 'this device was revoked')
      } catch {
        // Already gone.
      }
      this.release(connection)
      closed += 1
    }
    return closed
  }

  /**
   * Send one envelope and remember it until the client acks.
   *
   * A socket whose ack backlog is full is treated as a slow consumer and closed: buffering
   * without bound would let one stalled client exhaust the Hub's memory, and that client is
   * better served by reconnecting and using the sequence-based backfill it already has.
   */
  send(connection, envelope) {
    if (connection.closed) return false
    if (connection.unacked.size >= MAX_PENDING_ACKS) {
      try {
        connection.socket.close(4408, 'too many unacknowledged events')
      } catch {
        // Already gone.
      }
      this.release(connection)
      return false
    }
    try {
      connection.socket.send(JSON.stringify(envelope))
    } catch {
      this.release(connection)
      return false
    }
    if (envelope.type !== 'ack') {
      connection.unacked.set(envelope.eventId, {
        type: envelope.type,
        roomId: envelope.roomId,
        roomSeq: envelope.roomSeq,
        sentAt: Date.now(),
      })
    }
    return true
  }

  acknowledge(connection, eventId) {
    return connection.unacked.delete(eventId)
  }

  /**
   * Fan an event out to every socket subscribed to a room.
   *
   * A socket subscribed to nothing receives nothing: the Hub does not push a room's message
   * to a member who did not ask for it, which keeps one user's traffic out of another's
   * socket even inside a shared room.
   */
  publishToRoom(roomId, envelope) {
    let delivered = 0
    for (const connection of this.connections.values()) {
      if (!connection.rooms.has(roomId)) continue
      if (this.send(connection, envelope)) delivered += 1
    }
    return delivered
  }

  publishMessage(roomId, roomSeq, message) {
    return this.publishToRoom(roomId, makeEvent('message.created', { message }, { roomId, roomSeq }))
  }

  /** Event ids a socket has been sent but not yet acknowledged, oldest first. */
  pendingFor(connection) {
    return [...connection.unacked.entries()].map(([eventId, meta]) => ({ eventId, ...meta }))
  }

  /** Close sockets that missed their heartbeat reply. */
  sweepDeadSockets() {
    for (const connection of [...this.connections.values()]) {
      if (!connection.alive) {
        try {
          connection.socket.close(4408, 'heartbeat timeout')
        } catch {
          // Already gone.
        }
        this.release(connection)
        continue
      }
      connection.alive = false
      try {
        connection.socket.ping()
      } catch {
        this.release(connection)
      }
    }
  }

  markAlive(connection) {
    connection.alive = true
  }

  get size() {
    return this.connections.size
  }
}

/**
 * Read a bearer token from the subprotocol header, the one place a browser *can* put one.
 *
 * A browser cannot set request headers on a WebSocket, so the token rides as a subprotocol
 * value `bearer.<token>`. This is a fallback for the browser surface only; the header form
 * is preferred and is what a non-browser client should use. The Hub echoes the accepted
 * protocol back, because a browser drops the connection if the server names none.
 */
function headersWithProtocolToken(headers, protocolHeader) {
  if (headers?.authorization !== undefined) return headers
  const raw = protocolHeader ?? headers?.['sec-websocket-protocol']
  if (typeof raw !== 'string') return headers
  const bearer = raw.split(',').map(value => value.trim()).find(value => value.startsWith('bearer.'))
  if (bearer === undefined) return headers
  return { ...headers, authorization: `Bearer ${bearer.slice('bearer.'.length)}` }
}

export { SCHEMA_VERSION, EventError, parseClientFrame, makeEvent, headersWithProtocolToken, HEARTBEAT_INTERVAL_MS, MAX_PENDING_ACKS }
