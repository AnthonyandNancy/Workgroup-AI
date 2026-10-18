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
import { isBotInRoom } from '../rooms/bots.js'
import { createTask } from '../tasks/store.js'

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

/**
 * Upper bounds on the two per-message lists.
 *
 * Both are checked before anything is written, so a message cannot be an unbounded way to make the
 * Hub store work: a mention list is used to create tasks, and an attachment list is read on every
 * page load.
 */
export const MENTIONS_MAX = 20
export const ATTACHMENTS_MAX = 20

/**
 * Check and normalize the mentions a message carries.
 *
 * Each entry names a **user id**, and optionally that user's bot id. The id is what makes a mention
 * stable: a name-based mention breaks on a rename and cannot be told apart from the literal text
 * "@Writer" in ordinary prose, which would let a stray mention propose work.
 *
 * Everyone mentioned must be a member of the room. A mention naming an outsider would render as a
 * summons to somebody who cannot read the message.
 *
 * @returns the normalized array, or `undefined` when there are none (so the column stays NULL rather
 *   than holding `[]`, and a reader can tell "no mentions" from "not recorded").
 */
export function assertMentions(db, { roomId, mentions }) {
  if (mentions === undefined || mentions === null) return undefined
  if (!Array.isArray(mentions)) throw new MessageError('mentions must be a list', 'INVALID_MENTIONS')
  if (mentions.length === 0) return undefined
  if (mentions.length > MENTIONS_MAX) {
    throw new MessageError(`A message may mention at most ${MENTIONS_MAX} people`, 'INVALID_MENTIONS')
  }
  const seen = new Set()
  return mentions.map((entry) => {
    if (entry === null || typeof entry !== 'object') throw new MessageError('Each mention must name a user', 'INVALID_MENTIONS')
    const userId = entry.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new MessageError('Each mention must name a user id', 'INVALID_MENTIONS')
    }
    // Two mentions of the same person are one mention: a list that repeats an id would make the Hub
    // propose the same work twice.
    if (seen.has(userId)) throw new MessageError('A message cannot mention the same person twice', 'INVALID_MENTIONS')
    seen.add(userId)
    const membership = db.prepare('SELECT 1 AS present FROM room_members WHERE room_id = ? AND user_id = ? AND removed_at IS NULL').get(roomId, userId)
    if (membership === undefined) {
      throw new MessageError('Everyone mentioned must be a member of this workgroup.', 'MENTION_NOT_A_MEMBER')
    }
    const botId = entry.botId
    if (botId === undefined || botId === null) return { userId }
    if (typeof botId !== 'string' || botId.length === 0) {
      throw new MessageError('A Bot mention must name a bot id', 'INVALID_MENTIONS')
    }
    if (!isBotInRoom(db, { roomId, ownerUserId: userId, botId })) {
      throw new MessageError('That Bot is not a member of this workgroup', 'BOT_NOT_IN_ROOM')
    }
    return { userId, botId }
  })
}

/**
 * Check the attachments a message carries.
 *
 * Each names an artifact that already exists **in this room**. An artifact from another room is
 * refused even when the sender uploaded it: the readers here cannot read it, so the message would
 * publish its file name, its size, and a link that answers 403 to people who were not meant to know
 * the file exists.
 *
 * @returns the normalized array with file names resolved, or `undefined` when there are none.
 */
export function assertAttachments(db, { roomId, attachments }) {
  if (attachments === undefined || attachments === null) return undefined
  if (!Array.isArray(attachments)) throw new MessageError('attachments must be a list', 'INVALID_ATTACHMENTS')
  if (attachments.length === 0) return undefined
  if (attachments.length > ATTACHMENTS_MAX) {
    throw new MessageError(`A message may carry at most ${ATTACHMENTS_MAX} attachments`, 'INVALID_ATTACHMENTS')
  }
  const seen = new Set()
  return attachments.map((entry) => {
    if (entry === null || typeof entry !== 'object') throw new MessageError('Each attachment must name an artifact', 'INVALID_ATTACHMENTS')
    const artifactId = entry.artifactId
    if (typeof artifactId !== 'string' || artifactId.length === 0) {
      throw new MessageError('Each attachment must name an artifact id', 'INVALID_ATTACHMENTS')
    }
    if (seen.has(artifactId)) throw new MessageError('The same file cannot be attached twice', 'INVALID_ATTACHMENTS')
    seen.add(artifactId)
    const artifact = db.prepare('SELECT id, room_id, file_name FROM artifacts WHERE id = ?').get(artifactId)
    if (artifact === undefined || artifact.room_id !== roomId) {
      throw new MessageError('That file is not in this workgroup, so it cannot be attached here.', 'NO_SUCH_ATTACHMENT')
    }
    // The name is copied into the message rather than resolved at read time on purpose: the reader
    // gets the name the sender quoted from the message page, with no second request per file, and a
    // later rename of the artifact cannot change what the message says it carried.
    return { artifactId, fileName: artifact.file_name }
  })
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
  // Checked before the membership check, so a malformed list is a 400 whatever else is wrong.
  const mentions = assertMentions(db, { roomId, mentions: options.mentions })
  const attachments = assertAttachments(db, { roomId, attachments: options.attachments })

  // A dissolved workgroup refuses new messages. Checked here rather than in the route so every
  // writer — including a future one — meets the same rule, and so the refusal is a fact about the
  // room rather than an HTTP concern.
  const roomRow = db.prepare('SELECT dissolved_at FROM rooms WHERE id = ?').get(roomId)
  if (roomRow !== undefined && roomRow.dissolved_at !== null && roomRow.dissolved_at !== undefined) {
    throw new MessageError('This workgroup has been dissolved, so no new messages can be added to it.', 'ROOM_DISSOLVED')
  }

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
    db.prepare(`INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, reply_to_message_id, mentions_json, attachments_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, roomId, roomSeq, senderUserId, key, body, replyToMessageId ?? null,
        mentions === undefined ? null : JSON.stringify(mentions),
        attachments === undefined ? null : JSON.stringify(attachments),
        createdAt)
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
    // Omitted when absent, like every other optional field here, so a client testing for the field
    // does not have to treat null and undefined as different.
    ...(parseList(message.mentions_json) === undefined ? {} : { mentions: parseList(message.mentions_json) }),
    ...(parseList(message.attachments_json) === undefined ? {} : { attachments: parseList(message.attachments_json) }),
    createdAt: message.created_at,
  }
}

/**
 * Read one of the JSON list columns.
 *
 * A stored value that will not parse is treated as absent rather than thrown: this runs on every
 * message of every page, and one malformed row must not make a room's history unreadable. The column
 * is only ever written by `sendMessage`, so a parse failure means the file was edited by hand.
 */
function parseList(json) {
  if (json === null || json === undefined) return undefined
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export const messageInternals = { BODY_MAX, CLIENT_MESSAGE_ID_MIN, CLIENT_MESSAGE_ID_MAX, RoomError, membershipOf }

/**
 * Turn the Bot mentions of one message into tasks awaiting their owners' approval.
 *
 * This is the whole of what a remote mention does. It creates a `PENDING_APPROVAL` task per mentioned
 * Bot and returns it; it does not approve anything, mint a grant, notify the other machine, or reach
 * the Bot. The requirement is explicit — a mention of a colleague's Bot must produce a candidate and
 * leave their machine untouched — and this function is the place that could break it, so the limits
 * are worth stating:
 *
 *   * the task starts in `PENDING_APPROVAL`, which no executor will run;
 *   * `createTask` is reused rather than reimplemented, so the membership, self-task, and Bot
 *     visibility rules are the same ones a task requested from the task route gets. Two paths to the
 *     same act must not have two sets of rules;
 *   * a Bot the mentioned person does not own is refused by `createTask`'s visibility check, so a
 *     mention cannot name a Bot into existence;
 *   * the description is the message body, so the approver sees what was actually asked.
 *
 * A refused proposal propagates. Storing the message and dropping the task silently would leave the
 * sender believing they had asked, and the mention is the message's stated purpose.
 *
 * @returns the created task rows, in mention order.
 */
export function proposeTasksForMentions(db, { roomId, requesterUserId, requesterDeviceId, message, text, now = new Date() }) {
  const mentions = parseList(message?.mentions_json) ?? []
  const proposals = []
  for (const mention of mentions) {
    if (mention.botId === undefined) continue
    proposals.push(createTask(db, {
      roomId,
      requesterUserId,
      requesterDeviceId,
      ownerUserId: mention.userId,
      targetBotId: mention.botId,
      description: text,
      now,
    }))
  }
  return proposals
}
