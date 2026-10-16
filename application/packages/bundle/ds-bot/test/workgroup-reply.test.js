import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replyParent, replyPreview, withReply } from '../src/client/workgroup-reply.js'

// Quoting one message answers "which message" for the reader, and the Hub records that link as
// `replyToMessageId` on the new message — not as copied text. So the pane has to carry two things
// to the send: the body the user typed, and the id of the message it answers.
//
// A reply whose target has scrolled out of view is the case that breaks naive implementations: the
// preview has to come from the message the id names, and a message list that no longer holds it
// must drop the reply rather than send a link to nothing.

const message = (over = {}) => ({ id: 'm1', senderDisplayName: 'Ravi', body: 'Deploy is green', ...over })

test('a reply quotes the message it answers', () => {
  const preview = replyPreview(message())
  assert.equal(preview.id, 'm1')
  assert.equal(preview.who, 'Ravi')
  assert.equal(preview.body, 'Deploy is green')
})

test('a long quote is shortened, and the shortening is visible', () => {
  const preview = replyPreview(message({ body: 'x'.repeat(400) }))
  assert.ok(preview.body.length < 200, 'a 400-character body must not be copied into the composer')
  assert.match(preview.body, /…$/)
})

test('a message with no author name still quotes as something readable', () => {
  // The Hub sends `senderDisplayName` from the roster it was written against, but a message may
  // arrive from a member the reader's copy of the room has not named yet.
  const preview = replyPreview(message({ senderDisplayName: undefined, senderUserId: 'u-7' }))
  assert.equal(preview.who, 'u-7')
  const fallback = replyPreview(message({ senderDisplayName: undefined, senderUserId: undefined }))
  assert.notEqual(fallback.who, undefined)
})

test('sending with no reply selected omits the field instead of sending an empty id', () => {
  // The Hub validates `replyToMessageId` as an id; `undefined` means "not a reply", and `''` would
  // be a malformed id the send would be refused for.
  assert.deepEqual(withReply({ send: 'hello' }, undefined), { send: 'hello' })
  assert.deepEqual(withReply({ send: 'hello' }, null), { send: 'hello' })
})

test('sending with a reply carried the id, and only the id', () => {
  // The preview is what the user sees; the Hub needs the id. Sending the preview instead would
  // quote the text into every clone of the message and lose the link.
  const options = withReply({ send: 'yes, seen' }, { id: 'm1', who: 'Ravi', body: 'Deploy is green' })
  assert.deepEqual(options, { send: 'yes, seen', replyToMessageId: 'm1' })
})

test('a reply shows what it answers, resolved from the reader’s own copy of the room', () => {
  const messages = [message(), { id: 'm2', body: 'yes, seen', replyToMessageId: 'm1' }]
  const parent = replyParent(messages[1], messages)
  assert.equal(parent.id, 'm1')
  assert.equal(parent.who, 'Ravi')
  assert.equal(parent.body, 'Deploy is green')
})

test('a reply whose parent is gone still shows the reply', () => {
  // The Hub keeps no foreign key from a reply to its parent, so a parent can be removed while the
  // replies to it remain. Dropping the reply, or rendering it as an unrelated message, would lose
  // a message that was successfully delivered.
  const orphan = { id: 'm2', body: 'yes, seen', replyToMessageId: 'gone' }
  const parent = replyParent(orphan, [orphan])
  assert.equal(parent.id, 'gone')
  assert.equal(parent.body, undefined)
})

test('a message that answers nothing has no parent to show', () => {
  assert.equal(replyParent(message(), [message()]), undefined)
  assert.equal(replyParent(undefined, []), undefined)
})
