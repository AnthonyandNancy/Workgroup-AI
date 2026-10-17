// Realtime event envelopes for the `wg.v1` protocol.
//
// One shape for every push, so a client parses one thing: `schemaVersion`, `eventId`,
// `type`, `issuedAt`, and a type-specific `payload`. Room-scoped events also carry `roomId`
// and `roomSeq`, which is what lets a client whose socket dropped work out exactly what it
// missed instead of re-reading everything.
//
// Events are constructed here rather than at each call site so the version string and the
// id can never drift between producers.

export const SCHEMA_VERSION = 'wg.v1'
/**
 * Every event the Hub may push.
 *
 * This list must stay a superset of `contracts/events.schema.json`'s enum: the contract is
 * the client-facing authority, and an event the contract promises but this list omits would
 * make `makeEvent` throw at the moment it is published — a 500 on the request that caused it,
 * which is what happened when the task events were first wired up.
 */
export const EVENT_TYPES = Object.freeze([
  'hello', 'ack', 'error',
  'message.created',
  'invitation.created', 'member.changed',
  // Whether a person has a live socket. Momentary by definition: it is emitted on the transitions
  // and never stored, so a restarted Hub starts with everyone offline rather than remembering a
  // connection that no longer exists.
  'presence.changed',
  'task.approval_requested', 'task.approved', 'task.cancelled',
  'task.progress', 'task.shared',
  'group_memory.changed',
  // A workgroup ended. Room-scoped and momentary like the rest, but it is the only event that
  // describes a change to the room itself rather than to something inside it.
  'room.dissolved',
  // The room's name changed. Additive in wg.v1: older clients ignore an unknown event, while a
  // client that knows it can update an open room without re-opening it.
  'room.renamed',
])

export class EventError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'EventError'
    this.code = code
  }
}

/**
 * Build one envelope.
 *
 * `requestId` echoes a client's own correlation id when it supplied one, so a client can
 * match a push to the request that caused it without guessing by content.
 */
export function makeEvent(type, payload, { roomId, roomSeq, requestId, eventId = globalThis.crypto.randomUUID(), issuedAt = new Date() } = {}) {
  if (!EVENT_TYPES.includes(type)) throw new EventError(`Unknown event type ${type}`, 'UNKNOWN_EVENT_TYPE')
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    eventId,
    type,
    issuedAt: issuedAt.toISOString(),
    payload: payload ?? {},
  }
  if (roomId !== undefined) envelope.roomId = roomId
  if (roomSeq !== undefined) envelope.roomSeq = roomSeq
  if (requestId !== undefined) envelope.requestId = requestId
  return envelope
}

/**
 * Validate a client frame.
 *
 * A client may only send `ack` and `subscribe`/`unsubscribe`. Everything else is refused
 * with a code, rather than ignored: a Hub that silently drops an unrecognized frame leaves
 * the client retrying forever with no signal.
 */
export const CLIENT_FRAME_TYPES = Object.freeze(['ack', 'subscribe', 'unsubscribe', 'ping'])

export function parseClientFrame(raw) {
  let frame
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    throw new EventError('A frame must be JSON', 'MALFORMED_FRAME')
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new EventError('A frame must be a JSON object', 'MALFORMED_FRAME')
  }
  if (frame.schemaVersion !== undefined && frame.schemaVersion !== SCHEMA_VERSION) {
    // Refusing an unknown major version at the first frame is what stops a client from
    // silently misreading every later event.
    throw new EventError(`This Hub speaks ${SCHEMA_VERSION}, not ${String(frame.schemaVersion)}`, 'UNSUPPORTED_SCHEMA_VERSION')
  }
  if (typeof frame.type !== 'string' || !CLIENT_FRAME_TYPES.includes(frame.type)) {
    throw new EventError(`A frame type must be one of ${CLIENT_FRAME_TYPES.join(', ')}`, 'UNKNOWN_FRAME_TYPE')
  }
  if (frame.type === 'ack' || frame.type === 'ping') {
    if (typeof frame.eventId !== 'string' || frame.eventId.length === 0) {
      throw new EventError('An ack needs the eventId it acknowledges', 'MISSING_EVENT_ID')
    }
  }
  if (frame.type === 'subscribe' || frame.type === 'unsubscribe') {
    if (typeof frame.roomId !== 'string' || frame.roomId.length === 0) {
      throw new EventError(`${frame.type} needs a roomId`, 'MISSING_ROOM_ID')
    }
  }
  return frame
}

export function eventInternals() {
  return { SCHEMA_VERSION, EVENT_TYPES, CLIENT_FRAME_TYPES }
}
