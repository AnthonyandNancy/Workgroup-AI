import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY } from '../src/client/i18n.js'
import { HUB_STATUSES, hubStatusCopy, hubStatusOf } from '../src/client/workgroup-status.js'

// A workgroup is a room on a Hub, so "is the Hub there" is part of what the pane has to say. Three
// states need three different sentences, because they have three different fixes:
//
//   ready        the Hub is connected — the room is live
//   offline      reachable but the stream is down (reconnecting/closed) — wait, it is coming back
//   absent       no Hub is configured, or the Host cannot be reached — someone must act
//
// Collapsing them would be the bug this test exists for: telling an employee to ask their
// administrator to configure a Hub that is configured and merely restarting, or waiting forever
// for a Hub that was never set up.
//
// `fatal` is deliberately kept apart from the retrying states: the Bridge does not retry a fatal
// close, so presenting it as "reconnecting" would promise a recovery that will not come.

test('a connected Hub is live', () => {
  assert.equal(hubStatusOf({ phase: 'ready', configured: true, signedIn: true, state: 'open' }), 'live')
})

test('a Hub that is reconnecting or closed is offline, not absent', () => {
  for (const state of ['connecting', 'reconnecting', 'closed', 'idle']) {
    assert.equal(
      hubStatusOf({ phase: 'ready', configured: true, signedIn: true, state }),
      'offline',
      `${state} must read as a connection problem, not as a missing Hub`,
    )
  }
})

test('a refusal the Bridge will not retry is not presented as reconnecting', () => {
  assert.equal(hubStatusOf({ phase: 'ready', configured: true, signedIn: true, state: 'fatal' }), 'refused')
})

test('no Hub, no answer, and not signed in are all states a user must be told about', () => {
  // Nothing to connect to at all: the operator has to configure one.
  assert.equal(hubStatusOf({ phase: 'ready', configured: false, signedIn: false, state: 'signed-out' }), 'absent')
  // The Host itself did not answer, so whether a Hub exists is unknown rather than absent.
  assert.equal(hubStatusOf({ phase: 'unreachable', configured: false, signedIn: false, state: 'unreachable' }), 'unknown')
  // Configured and reachable, but this machine has not signed in.
  assert.equal(hubStatusOf({ phase: 'ready', configured: true, signedIn: false, state: 'signed-out' }), 'signed-out')
})

test('every status the pane can show has copy, in both languages', () => {
  const blocked = HUB_STATUSES.filter(status => status !== 'live' && status !== 'unknown')
  for (const status of blocked) {
    const copy = hubStatusCopy(status)
    assert.ok(copy !== undefined, `${status} would render as an empty panel`)
    // Read through the dictionary the client actually installs, so a sentence added here without a
    // Chinese entry fails here rather than silently falling back to English for Chinese users.
    for (const text of [copy.title, copy.body]) {
      assert.ok(Object.hasOwn(DICTIONARY.zh, text), `${status} has no Chinese entry for: ${text}`)
    }
  }
  // The pane shows the room for these, so copy for them would be dead code the tests would still
  // have to keep honest.
  assert.equal(hubStatusCopy('live'), undefined)
  assert.equal(hubStatusCopy('unknown'), undefined)
})
