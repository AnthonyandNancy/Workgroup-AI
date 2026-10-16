// H-14 (rooms.kind): a room's kind is Hub-owned and reported back.
//
// Why this exists: the client sends `kind: 'workgroup'` when it creates a workgroup, and before
// this migration Fastify simply dropped the unknown field. The client then treated its own guess
// as fact while the Hub stored an ordinary room, so the two sides disagreed about what the room
// *is*. Everything the workgroup feature adds — member-visible presence, workgroup affordances —
// hangs off that one fact, so it belongs in the row and in the response, not in either side's
// memory.
//
// The default matters as much as the new value: every room created before this column existed,
// and every caller that does not ask for a workgroup, must stay `ordinary`. A migration that
// changed their meaning would silently convert existing Hub rooms into a different entity.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'h14-kind-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h14-kind-'))
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({
      method, url: `/api/v1${path}`, headers, payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  const person = async (handle) => {
    const password = `${handle}-password-long-enough`
    const registered = await call('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
    assert.equal(registered.status, 201, registered.raw)
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  try {
    await run({ config, db, server, call, person })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('a room created without a kind is ordinary, so existing callers keep their meaning', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.room.kind, 'ordinary')

    const row = db.prepare('SELECT kind FROM rooms WHERE id = ?').get(created.body.room.id)
    assert.equal(row.kind, 'ordinary')
  })
})

test('a room created as a workgroup stores and reports that kind', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Quarter close', kind: 'workgroup' }, alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.room.kind, 'workgroup')

    const row = db.prepare('SELECT kind FROM rooms WHERE id = ?').get(created.body.room.id)
    assert.equal(row.kind, 'workgroup')
  })
})

test('an unknown kind is refused rather than silently downgraded to ordinary', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Finance', kind: 'workspace' }, alice.token)
    assert.equal(created.status, 400, created.raw)
    assert.equal(created.body.error.code, 'INVALID_ROOM_KIND')
  })
})

test('reading a room and listing rooms both report the kind', async () => {
  await withHub(async ({ call, person }) => {
    const alice = await person('alice')
    const workgroup = await call('POST', '/rooms', { name: 'Quarter close', kind: 'workgroup' }, alice.token)
    const ordinary = await call('POST', '/rooms', { name: 'Lunch' }, alice.token)

    const detail = await call('GET', `/rooms/${workgroup.body.room.id}`, undefined, alice.token)
    assert.equal(detail.status, 200, detail.raw)
    assert.equal(detail.body.room.kind, 'workgroup')

    const listed = await call('GET', '/rooms', undefined, alice.token)
    const kinds = Object.fromEntries(listed.body.rooms.map(room => [room.id, room.kind]))
    assert.equal(kinds[workgroup.body.room.id], 'workgroup')
    assert.equal(kinds[ordinary.body.room.id], 'ordinary')
  })
})

test('the audit row for a created room records which kind it was', async () => {
  await withHub(async ({ call, person, db }) => {
    const alice = await person('alice')
    const created = await call('POST', '/rooms', { name: 'Quarter close', kind: 'workgroup' }, alice.token)
    const event = db.prepare(
      "SELECT safe_details_json FROM audit_events WHERE event_type = 'room.created' AND object_id = ?",
    ).get(created.body.room.id)
    assert.equal(JSON.parse(event.safe_details_json).kind, 'workgroup')
  })
})
