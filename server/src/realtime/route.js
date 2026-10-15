// The `/api/v1/realtime` WebSocket route.
//
// **Authentication happens before the handshake.** `@fastify/websocket` dispatches an
// upgrade request through the ordinary Fastify router and only then calls the route handler
// with an already-established socket. So closing the socket inside the handler refuses the
// *session*, not the connection: the handshake has already completed and the client briefly
// has a live socket. A `preValidation` hook runs before that, so a rejected client never
// reaches an open socket at all — the upgrade is answered with 401 and the TCP connection
// ends.
//
// Framing decisions a client depends on:
//
//  * The token is read from the `Authorization` header, with the subprotocol form as the
//    browser fallback. A token never travels in the query string, because URLs are logged.
//  * The Hub's first frame is `hello`, naming the schema version. A client that cannot speak
//    the version learns it before it misreads anything.
//  * The client answers `ack` per event; the Hub keeps unacked ids so a drop is detectable.
//  * A refused frame is answered with an `error` envelope carrying a code, never ignored.

import { makeEvent, parseClientFrame, EventError, SCHEMA_VERSION } from '../realtime/events.js'
import { headersWithProtocolToken } from '../realtime/hub.js'

export function registerRealtimeRoute({ fastify, hub }) {
  // The upgrade's own authentication. Attached as a route-level `preValidation` so it runs
  // before the socket handler can be reached, and so the rule is visible on the route rather
  // than hidden in a global hook whose coverage is hard to see.
  const authenticateUpgrade = async (request, reply) => {
    const protocolHeader = request.headers['sec-websocket-protocol']
    try {
      request.realtimeAuth = hub.authenticate({
        headers: headersWithProtocolToken(request.headers, protocolHeader),
      })
    } catch (error) {
      const status = error.code === 'ACCOUNT_DISABLED' || error.code === 'DEVICE_REVOKED' ? 403 : 401
      // Replying here ends the upgrade: no WebSocket is established, and the client gets the
      // same status the equivalent HTTP request would.
      return reply.code(status).send({
        error: { code: error.code ?? 'UNAUTHORIZED', message: error.message ?? 'The socket was not authenticated' },
      })
    }
    return undefined
  }

  fastify.get('/api/v1/realtime', { websocket: true, preValidation: authenticateUpgrade }, (socket, request) => {
    const protocolHeader = request.headers['sec-websocket-protocol']
    const admitted = hub.admitFor({
      socket,
      auth: request.realtimeAuth,
      headers: request.headers,
      protocolHeader,
    })
    if (!admitted.ok) {
      // `admitFor` fails on a capacity refusal or an internal one; authentication has already
      // been decided above. The close code is distinct per reason so a client — and the
      // operator reading its log — can tell "the Hub is full" from "your account is at its
      // limit", which are fixed by different people.
      const code = admitted.code === 'TOO_MANY_CONNECTIONS' || admitted.code === 'TOO_MANY_CONNECTIONS_FOR_USER' ? 4429 : 4400
      socket.close(code, admitted.code ?? 'REFUSED')
      return
    }
    const { connection } = admitted

    // A browser drops the socket unless the server names an accepted subprotocol.
    const offeredProtocol = typeof protocolHeader === 'string'
      ? protocolHeader.split(',').map(value => value.trim()).find(value => value.startsWith('bearer.'))
      : undefined
    if (offeredProtocol !== undefined) {
      try {
        socket.protocol = offeredProtocol
      } catch {
        // Not every ws implementation allows setting it after the handshake; the header
        // path does not need it at all.
      }
    }

    hub.send(connection, makeEvent('hello', {
      socketId: connection.id,
      userId: connection.user.id,
      displayName: connection.user.display_name,
      deviceId: connection.deviceId,
      serverTime: new Date().toISOString(),
      heartbeatMs: hub.heartbeatIntervalMs,
    }))

    socket.on('pong', () => { hub.markAlive(connection) })

    socket.on('message', (raw) => {
      let frame
      try {
        frame = parseClientFrame(raw)
      } catch (error) {
        const code = error instanceof EventError ? error.code : 'MALFORMED_FRAME'
        hub.send(connection, makeEvent('error', { code, message: error.message }))
        return
      }
      if (frame.type === 'ack') {
        hub.acknowledge(connection, frame.eventId)
        return
      }
      if (frame.type === 'ping') {
        hub.send(connection, makeEvent('ack', { pong: true, serverTime: new Date().toISOString() }, { requestId: frame.eventId }))
        return
      }
      if (frame.type === 'subscribe') {
        const result = hub.subscribe(connection, frame.roomId)
        if (!result.ok) {
          hub.send(connection, makeEvent('error', { code: result.code, message: 'You are not a member of that room', roomId: frame.roomId }))
          return
        }
        hub.send(connection, makeEvent('ack', { subscribed: frame.roomId, role: result.role }, { roomId: frame.roomId, requestId: frame.requestId }))
        return
      }
      if (frame.type === 'unsubscribe') {
        hub.unsubscribe(connection, frame.roomId)
        hub.send(connection, makeEvent('ack', { unsubscribed: frame.roomId }, { roomId: frame.roomId, requestId: frame.requestId }))
      }
    })

    socket.on('close', () => { hub.release(connection) })
    socket.on('error', () => { hub.release(connection) })
  })
}

export { SCHEMA_VERSION }
