import assert from 'node:assert/strict'
import { test } from 'node:test'
import { enterWorkgroup } from '../src/client/workgroup-entry.js'

// Entering a workgroup is not one action but two, and the order is the whole point.
//
// The pane renders from a Session, and the shell refuses to show a Session it has never heard
// of: `sessions.retain` throws `unknown session` for an id that is in neither the live registry
// nor the catalog. `wg:<roomId>` is exactly that id — it belongs to a room the *Hub* owns, so
// nothing on this machine has ever created it. Navigating first therefore fails, and the failure
// is a thrown error inside navigation rather than a visible empty view.
//
// So the entry creates the Session first and navigates second. These cases pin that order, the
// id that is created, and the fact that a failed create is reported instead of navigating into a
// Session that cannot exist.

/** A client-shaped `sessions` service that records what it was asked to create. */
function fakeSessions({ existing = [], fail } = {}) {
  const created = []
  const byId = Object.fromEntries(existing.map(id => [id, { sessionId: id, blank: true }]))
  return {
    created,
    list: { getSnapshot: () => ({ byId, ids: Object.keys(byId) }) },
    create: async (options) => {
      if (fail !== undefined) throw fail
      created.push(options)
      return options.sessionId
    },
  }
}

test('a workgroup Session exists before the pane navigates to it', async () => {
  const sessions = fakeSessions()
  const order = []
  const opened = []
  const watched = []
  const entered = await enterWorkgroup({
    roomId: 'r1',
    sessions: {
      list: sessions.list,
      create: async (options) => { order.push('create'); return sessions.create(options) },
    },
    openSession: (id) => { order.push('open'); opened.push(id) },
    watch: async (roomId) => { watched.push(roomId) },
  })

  assert.equal(entered, 'wg:r1')
  assert.deepEqual(sessions.created, [{ sessionId: 'wg:r1' }])
  assert.deepEqual(opened, ['wg:r1'])
  assert.deepEqual(order, ['create', 'open'])
  assert.deepEqual(watched, ['r1'])
})

test('an already-known workgroup Session is opened without being created again', async () => {
  const sessions = fakeSessions({ existing: ['wg:r1'] })
  const opened = []
  await enterWorkgroup({
    roomId: 'r1',
    sessions,
    openSession: id => opened.push(id),
    watch: async () => {},
  })

  assert.deepEqual(sessions.created, [], 'a second entry costs no Host round trip')
  assert.deepEqual(opened, ['wg:r1'])
})

test('a create the Host refuses is reported, and nothing navigates into it', async () => {
  const refusal = new Error('the team is read-only')
  const reported = []
  const opened = []
  const entered = await enterWorkgroup({
    roomId: 'r2',
    sessions: fakeSessions({ fail: refusal }),
    openSession: id => opened.push(id),
    report: error => reported.push(error),
  })

  assert.equal(entered, undefined)
  assert.deepEqual(reported, [refusal])
  assert.deepEqual(opened, [], 'navigating would throw the same reason a second time')
})

test('the overlay the user came from is dismissed once the room is entered', async () => {
  const sessions = fakeSessions()
  const closed = []
  await enterWorkgroup({
    roomId: 'r3',
    sessions,
    openSession: () => {},
    closeOverlay: () => closed.push(true),
  })

  assert.deepEqual(closed, [true])
})
