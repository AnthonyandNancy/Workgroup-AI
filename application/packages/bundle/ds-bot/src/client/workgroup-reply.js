// Quoting a message in a workgroup.
//
// A reply is a link, not a copy: the Hub stores `replyToMessageId` on the new message, and every
// reader resolves it against the message it names. Two consequences shape this module:
//
//   * The composer carries an *id*, so the preview is a convenience for the person typing and must
//     never be what is sent — sending the preview as text would quote a quote and lose the link.
//   * A reply is only as good as the message it names. If the target is no longer in the list the
//     pane holds, there is nothing to quote and nothing to link to, so the reply is dropped rather
//     than sent as a link to a message the reader cannot see.
//
// Zero dependencies, so the rules can be read and checked without a DOM.

/** How much of the quoted body is shown before it is cut, in characters. */
const PREVIEW_MAX = 140

/**
 * What the composer shows for the message being answered.
 *
 * @param message - a message from the room list: `id`, `body`, and the sender fields.
 * @returns `{ id, who, body }`, with the body shortened when it is long.
 */
export function replyPreview(message) {
  const body = String(message?.body ?? '')
  return {
    id: message?.id,
    // The name the Hub sent for the roster it answered against; a message from a member this copy
    // of the room has not named yet still quotes as a person rather than as nobody.
    who: message?.senderDisplayName || message?.senderUserId || 'Unknown',
    body: body.length > PREVIEW_MAX ? `${body.slice(0, PREVIEW_MAX)}…` : body,
  }
}

/**
 * The `view.current` value for a send, with the reply attached when one is selected.
 *
 * @param value - the pane's send value, e.g. `{ send: 'text' }`.
 * @param reply - the current reply preview, or `undefined`/`null` when not replying.
 * @returns the same value, plus `replyToMessageId` when there is a reply.
 */
export function withReply(value, reply) {
  // The mentions and attachments travel with the message whether or not it is a reply, so they are
  // spread in rather than rebuilt here: a helper that only knew about replies would drop them, and a
  // message sent as a reply would lose the person it summons and the file it carries.
  if (reply?.id === undefined || reply?.id === null) return value
  return { ...value, replyToMessageId: reply.id }
}

/**
 * The parent a reply points at, as the reader's copy of the room holds it.
 *
 * The Hub deliberately keeps no foreign key from a reply to what it answers (see migration
 * `0008_message_replies.sql`): a reply must survive the removal of its parent. So a reader resolves
 * the link when it can and shows the reply without a quote when it cannot — the alternative,
 * hiding the reply or claiming it answers nothing, would silently lose the message.
 *
 * @param message - a message from the room list, possibly carrying `replyToMessageId`.
 * @param messages - the whole list the reader holds.
 * @returns the quoted `{ id, who, body }`, the id alone when the parent is gone, or `undefined`
 *   for a message that is not a reply at all.
 */
export function replyParent(message, messages) {
  const id = message?.replyToMessageId
  if (id === undefined || id === null) return undefined
  const parent = (messages ?? []).find(candidate => candidate.id === id)
  return parent === undefined ? { id, who: undefined, body: undefined } : replyPreview(parent)
}
