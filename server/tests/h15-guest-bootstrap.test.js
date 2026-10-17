// H-15 tests: anonymous guest bootstrap through the real Hub HTTP surface.
//
// These tests intentionally use a real Fastify server and SQLite database. They hold the boundary
// that lets the Host obtain one local guest identity without exposing Hub credentials to renderer code.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hs256'

async function withHub(run, overrides = {}) {
  // The test runner intentionally leaves this OS-temporary directory for the environment cleanup
  // job; the test must never permanently delete a database it did not create.
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h15-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
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
    return { status: response.statusCode, body: json, headers: response.headers, raw: response.body }
  }
  try {
    await run({ call, db, server })
  } finally {
    await server.close()
    db.close()
  }
}

function bootstrapBody(overrides = {}) {
  return {
    installationId: randomUUID(),
    deviceLabel: 'DSH Bot',
    platform: 'web',
    appVersion: 'test-version',
    ...overrides,
  }
}

test('anonymous bootstrap is disabled by default and creates no identity', async () => {
  await withHub(async ({ call, db }) => {
    const response = await call('POST', '/auth/bootstrap', bootstrapBody())

    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'ANONYMOUS_BOOTSTRAP_DISABLED')
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get().n, 0)
  })
})

test('enabled anonymous bootstrap creates one redacted guest session atomically', async () => {
  await withHub(async ({ call, db }) => {
    const response = await call('POST', '/auth/bootstrap', bootstrapBody({
      userId: 'attacker-supplied-user-id',
      userHandle: 'attacker-supplied-handle',
      role: 'admin',
      permissions: ['*'],
    }))

    assert.equal(response.status, 201)
    assert.match(response.body.user.id, /^[0-9a-f-]{36}$/)
    assert.match(response.body.user.userHandle, /^guest-[0-9a-f-]{8}$/)
    assert.match(response.body.user.displayName, /^Guest /)
    assert.equal(response.body.device.label, 'DSH Bot')
    assert.equal(response.body.device.platform, 'web')
    assert.equal(typeof response.body.accessToken, 'string')
    assert.equal(typeof response.body.refreshToken, 'string')
    assert.equal(typeof response.body.accessTokenExpiresAt, 'string')
    assert.equal(typeof response.body.refreshTokenExpiresAt, 'string')
    assert.equal('passwordHash' in response.body.user, false)
    assert.equal('publicKey' in response.body.device, false)
    assert.equal('installationId' in response.body, false)
    assert.equal('role' in response.body, false)
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get().n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'user.created'").get().n, 1)
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'device.registered'").get().n, 1)
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('the bootstrap access token reaches protected Hub routes', async () => {
  await withHub(async ({ call }) => {
    const created = await call('POST', '/auth/bootstrap', bootstrapBody())
    assert.equal(created.status, 201)

    const rooms = await call('GET', '/rooms', undefined, created.body.accessToken)
    assert.equal(rooms.status, 200)
    assert.deepEqual(rooms.body, { rooms: [] })
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('bootstrap rejects malformed input and overlong labels without creating identities', async () => {
  await withHub(async ({ call, db }) => {
    const malformed = await call('POST', '/auth/bootstrap', bootstrapBody({ installationId: 'not-a-uuid' }))
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.error.code, 'INVALID_INSTALLATION_ID')
    assert.equal('accessToken' in malformed.body, false)
    assert.equal('refreshToken' in malformed.body, false)

    const overlong = await call('POST', '/auth/bootstrap', bootstrapBody({ deviceLabel: 'x'.repeat(121) }))
    assert.equal(overlong.status, 400)
    assert.equal(overlong.body.error.code, 'INVALID_DEVICE_LABEL')
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get().n, 0)
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('bootstrap limits failed attempts per source', async () => {
  await withHub(async ({ call }) => {
    const first = await call('POST', '/auth/bootstrap', bootstrapBody({ installationId: 'bad-one' }))
    const second = await call('POST', '/auth/bootstrap', bootstrapBody({ installationId: 'bad-two' }))
    const third = await call('POST', '/auth/bootstrap', bootstrapBody({ installationId: randomUUID() }))

    assert.equal(first.status, 400)
    assert.equal(second.status, 400)
    assert.equal(third.status, 429)
    assert.equal(third.body.error.code, 'TOO_MANY_ATTEMPTS')
    assert.equal('accessToken' in third.body, false)
    assert.match(third.headers['retry-after'], /^\d+$/)
  }, {
    HUB_ANONYMOUS_BOOTSTRAP: 'true',
    HUB_BOOTSTRAP_MAX_ATTEMPTS: '2',
    HUB_BOOTSTRAP_WINDOW_SECONDS: '60',
  })
})

test('revoking the bootstrap device invalidates its refresh token', async () => {
  await withHub(async ({ call }) => {
    const created = await call('POST', '/auth/bootstrap', bootstrapBody())
    assert.equal(created.status, 201)

    const revoked = await call('POST', `/devices/${created.body.device.id}/revoke`, undefined, created.body.accessToken)
    assert.equal(revoked.status, 200)
    assert.equal(revoked.body.device.revokedAt !== null, true)

    const refreshed = await call('POST', '/auth/refresh', { refreshToken: created.body.refreshToken })
    assert.equal(refreshed.status, 401)
    assert.equal(refreshed.body.error.code, 'REFRESH_TOKEN_REVOKED')
    assert.equal('accessToken' in refreshed.body, false)
    assert.equal('refreshToken' in refreshed.body, false)
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})
