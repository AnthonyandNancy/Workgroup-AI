// Reactions on room messages.
//
// The original group chat keeps reactions in the reader's own `localStorage`, which satisfies "I can
// mark this" but cannot satisfy "every member sees the same reactions". A workgroup's members are on
// different machines, so the fact has to live on the Hub — and once it does, "who reacted" becomes a
// real question with a real answer, which is what makes "only the author may withdraw" checkable
// rather than a client-side courtesy.
//
// One row per (message, person, emoji). That shape does three things at once: a repeated reaction is
// idempotent without a read-then-write, the set of reactions on a message is one indexed read, and
// withdrawing is a delete of the caller's own row rather than an edit of somebody else's.

import { MessageError } from './store.js'

/**
 * The reactions a member may use.
 *
 * A closed set rather than any string: the emoji is stored verbatim and re-published to every member,
 * so an open field would be an unvalidated value travelling through the room. The set is deliberately
 * small — reactions are a quick acknowledgement, not a second message channel.
 */
export const REACTION_EMOJI = Object.freeze(['👍', '❤️', '😂', '🎉', '👀', '🙏'])

/**
 * The reactions on a set of messages, keyed by message id.
 *
 * Read in one query for a whole page: a conversation renders all its reactions at once, and a query
 * per message would turn one page into one round trip per line.
 *
 * @param {object} db
 * @param {string[]} messageIds the messages whose reactions are wanted.
 * @returns {Map<string, { emoji: string, userIds: string[] }[]>} each message's reactions, in emoji
 *   order, each carrying the people who chose it.
 */
export function reactionsFor(db, messageIds) {
  const wanted = [...new Set((messageIds ?? []).filter(id => typeof id === 'string' && id !== ''))]
  const byMessage = new Map()
  if (wanted.length === 0) return byMessage
  const rows = db.prepare(`SELECT message_id, emoji, user_id FROM message_reactions
    WHERE message_id IN (${wanted.map(() => '?').join(',')})
    ORDER BY created_at, user_id`).all(...wanted)
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? []
    const existing = list.find(entry => entry.emoji === row.emoji)
    if (existing === undefined) list.push({ emoji: row.emoji, userIds: [row.user_id] })
    else existing.userIds.push(row.user_id)
    byMessage.set(row.message_id, list)
  }
  // A stable order so two readers drawing the same message draw the same sequence.
  for (const list of byMessage.values()) list.sort((left, right) => REACTION_EMOJI.indexOf(left.emoji) - REACTION_EMOJI.indexOf(right.emoji))
  return byMessage
}

function assertEmoji(emoji) {
  if (!REACTION_EMOJI.includes(emoji)) {
    throw new MessageError(`A reaction must be one of ${REACTION_EMOJI.join(' ')}`, 'INVALID_EMOJI')
  }
  return emoji
}

/** The message, if this caller may see it: it must be in this room. */
function requireRoomMessage(db, { roomId, messageId }) {
  const row = db.prepare('SELECT id, room_id FROM messages WHERE id = ?').get(messageId)
  if (row === undefined || row.room_id !== roomId) {
    // A message in another room is answered exactly like one that does not exist, so a guessed id
    // cannot confirm that a conversation the caller is not in has a message with that id.
    throw new MessageError('No such message', 'NO_SUCH_MESSAGE')
  }
  return row
}

/**
 * Add one reaction from one person to one message.
 *
 * Idempotent: the primary key makes a repeat a no-op, so a client that retried after a dropped
 * response does not have to know whether the first attempt landed.
 *
 * @returns {{ messageId: string, reactions: object[] }} the message's reactions after the change, so
 *   the caller can publish and return the same set.
 */
export function addReaction(db, { roomId, messageId, userId, emoji, now = new Date() }) {
  const wanted = assertEmoji(emoji)
  requireRoomMessage(db, { roomId, messageId })
  db.prepare(`INSERT INTO message_reactions (room_id, message_id, user_id, emoji, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id, user_id, emoji) DO NOTHING`)
    .run(roomId, messageId, userId, wanted, now.toISOString())
  return { messageId, reactions: reactionsFor(db, [messageId]).get(messageId) ?? [] }
}

/**
 * Withdraw one's own reaction.
 *
 * Only the caller's own row is deleted. Withdrawing somebody else's is not "not found" and not a
 * silent success: it leaves their reaction exactly as it was, because a member withdrawing a
 * colleague's reaction would be editing another person's statement.
 *
 * @returns {{ messageId: string, reactions: object[] }} the message's reactions after the change.
 */
export function removeReaction(db, { roomId, messageId, userId, emoji }) {
  const wanted = assertEmoji(emoji)
  requireRoomMessage(db, { roomId, messageId })
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .run(messageId, userId, wanted)
  return { messageId, reactions: reactionsFor(db, [messageId]).get(messageId) ?? [] }
}
