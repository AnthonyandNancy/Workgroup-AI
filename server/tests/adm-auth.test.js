// ADM-01: the operator table, fixed admin login, and cookie session boundary.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyPassword } from '../src/auth/password.js'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hs256'

async function withHub(run, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-adm-auth-'))
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
    return { status: response.statusCode, body: json, headers: response.headers, raw: response.body }
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
  return { ...response, cookie: response.status === 200 ? cookieOf(response) : undefined }
}

test('migration seeds the separate admin operator, not a user', async () => {
  await withHub(async ({ db }) => {
    const operator = db.prepare("SELECT * FROM operators WHERE user_handle = 'admin'").get()
    assert.equal(operator.status, 'active')
    assert.equal(await verifyPassword('abcd1234567890', operator.password_hash), true)
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE actor_operator_id = ?").get(operator.id).n, 0)
  })
})

test('admin login creates a cookie session and logout invalidates it', async () => {
  await withHub(async ({ call }) => {
    const signedIn = await login(call)
    assert.equal(signedIn.status, 200)
    assert.equal(signedIn.body.operator.userHandle, 'admin')
    assert.equal('passwordHash' in signedIn.body.operator, false)
    assert.match(signedIn.cookie, /^hub_admin_session=/)

    const session = await call('GET', '/admin/session', undefined, { cookie: signedIn.cookie })
    assert.equal(session.status, 200)
    assert.equal(session.body.operator.userHandle, 'admin')

    const loggedOut = await call('POST', '/admin/logout', {}, { cookie: signedIn.cookie })
    assert.equal(loggedOut.status, 200)
    const after = await call('GET', '/admin/session', undefined, { cookie: signedIn.cookie })
    assert.equal(after.status, 401)
    assert.equal(after.body.error.code, 'ADMIN_UNAUTHORIZED')
  })
})

test('wrong password is refused and guest bearer tokens cannot enter admin routes', async () => {
  await withHub(async ({ call }) => {
    const wrong = await call('POST', '/admin/login', {
      userHandle: 'admin',
      password: 'wrong-password',
    })
    assert.equal(wrong.status, 401)

    const guest = await call('POST', '/auth/bootstrap', {
      installationId: '00000000-0000-4000-8000-000000000099',
      deviceLabel: 'DSH Bot',
      platform: 'web',
      appVersion: 'test',
    })
    assert.equal(guest.status, 201)
    const denied = await call('GET', '/admin/users', undefined, { bearer: guest.body.accessToken })
    assert.equal(denied.status, 401)
    assert.equal(denied.body.error.code, 'ADMIN_UNAUTHORIZED')
  }, { HUB_ANONYMOUS_BOOTSTRAP: 'true' })
})

test('serves the admin page and assets with a restrictive CSP', async () => {
  await withHub(async ({ server }) => {
    const page = await server.inject({ method: 'GET', url: '/admin/' })
    assert.equal(page.statusCode, 200)
    assert.match(page.headers['content-type'], /text\/html/)
    assert.match(page.body, /\/admin\/app\.js/)
    assert.match(page.headers['content-security-policy'], /default-src 'self'/)
    const script = await server.inject({ method: 'GET', url: '/admin/app.js' })
    assert.equal(script.statusCode, 200)
    assert.match(script.headers['content-type'], /javascript/)
    const style = await server.inject({ method: 'GET', url: '/admin/style.css' })
    assert.equal(style.statusCode, 200)
    assert.match(style.headers['content-type'], /text\/css/)
  })
})

test('repeated wrong admin passwords are throttled', async () => {
  await withHub(async ({ call }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call('POST', '/admin/login', {
        userHandle: 'admin',
        password: 'wrong-password',
      })
      assert.equal(response.status, 401)
    }
    const blocked = await call('POST', '/admin/login', {
      userHandle: 'admin',
      password: 'wrong-password',
    })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error.code, 'TOO_MANY_ATTEMPTS')
  }, { HUB_LOGIN_MAX_ATTEMPTS: '2', HUB_LOGIN_LOCKOUT_SECONDS: '10' })
})
