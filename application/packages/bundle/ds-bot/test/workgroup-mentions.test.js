import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeMessage, filterCandidates, mentionCandidates, MENTION_TRIGGER } from '../src/client/workgroup-mentions.js'

// E on the client: who can be summoned, and what a message sends because of it.
//
// The rules are worth testing away from a DOM because the failure they prevent is invisible in the UI:
// a mention derived from typed text looks identical on screen to one built from an id, and only breaks
// later — on a rename, or when somebody types a colleague's name in prose.

const MEMBERS = [
  { userId: 'u-alice', displayName: 'Alice', userHandle: 'alice' },
  { userId: 'u-bob', displayName: 'Bob', userHandle: 'bob' },
]
// The shape the Hub's `/bots/directory` and a room snapshot actually carry: `botId`, not `id`.
const BOTS = [
  { botId: 'writer', ownerUserId: 'u-bob', displayName: 'Writer' },
  { botId: 'ghost', ownerUserId: 'u-ghost', displayName: 'Ghost' },
]

test('the trigger is the character someone would type', () => {
  assert.equal(MENTION_TRIGGER, '@')
})

test('members come before Bots, because a colleague is the common case', () => {
  const candidates = mentionCandidates({ members: MEMBERS, bots: BOTS })
  assert.deepEqual(candidates.map(entry => entry.kind), ['member', 'member', 'bot'])
  assert.equal(candidates[2].botId, 'writer')
})

test('a Bot whose owner is not in the room is not offered', () => {
  // Mentioning it would propose a task to somebody who cannot see the room, so the approval could
  // never be given. The Hub refuses such an owner too; this keeps it out of the list.
  const candidates = mentionCandidates({ members: MEMBERS, bots: BOTS })
  assert.equal(candidates.some(entry => entry.botId === 'ghost'), false)
})

test('a Bot names both itself and its owner, since the owner is who approves', () => {
  const candidate = mentionCandidates({ members: MEMBERS, bots: BOTS }).find(entry => entry.botId === 'writer')
  assert.equal(candidate.userId, 'u-bob')
  assert.equal(candidate.detail, 'Bob')
})

test('an empty query offers everybody, so the trigger alone is useful', () => {
  const candidates = mentionCandidates({ members: MEMBERS, bots: BOTS })
  assert.deepEqual(filterCandidates(candidates, '').length, candidates.length)
})

test('a query matches a name, a handle, or a bot id', () => {
  const candidates = mentionCandidates({ members: MEMBERS, bots: BOTS })
  assert.deepEqual(filterCandidates(candidates, 'bob').map(entry => entry.userId), ['u-bob', 'u-bob'])
  assert.deepEqual(filterCandidates(candidates, 'alice').map(entry => entry.userId), ['u-alice'])
  assert.deepEqual(filterCandidates(candidates, 'writer').map(entry => entry.botId), ['writer'])
  assert.deepEqual(filterCandidates(candidates, 'nobody'), [])
})

test('the message keeps the typed text and sends ids, so a rename cannot change a mention', () => {
  const picked = [mentionCandidates({ members: MEMBERS, bots: BOTS }).find(entry => entry.botId === 'writer')]
  const composed = composeMessage('Writer, please draft the note', picked)
  // The text is what the sender typed — readable to everyone — while the mention is what the Hub acts
  // on. Deriving the mention from the text would make "@Writer" in prose a summons.
  assert.equal(composed.text, 'Writer, please draft the note')
  assert.deepEqual(composed.mentions, [{ userId: 'u-bob', botId: 'writer' }])
})

test('a member mention carries only the user id, never a bot id', () => {
  const composed = composeMessage('hi', [{ userId: 'u-alice', label: 'Alice', kind: 'member' }])
  assert.deepEqual(composed.mentions, [{ userId: 'u-alice' }])
})

test('a message with nobody picked carries no mentions at all', () => {
  // `undefined` would reach the Hub as "not provided"; an empty array is also fine, but leaving it out
  // keeps the request identical to one from a client that has never heard of mentions.
  assert.deepEqual(composeMessage('just text').mentions, [])
})
