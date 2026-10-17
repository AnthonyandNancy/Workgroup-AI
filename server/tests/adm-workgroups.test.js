// ADM-02: operator workgroup CRUD, always scoped to kind='workgroup'.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUser } from '../src/auth/store.js'
import { hashPassword } from '../src/auth/password.js'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { sendMessage } from '../src/modules/messages/store.js'
import { createRoom } from '../src/modules/rooms/store.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hs256'

async function withHub(run, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-adm-wg-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, { cookie, bearer } = {}) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie !== undefined) headers.cookie = cookie
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`
    const response = await server.inject({
      method,
      url: `/api/v1${path}`,
      headers,
      payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, headers: response.headers }
  }
  try {
    await run({ call, db, server })
  } finally {
    await server.close()
    db.close()
  }
}

function cookieOf(response) {
  const raw = response.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value.split(';')[0]
}

async function login(call) {
  const response = await call('POST', '/admin/login', {
    userHandle: 'admin',
    password: 'abcd1234567890',
  })
  assert.equal(response.status, 200)
  return cookieOf(response)
}

async function makeUser(db, handle) {
  return createUser(db, {
    handle,
    displayName: handle,
    passwordHash: await hashPassword(`password-${handle}-long-enough`),
  })
}

test('admin workgroup listing excludes ordinary rooms', async () => {
  await withHub(async ({ call, db }) => {
    const owner = await makeUser(db, 'owner')
    const ordinary = createRoom(db, { name: 'Local room', ownerUserId: owner.id, ownerDeviceId: null, kind: 'ordinary' })
    const cookie = await login(call)

    const listed = await call('GET', '/admin/workgroups?status=all', undefined, { cookie })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.workgroups, [])

    const detail = await call('GET', `/admin/workgroups/${ordinary.id}`, undefined, { cookie })
    assert.equal(detail.status, 404)
    assert.equal(detail.body.error.code, 'NO_SUCH_WORKGROUP')

    const messages = await call('GET', `/admin/workgroups/${ordinary.id}/messages`, undefined, { cookie })
    assert.equal(messages.status, 404)
  })
})

test('admin creates, renames, manages members, reads messages, and dissolves a workgroup', async () => {
  await withHub(async ({ call, db, server }) => {
    const owner = await makeUser(db, 'owner')
    const member = await makeUser(db, 'member')
    const cookie = await login(call)
    const events = []
    server.hub.realtime.publishToRoom = (roomId, event) => events.push({ roomId, event })

    const created = await call('POST', '/admin/workgroups', { name: 'Finance', ownerUserId: owner.id }, { cookie })
    assert.equal(created.status, 201)
    assert.equal(created.body.workgroup.kind, 'workgroup')
    assert.equal(created.body.workgroup.ownerUserId, owner.id)
    const workgroupId = created.body.workgroup.id

    const users = await call('GET', '/admin/users?query=member', undefined, { cookie })
    assert.equal(users.status, 200)
    assert.equal(users.body.users.length, 1)
    assert.equal('passwordHash' in users.body.users[0], false)

    const renamed = await call('PATCH', `/admin/workgroups/${workgroupId}`, { name: 'Finance 2' }, { cookie })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.workgroup.name, 'Finance 2')
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'room.renamed' AND actor_operator_id IS NOT NULL").get().n, 1)
    assert.equal(events.at(-1).event.type, 'room.renamed')

    const added = await call('POST', `/admin/workgroups/${workgroupId}/members`, { userId: member.id }, { cookie })
    assert.equal(added.status, 201)
    assert.equal(added.body.workgroup.members.some(entry => entry.userId === member.id), true)
    assert.equal(events.at(-1).event.type, 'member.changed')

    const removed = await call('DELETE', `/admin/workgroups/${workgroupId}/members/${member.id}`, undefined, { cookie })
    assert.equal(removed.status, 200)
    const membership = db.prepare('SELECT removed_at FROM room_members WHERE room_id = ? AND user_id = ?').get(workgroupId, member.id)
    assert.notEqual(membership.removed_at, null)

    const readded = await call('POST', `/admin/workgroups/${workgroupId}/members`, { userId: member.id }, { cookie })
    assert.equal(readded.status, 201)
    const readdedRow = db.prepare('SELECT removed_at FROM room_members WHERE room_id = ? AND user_id = ?').get(workgroupId, member.id)
    assert.equal(readdedRow.removed_at, null)
    const removedAgain = await call('DELETE', `/admin/workgroups/${workgroupId}/members/${member.id}`, undefined, { cookie })
    assert.equal(removedAgain.status, 200)

    sendMessage(db, {
      roomId: workgroupId,
      senderUserId: owner.id,
      clientMessageId: 'message-0001',
      body: 'A retained message',
    })
    const messages = await call('GET', `/admin/workgroups/${workgroupId}/messages`, undefined, { cookie })
    assert.equal(messages.status, 200)
    assert.equal(messages.body.messages[0].body, 'A retained message')

    const dissolved = await call('DELETE', `/admin/workgroups/${workgroupId}`, undefined, { cookie })
    assert.equal(dissolved.status, 200)
    assert.notEqual(dissolved.body.workgroup.dissolvedAt, null)
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE room_id = ?').get(workgroupId).n, 1)
    assert.equal(events.at(-1).event.type, 'room.dissolved')

    const renameAfter = await call('PATCH', `/admin/workgroups/${workgroupId}`, { name: 'Too late' }, { cookie })
    assert.equal(renameAfter.status, 409)
    const dissolveAgain = await call('DELETE', `/admin/workgroups/${workgroupId}`, undefined, { cookie })
    assert.equal(dissolveAgain.status, 409)
  })
})

test('admin cannot remove the owner or add an existing member twice', async () => {
  await withHub(async ({ call, db }) => {
    const owner = await makeUser(db, 'owner2')
    const cookie = await login(call)
    const created = await call('POST', '/admin/workgroups', { name: 'Ops', ownerUserId: owner.id }, { cookie })
    const workgroupId = created.body.workgroup.id

    const duplicate = await call('POST', `/admin/workgroups/${workgroupId}/members`, { userId: owner.id }, { cookie })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'ALREADY_A_MEMBER')

    const removeOwner = await call('DELETE', `/admin/workgroups/${workgroupId}/members/${owner.id}`, undefined, { cookie })
    assert.equal(removeOwner.status, 409)
    assert.equal(removeOwner.body.error.code, 'CANNOT_REMOVE_OWNER')
  })
})

test('admin has no user CRUD route', async () => {
  await withHub(async ({ call }) => {
    const cookie = await login(call)
    const response = await call('POST', '/admin/users', { handle: 'new-user' }, { cookie })
    assert.equal(response.status, 404)
  })
})
