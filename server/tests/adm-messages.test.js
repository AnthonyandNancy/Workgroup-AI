// ADM-02: operator message reading is workgroup-only, paginated, and audited.

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
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-adm-msg-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, { cookie } = {}) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (cookie !== undefined) headers.cookie = cookie
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
  const response = await call('POST', '/admin/login', { userHandle: 'admin', password: 'abcd1234567890' })
  assert.equal(response.status, 200)
  return cookieOf(response)
}

async function owner(db) {
  return createUser(db, {
    handle: 'message-owner',
    displayName: 'Message Owner',
    passwordHash: await hashPassword('message-owner-password'),
  })
}

test('message bodies paginate without duplicates and are audited without their content', async () => {
  await withHub(async ({ call, db }) => {
    const user = await owner(db)
    const cookie = await login(call)
    const created = await call('POST', '/admin/workgroups', { name: 'Messages', ownerUserId: user.id }, { cookie })
    const workgroupId = created.body.workgroup.id

    for (let index = 1; index <= 3; index += 1) {
      sendMessage(db, {
        roomId: workgroupId,
        senderUserId: user.id,
        clientMessageId: `message-${String(index).padStart(4, '0')}`,
        body: `body-${index}`,
      })
    }

    const first = await call('GET', `/admin/workgroups/${workgroupId}/messages?limit=2`, undefined, { cookie })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.messages.map(message => message.body), ['body-3', 'body-2'])
    assert.equal(first.body.hasMore, true)
    assert.equal(first.body.nextBeforeSeq, 2)

    const second = await call('GET', `/admin/workgroups/${workgroupId}/messages?limit=2&beforeSeq=2`, undefined, { cookie })
    assert.equal(second.status, 200)
    assert.deepEqual(second.body.messages.map(message => message.body), ['body-1'])
    assert.equal(second.body.hasMore, false)
    assert.equal(second.body.nextBeforeSeq, 1)

    const audit = db.prepare("SELECT safe_details_json FROM audit_events WHERE event_type = 'admin.workgroup_messages_viewed'").all()
    assert.equal(audit.length, 2)
    assert.equal(audit.some(row => row.safe_details_json.includes('body-')), false)
  })
})

test('ordinary room messages are refused even though the room id exists', async () => {
  await withHub(async ({ call, db }) => {
    const user = await owner(db)
    const ordinary = createRoom(db, { name: 'Ordinary', ownerUserId: user.id, ownerDeviceId: null, kind: 'ordinary' })
    const cookie = await login(call)
    const response = await call('GET', `/admin/workgroups/${ordinary.id}/messages`, undefined, { cookie })
    assert.equal(response.status, 404)
    assert.equal(response.body.error.code, 'NO_SUCH_WORKGROUP')
  })
})
