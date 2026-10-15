// Hub messages: one ordered log per room, idempotent on the client's own key.
//
// The design problem this module solves is that a client cannot know whether a send
// succeeded when the response is lost. So the client supplies a `clientMessageId` and the
// Hub guarantees:
//
//   * the same key from the same sender in the same room writes exactly one message, and a
//     retry returns the original rather than a second copy;
//   * every message gets a room-scoped sequence number that only ever moves forward, so a
//     client that reconnects can ask for everything after the last one it saw and receive
//     exactly the gap, in order, with no duplicates.
//
// The sequence number is allocated inside the same transaction that inserts the row. Two
// concurrent senders therefore cannot receive the same number: the second waits on the
// write lock and reads the already-incremented `next_seq`. `rooms.next_seq` is the single
// allocator, not a client-supplied value and not `max(room_seq) + 1` — the latter would
// reuse a number after a deletion and silently corrupt a client's gap detection.

import { randomUUID } from 'node:crypto'
import { RoomError, requireMember, membershipOf } from '../rooms/store.js'

export class MessageError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MessageError'
    this.code = code
  }
}

const BODY_MAX = 50_000
const CLIENT_MESSAGE_ID_MIN = 8
const CLIENT_MESSAGE_ID_MAX = 96
/** Upper bound on one backfill page, so a client cannot ask for an unbounded response. */
export const MESSAGE_PAGE_MAX = 500

export function assertMessageBody(body) {
  if (typeof body !== 'string') throw new MessageError('A message body must be a string', 'INVALID_MESSAGE_BODY')
  const value = body.trim()
  if (value.length === 0) throw new MessageError('A message body must not be empty', 'INVALID_MESSAGE_BODY')
  if (body.length > BODY_MAX) throw new MessageError(`A message body must be at most ${BODY_MAX} characters`, 'INVALID_MESSAGE_BODY')
  return value
}

export function assertClientMessageId(id) {
  if (typeof id !== 'string') throw new MessageError('A clientMessageId is required', 'INVALID_CLIENT_MESSAGE_ID')
  if (id.length < CLIENT_MESSAGE_ID_MIN || id.length > CLIENT_MESSAGE_ID_MAX) {
    throw new MessageError(`A clientMessageId must be ${CLIENT_MESSAGE_ID_MIN}-${CLIENT_MESSAGE_ID_MAX} characters`, 'INVALID_CLIENT_MESSAGE_ID')
  }
  return id
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), now.toISOString())
}

// ---------------------------------------------------------------- sending

/**
 * Append a message to a room.
 *
 * Returns `{ message, duplicate }`. `duplicate: true` means this exact key was already
 * accepted and the returned row is the original — the caller answers 200 rather than 201,
 * and no second sequence number was consumed.
 *
 * A reply names the message it answers. The reference is checked against *this room* before the
 * write: a reply that pointed at another room's message would leak the existence of a room the
 * sender may not be in, and quoting it back would leak its content.
 *
 * @param {object} db
 * @param {{ roomId: string, senderUserId: string, senderDeviceId?: string, clientMessageId: string, body: string, replyToMessageId?: string, now?: Date }} options
 */
export function sendMessage(db, options) {
  const { roomId, senderUserId, senderDeviceId, clientMessageId, now = new Date() } = options
  const body = assertMessageBody(options.body)
  const key = assertClientMessageId(clientMessageId)
  const replyToMessageId = assertReplyTarget(db, { roomId, replyToMessageId: options.replyToMessageId })

  // The membership check happens before the transaction so a non-member cannot take the
  // write lock for a room they cannot post to.
  requireMember(db, { roomId, userId: senderUserId })

  const existing = db.prepare(`SELECT * FROM messages
    WHERE room_id = ? AND sender_user_id = ? AND client_message_id = ?`).get(roomId, senderUserId, key)
  if (existing !== undefined) return { message: existing, duplicate: true }

  const id = randomUUID()
  const createdAt = now.toISOString()
  db.exec('BEGIN IMMEDIATE')
  let row
  try {
    // Allocation and insert share the transaction with the sequence bump, so a crash
    // cannot leave `next_seq` advanced past a message that was never written.
    const room = db.prepare('SELECT next_seq FROM rooms WHERE id = ?').get(roomId)
    if (room === undefined) throw new MessageError('No such room', 'NO_SUCH_ROOM')
    const roomSeq = room.next_seq
    db.prepare('UPDATE rooms SET next_seq = ? WHERE id = ?').run(roomSeq + 1, roomId)
    db.prepare(`INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, reply_to_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roomId, roomSeq, senderUserId, key, body, replyToMessageId ?? null, createdAt)
    audit(db, { actorUserId: senderUserId, actorDeviceId: senderDeviceId, eventType: 'message.created', objectType: 'message', objectId: id, outcome: 'success', details: { roomId, roomSeq }, now })
    db.exec('COMMIT')
    row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    // Two senders racing with the same key: the loser reads the winner's row instead of
    // failing, which keeps the retry semantics the same as a sequential retry.
    if (/UNIQUE constraint failed: messages\.room_id, messages\.sender_user_id, messages\.client_message_id/.test(error.message)) {
      const winner = db.prepare(`SELECT * FROM messages
        WHERE room_id = ? AND sender_user_id = ? AND client_message_id = ?`).get(roomId, senderUserId, key)
      if (winner !== undefined) return { message: winner, duplicate: true }
    }
    throw error
  }
  return { message: row, duplicate: false }
}

/**
 * Resolve and check a reply's target.
 *
 * Returns the id to store, or `undefined` when this is not a reply. A target in another room is
 * refused with the same error a missing target gets, so a caller cannot use the reply field to
 * probe whether a message id exists somewhere they cannot read.
 */
function assertReplyTarget(db, { roomId, replyToMessageId }) {
  if (replyToMessageId === undefined || replyToMessageId === null) return undefined
  if (typeof replyToMessageId !== 'string' || replyToMessageId.length === 0) {
    throw new MessageError('A reply target must be a message id', 'INVALID_REPLY_TARGET')
  }
  const row = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(replyToMessageId)
  if (row === undefined || row.room_id !== roomId) {
    throw new MessageError('There is no message in this room to reply to', 'NO_SUCH_REPLY_TARGET')
  }
  return replyToMessageId
}

// ---------------------------------------------------------------- reading

/**
 * Read one page of a room's history.
 *
 * `afterSeq` is the reconnect path: a client sends the highest sequence it has seen and
 * receives everything later, ordered. `limit` is bounded so one request cannot pull an
 * entire room into memory.
 */
export function readMessages(db, { roomId, userId, afterSeq = 0, limit = MESSAGE_PAGE_MAX }) {
  requireMember(db, { roomId, userId })
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new MessageError('afterSeq must be a non-negative integer', 'INVALID_CURSOR')
  const pageSize = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), MESSAGE_PAGE_MAX) : MESSAGE_PAGE_MAX
  const rows = db.prepare(`SELECT * FROM messages WHERE room_id = ? AND room_seq > ? ORDER BY room_seq LIMIT ?`)
    .all(roomId, afterSeq, pageSize)
  const last = rows.length > 0 ? rows[rows.length - 1].room_seq : afterSeq
  // `nextAfterSeq` is what the client should send next; it equals the highest sequence in
  // this page, so a client that keeps it cannot skip a message even across an empty page.
  return { messages: rows, nextAfterSeq: last, hasMore: rows.length === pageSize }
}

/** The room's current high-water sequence, for a client starting fresh. */
export function latestSeq(db, { roomId, userId }) {
  requireMember(db, { roomId, userId })
  const row = db.prepare('SELECT next_seq FROM rooms WHERE id = ?').get(roomId)
  return { latestSeq: row === undefined ? 0 : row.next_seq - 1 }
}

/** Count of messages a member can read; used by tests and diagnostics, never by a route. */
export function messageCount(db, { roomId, userId }) {
  requireMember(db, { roomId, userId })
  return db.prepare('SELECT count(*) AS n FROM messages WHERE room_id = ?').get(roomId).n
}

export function findMessage(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
}

/** A member's view of a message, with the sender's display name attached. */
export function publicMessage(message) {
  return {
    id: message.id,
    roomId: message.room_id,
    roomSeq: message.room_seq,
    senderUserId: message.sender_user_id,
    ...(message.sender_display_name === undefined ? {} : { senderDisplayName: message.sender_display_name }),
    clientMessageId: message.client_message_id,
    body: message.body,
    // Only present on a reply, so a reader can tell a reply from a message that happens to follow
    // one. Omitted rather than null: an absent field is what every other optional shape in this API
    // does, and a client testing for `replyToMessageId` should not have to distinguish null.
    ...(message.reply_to_message_id === undefined || message.reply_to_message_id === null
      ? {}
      : { replyToMessageId: message.reply_to_message_id }),
    createdAt: message.created_at,
  }
}

export const messageInternals = { BODY_MAX, CLIENT_MESSAGE_ID_MIN, CLIENT_MESSAGE_ID_MAX, RoomError, membershipOf }
