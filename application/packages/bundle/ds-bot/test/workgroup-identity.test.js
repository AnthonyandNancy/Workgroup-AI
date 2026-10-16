import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { identityRows, identityText } from '../src/client/workgroup-identity.js'

// An invitation is sent by exact `userId` and there is no user search on the Hub, so a colleague
// can only be invited if they can tell you who they are. That makes showing the signed-in user
// their own identifiers a requirement rather than a convenience — without it the invite flow has
// no way to start.
//
// The values come from the Hub's own answer (`GET /auth/me`, carried in the bridge's view), never
// from anything typed, so what is displayed is what the Hub will accept as a target.

test('the rows carry the two identifiers an invitation needs', () => {
  const rows = identityRows({ userId: 'u-1', userHandle: 'ravi', displayName: 'Ravi' })
  const byKey = Object.fromEntries(rows.map(row => [row.key, row.value]))
  assert.equal(byKey.userId, 'u-1')
  assert.equal(byKey.userHandle, 'ravi')
})

test('a field the Hub has not answered for is left out rather than shown as empty', () => {
  // A blank row reads as "your ID is nothing", which is worse than no row: the reader cannot tell
  // a missing answer from an empty value.
  const rows = identityRows({ userId: 'u-1' })
  assert.deepEqual(rows.map(row => row.key), ['userId'])
  assert.deepEqual(identityRows({}), [])
  assert.deepEqual(identityRows(undefined), [])
})

test('every value is copyable as one block, in a form a colleague can use verbatim', () => {
  const text = identityText({ userId: 'u-1', userHandle: 'ravi', displayName: 'Ravi' })
  assert.match(text, /ravi/)
  assert.match(text, /u-1/)
  // Only identifiers: a display name is not unique and the Hub does not accept it as a target, so
  // copying it as if it were an identifier would produce an invitation that cannot be delivered.
  assert.doesNotMatch(text, /Ravi/)
})

test('the labels are translated, not hardcoded English in the view', () => {
  for (const row of identityRows({ userId: 'u-1', userHandle: 'ravi' })) {
    assert.ok(Object.hasOwn(DICTIONARY.zh, row.label), `no Chinese entry for: ${row.label}`)
  }
})
