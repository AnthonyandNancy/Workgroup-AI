// A workgroup's leading Bot answers an ordinary message in that room.
//
// This is the behaviour the requirement calls "the administrator answers", and it is deliberately not
// a task: the Bot is its owner's own agent, so the message goes into its Session for that room and its
// own memory, instructions and permission preset decide what happens next. What these cases pin down
// is the part that is easy to get wrong once an event stream is involved — that each message reaches
// the Bot exactly once, that only the leading machine answers, and that a message which already named
// somebody is not answered again by the leader.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/workgroup-turns.js'

// A Host stub with just the surface this module uses. `deliver` records what the turn was given and
// answers through the waiter the module registered, which is how a real Session replies.
function makeHost({ me = 'user-a', rooms = {}, bots = {} } = {}) {
  const delivered = []
  const posted = []
  const sessions = []
  const rt = {
    state: { workgroupRooms: {} },
    botOf: id => bots[id],
    hubClient: () => ({ signedIn: true, identity: { userId: me }, request: async (method, path, options) => {
      posted.push({ method, path, ...options })
      return { message: { id: `m-${posted.length}`, roomSeq: 100 + posted.length, body: options.body.body } }
    } }),
    warn: () => {},
    save: async () => {},
    ensureCapabilities: async () => {},
    createSession: async (title) => { sessions.push(title); return `sess-${sessions.length}` },
    desiredModel: async () => undefined,
    applyPermission: async () => {},
    roomWaiters: new Map(),
    groupOwners: new Map(),
    workgroupRoomState: roomId => rooms[roomId],
    deliver: async ({ sessionId, text, exchangeId, roomName }) => {
      delivered.push({ sessionId, text, exchangeId, roomName })
      // The reply a Session would produce.
      const waiter = rt.roomWaiters.get(exchangeId)
      rt.roomWaiters.delete(exchangeId)
      waiter?.resolve(`answer from ${sessionId}`)
    },
  }
  install(rt)
  return { rt, delivered, posted, sessions }
}

const LEAD_ROOM = {
  id: 'room-1',
  name: 'Finance',
  effectiveReplyMode: 'admin',
  adminBotOwnerUserId: 'user-a',
  adminBotId: 'chief',
}

test('the leading Bot answers an unmentioned message once', async () => {
  const { rt, delivered, posted } = makeHost({ rooms: { 'room-1': LEAD_ROOM }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  const first = await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-1',
    payload: { message: { id: 'm1', roomSeq: 4, senderUserId: 'user-b', senderDisplayName: 'Bob', body: 'what is our runway?' } },
  })
  assert.equal(first.answered, true)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].text, /Finance/)
  assert.match(delivered[0].text, /what is our runway\?/)
  assert.equal(delivered[0].roomName, 'Finance', 'a Hub room is not in state.rooms, so the name is passed through')

  // The answer is posted as the Bot, with a deterministic key so a retry cannot duplicate it.
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body.senderBotId, 'chief')
  assert.equal(posted[0].body.clientMessageId, 'wg-turn-room-1-chief-1')

  // The same message a second time is not answered again: the watermark advanced.
  const again = await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-1',
    payload: { message: { id: 'm1', roomSeq: 4, senderUserId: 'user-b', senderDisplayName: 'Bob', body: 'what is our runway?' } },
  })
  assert.equal(again.answered, false)
  assert.equal(delivered.length, 1)
})

test('the same Bot Session is reused for the room', async () => {
  const { rt, sessions } = makeHost({ rooms: { 'room-1': LEAD_ROOM }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  for (const roomSeq of [1, 2]) {
    await rt.onWorkgroupMessage({
      type: 'message.created', roomId: 'room-1',
      payload: { message: { id: `m${roomSeq}`, roomSeq, senderUserId: 'user-b', senderDisplayName: 'Bob', body: `line ${roomSeq}` } },
    })
  }
  assert.equal(sessions.length, 1, 'one long-lived Session per room, not one per message')
  assert.equal(sessions[0], 'Chief · Finance')
})

test('a message that names somebody is not answered by the leader', async () => {
  const { rt, delivered } = makeHost({ rooms: { 'room-1': LEAD_ROOM }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  const result = await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-1',
    payload: {
      message: {
        id: 'm1', roomSeq: 1, senderUserId: 'user-b', senderDisplayName: 'Bob', body: '@Writer please draft',
        mentions: [{ userId: 'user-b', botId: 'writer' }],
      },
    },
  })
  assert.equal(result.answered, false)
  assert.equal(delivered.length, 0)
})

test('a machine that does not own the leader stays silent', async () => {
  const { rt, delivered } = makeHost({ me: 'user-b', rooms: { 'room-1': LEAD_ROOM }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  const result = await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-1',
    payload: { message: { id: 'm1', roomSeq: 1, senderUserId: 'user-a', body: 'hello' } },
  })
  assert.equal(result.reason, 'NOT_LEADER')
  assert.equal(delivered.length, 0)
})

test('a room whose leader is gone does not answer through anyone else', async () => {
  const room = { ...LEAD_ROOM, id: 'room-2', effectiveReplyMode: 'everyone' }
  const { rt, delivered } = makeHost({ rooms: { 'room-2': room }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  const result = await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-2',
    payload: { message: { id: 'm1', roomSeq: 1, senderUserId: 'user-b', body: 'anyone?' } },
  })
  assert.equal(result.reason, 'NOT_LEADER')
  assert.equal(delivered.length, 0)
})

test('forgetting a dissolved room drops its turn state', async () => {
  const { rt } = makeHost({ rooms: { 'room-1': LEAD_ROOM }, bots: { chief: { id: 'chief', name: 'Chief' } } })
  await rt.onWorkgroupMessage({
    type: 'message.created', roomId: 'room-1',
    payload: { message: { id: 'm1', roomSeq: 3, senderUserId: 'user-b', body: 'hello' } },
  })
  assert.deepEqual(Object.keys(rt.state.workgroupRooms), ['room-1'])
  await rt.forgetWorkgroupRoom('room-1')
  assert.deepEqual(Object.keys(rt.state.workgroupRooms), [])
})
