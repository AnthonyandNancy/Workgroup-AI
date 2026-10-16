import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPresence, presenceOf } from '../src/client/workgroup-presence.js'

// A workgroup's member list has to answer "is this colleague at their desk" for the people in the
// room — and nothing else. The Hub reports presence as a boolean per member, derived from live
// connections, never from `last_seen_at`; a client that invented its own notion of "recently
// active" would disagree with the Hub about who is in the room.

test('a member the Hub reported as connected reads as online', () => {
  assert.equal(presenceOf({ userId: 'u1', online: true }), 'online')
})

test('a member without the flag, or with it false, reads as offline', () => {
  // The Hub omits `online` when it has nothing to say. Absent must not read as online: a member
  // list that assumed the best would keep showing colleagues who already left.
  assert.equal(presenceOf({ userId: 'u1', online: false }), 'offline')
  assert.equal(presenceOf({ userId: 'u1' }), 'offline')
  assert.equal(presenceOf(undefined), 'offline')
})

test('a presence event changes exactly one member and leaves the rest alone', () => {
  const members = [
    { userId: 'u1', online: true },
    { userId: 'u2', online: true },
  ]
  const next = applyPresence(members, { userId: 'u1', online: false })
  assert.deepEqual(next.map(m => m.online), [false, true])
  // A new array, so React sees a change; the untouched row keeps its identity, so only the row
  // whose state changed re-renders.
  assert.notEqual(next, members)
  assert.equal(next[1], members[1])
})

test('an event for someone not in this room is ignored', () => {
  // Presence is broadcast per room, but a member may have been removed between the event being
  // queued and being applied. Adding them back from an event would resurrect a removed member.
  const members = [{ userId: 'u1', online: false }]
  const next = applyPresence(members, { userId: 'gone', online: true })
  assert.equal(next.length, 1)
  assert.deepEqual(next.map(m => m.online), [false])
})

test('a member keeps nothing but presence from the event', () => {
  // The event carries only a boolean. A client that copied the whole payload into the member row
  // would let a server-chosen field shadow the row the Hub actually sent.
  const members = [{ userId: 'u1', userHandle: 'ravi', online: false }]
  const next = applyPresence(members, { userId: 'u1', online: true, displayName: 'not-the-real-name' })
  assert.deepEqual(next[0], { userId: 'u1', userHandle: 'ravi', online: true })
})
