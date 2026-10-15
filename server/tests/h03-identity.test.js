// H-03 tests: registration, login, device identity, token lifecycle, and revocation.
//
// These run a real Fastify server against a real SQLite file and go through the real HTTP
// surface. The requirement they exist to hold is the one word in the task board: a request
// without authorization must not reach protected data, and a revoked credential must stop
// working immediately rather than when it happens to expire.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { protocolVersion } from '../src/version.js'
import { hashPassword, verifyPassword, needsRehash, assertPasswordAcceptable, parsePasswordHash, PasswordPolicyError } from '../src/auth/password.js'
import { issueAccessToken, verifyAccessToken, hashOpaqueSecret, generateRefreshToken, TokenError } from '../src/auth/tokens.js'

const SIGNING_KEY = 'test-signing-key-that-is-long-enough-for-hs256'

async function withHub(run, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h03-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    ...overrides,
  })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const at = (path) => `/api/v1${path}`
  const call = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({ method, url: at(path), headers, payload: body === undefined ? undefined : JSON.stringify(body) })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  try {
    await run({ config, db, server, call, root })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

const REGISTER = { userHandle: 'alice', displayName: 'Alice Zhang', password: 'correct-horse-battery' }
const DEVICE = { fingerprint: 'sha256:device-fingerprint-aaaa', publicKey: 'ed25519:AAAA', label: 'Alice laptop', platform: 'win32' }

async function registerAndLogin(call, user = REGISTER, device = DEVICE) {
  const registered = await call('POST', '/auth/register', user)
  assert.equal(registered.status, 201, registered.raw)
  const loggedIn = await call('POST', '/auth/login', { userHandle: user.userHandle, password: user.password, ...device })
  assert.equal(loggedIn.status, 200, loggedIn.raw)
  return { registered: registered.body.user, login: loggedIn.body }
}

// ---------------------------------------------------------------- password hashing

test('password hashing accepts the right password and rejects the wrong one', async () => {
  const stored = await hashPassword('correct-horse-battery')
  assert.equal(await verifyPassword('correct-horse-battery', stored), true)
  assert.equal(await verifyPassword('correct-horse-batterz', stored), false)
  assert.equal(await verifyPassword('', stored), false)
})

test('two hashes of the same password differ, because each has its own salt', async () => {
  const a = await hashPassword('correct-horse-battery')
  const b = await hashPassword('correct-horse-battery')
  assert.notEqual(a, b)
  assert.equal(await verifyPassword('correct-horse-battery', a), true)
  assert.equal(await verifyPassword('correct-horse-battery', b), true)
})

test('the stored hash is self-describing and carries no plaintext', async () => {
  const stored = await hashPassword('correct-horse-battery')
  assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
  assert.equal(stored.includes('correct-horse-battery'), false)
  const parsed = parsePasswordHash(stored)
  assert.equal(parsed.N, 16384)
  assert.equal(parsed.r, 8)
  assert.equal(parsed.p, 1)
})

test('a malformed or truncated hash fails closed instead of throwing', async () => {
  for (const bad of ['', 'not-a-hash', 'scrypt$16384$8$1$onlyfour', 'bcrypt$10$abc$def', 'scrypt$x$8$1$AA==$BB==', null, undefined]) {
    assert.equal(await verifyPassword('correct-horse-battery', bad), false, `expected ${String(bad)} to fail closed`)
  }
})

test('a hash made with weaker parameters is flagged for upgrade', async () => {
  const current = await hashPassword('correct-horse-battery')
  assert.equal(needsRehash(current), false)
  const weak = current.replace('$16384$', '$1024$')
  // The weak hash is still verifiable with its own parameters, which is what lets an
  // existing password keep working until its owner logs in and it is upgraded.
  assert.equal(needsRehash(weak), true)
})

test('the password policy rejects short, over-long, and whitespace-only passwords', () => {
  assert.throws(() => assertPasswordAcceptable('short'), PasswordPolicyError)
  assert.throws(() => assertPasswordAcceptable('x'.repeat(513)), PasswordPolicyError)
  assert.throws(() => assertPasswordAcceptable('          '), PasswordPolicyError)
  assert.doesNotThrow(() => assertPasswordAcceptable('correct-horse-battery'))
})

// ---------------------------------------------------------------- access tokens

test('an access token round-trips and carries the user and device it was issued to', () => {
  const token = issueAccessToken({ signingKey: SIGNING_KEY, userId: 'user-1', deviceId: 'device-1', ttlSeconds: 900 })
  const payload = verifyAccessToken(token, { signingKey: SIGNING_KEY })
  assert.equal(payload.sub, 'user-1')
  assert.equal(payload.did, 'device-1')
  assert.ok(payload.exp > payload.iat)
})

test('a token signed with another key is rejected, and the reason is not disclosed', () => {
  const token = issueAccessToken({ signingKey: 'a-completely-different-signing-key-0000', userId: 'u', deviceId: 'd', ttlSeconds: 900 })
  assert.throws(() => verifyAccessToken(token, { signingKey: SIGNING_KEY }), (error) => {
    assert.ok(error instanceof TokenError)
    assert.equal(error.code, 'BAD_SIGNATURE')
    return true
  })
})

test('tampering with the payload invalidates the token', () => {
  const token = issueAccessToken({ signingKey: SIGNING_KEY, userId: 'user-1', deviceId: 'device-1', ttlSeconds: 900 })
  const [prefix, kid, payloadPart, mac] = token.split('.')
  const forged = Buffer.from(JSON.stringify({ sub: 'attacker', did: 'device-1', iat: 1, exp: 9999999999, jti: 'x' })).toString('base64url')
  assert.throws(() => verifyAccessToken(`${prefix}.${kid}.${forged}.${mac}`, { signingKey: SIGNING_KEY }), /signature is not valid/)
  assert.notEqual(forged, payloadPart)
})

test('an expired token is rejected, and a stale clock within the skew is tolerated', () => {
  const past = new Date(Date.now() - 3600 * 1000)
  const token = issueAccessToken({ signingKey: SIGNING_KEY, userId: 'u', deviceId: 'd', ttlSeconds: 60, now: past })
  assert.throws(() => verifyAccessToken(token, { signingKey: SIGNING_KEY }), (error) => {
    assert.equal(error.code, 'TOKEN_EXPIRED')
    return true
  })
  // 10 seconds of overrun is inside the 30 second allowance, so a slightly slow server
  // clock does not lock users out.
  const recent = new Date(Date.now() - 70 * 1000)
  const slightlyStale = issueAccessToken({ signingKey: SIGNING_KEY, userId: 'u', deviceId: 'd', ttlSeconds: 60, now: recent })
  assert.equal(verifyAccessToken(slightlyStale, { signingKey: SIGNING_KEY }).sub, 'u')
})

test('a malformed or missing token is refused with a specific code', () => {
  for (const [token, code] of [[undefined, 'MISSING_TOKEN'], ['', 'MALFORMED_TOKEN'], ['a.b', 'MALFORMED_TOKEN'], ['xx.k1.y.z', 'MALFORMED_TOKEN'], ['wg1.unknown.y.z', 'UNKNOWN_KEY_ID']]) {
    assert.throws(() => verifyAccessToken(token, { signingKey: SIGNING_KEY }), (error) => {
      assert.equal(error.code, code, `expected ${code} for ${String(token)}`)
      return true
    })
  }
})

test('opaque secrets are stored as hashes, never as the value itself', () => {
  const secret = generateRefreshToken()
  const hash = hashOpaqueSecret(secret)
  assert.match(secret, /^wgref_/)
  assert.equal(hash.includes(secret), false)
  assert.match(hash, /^[0-9a-f]{64}$/)
  // Deterministic, because the Hub must find the row by hash rather than scanning.
  assert.equal(hashOpaqueSecret(secret), hash)
  assert.notEqual(hashOpaqueSecret(generateRefreshToken()), hash)
})

// ---------------------------------------------------------------- HTTP: registration

test('registration creates an account and never returns the password or its hash', async () => {
  await withHub(async ({ call, db }) => {
    const response = await call('POST', '/auth/register', REGISTER)
    assert.equal(response.status, 201, response.raw)
    assert.equal(response.body.user.userHandle, 'alice')
    assert.equal(response.body.user.displayName, 'Alice Zhang')
    assert.equal(JSON.stringify(response.body).includes('correct-horse-battery'), false)
    // The hash is in the database, and the response must not echo it.
    const row = db.prepare('SELECT password_hash FROM users WHERE user_handle = ?').get('alice')
    assert.match(row.password_hash, /^scrypt\$/)
    assert.equal(response.raw.includes(row.password_hash), false)
  })
})

test('registration refuses a duplicate handle, a bad handle, and a weak password', async () => {
  await withHub(async ({ call }) => {
    assert.equal((await call('POST', '/auth/register', REGISTER)).status, 201)
    assert.equal((await call('POST', '/auth/register', { ...REGISTER, displayName: 'Someone Else' })).status, 409)
    assert.equal((await call('POST', '/auth/register', { userHandle: 'A', displayName: 'x', password: 'correct-horse-battery' })).status, 400)
    assert.equal((await call('POST', '/auth/register', { userHandle: 'has spaces', displayName: 'x', password: 'correct-horse-battery' })).status, 400)
    const weak = await call('POST', '/auth/register', { userHandle: 'bob', displayName: 'Bob', password: 'short' })
    assert.equal(weak.status, 400)
    assert.equal(weak.body.error.code, 'PASSWORD_POLICY')
  })
})

test('the registration mode is enforced, and a wrong bootstrap secret is indistinguishable from closed', async () => {
  await withHub(async ({ call }) => {
    // open: the default for test/dev, so a developer can create the first account.
    assert.equal((await call('POST', '/auth/register', REGISTER)).status, 201)
  })

  await withHub(async ({ call }) => {
    const wrong = await call('POST', '/auth/register', { ...REGISTER, bootstrapSecret: 'the-wrong-secret' })
    const missing = await call('POST', '/auth/register', REGISTER)
    assert.equal(wrong.status, 403)
    assert.equal(missing.status, 403)
    // Identical responses: a prober learns nothing about which secret is right.
    assert.deepEqual(wrong.body, missing.body)
    const right = await call('POST', '/auth/register', { ...REGISTER, bootstrapSecret: 'the-operator-bootstrap-secret' })
    assert.equal(right.status, 201, right.raw)
  }, { HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: 'the-operator-bootstrap-secret' })

  await withHub(async ({ call }) => {
    assert.equal((await call('POST', '/auth/register', { ...REGISTER, bootstrapSecret: 'anything' })).status, 403)
  }, { HUB_REGISTRATION: 'closed' })
})

// ---------------------------------------------------------------- HTTP: login and devices

test('login issues an access token and a refresh token, and registers the device', async () => {
  await withHub(async ({ call, db }) => {
    await call('POST', '/auth/register', REGISTER)
    const login = await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password, ...DEVICE })
    assert.equal(login.status, 200, login.raw)
    assert.match(login.body.accessToken, /^wg1\.k1\./)
    assert.match(login.body.refreshToken, /^wgref_/)
    assert.equal(login.body.accessTokenExpiresIn, 900)
    assert.equal(login.body.device.fingerprint, DEVICE.fingerprint)

    // The device row exists, and the refresh token is stored only as a hash.
    const device = db.prepare('SELECT * FROM devices WHERE fingerprint = ?').get(DEVICE.fingerprint)
    assert.equal(device.label, 'Alice laptop')
    assert.equal(device.platform, 'win32')
    assert.ok(device.last_login_at !== null)
    const token = db.prepare('SELECT * FROM refresh_tokens WHERE user_id = ?').get(login.body.user.id)
    assert.equal(token.secret_hash, hashOpaqueSecret(login.body.refreshToken))
    assert.equal(JSON.stringify(token).includes(login.body.refreshToken), false)
  })
})

test('login with a wrong password or an unknown handle fails the same way', async () => {
  await withHub(async ({ call }) => {
    await call('POST', '/auth/register', REGISTER)
    const wrongPassword = await call('POST', '/auth/login', { userHandle: 'alice', password: 'not-the-password', ...DEVICE })
    const unknownHandle = await call('POST', '/auth/login', { userHandle: 'nobody', password: 'not-the-password', ...DEVICE })
    assert.equal(wrongPassword.status, 401)
    assert.equal(unknownHandle.status, 401)
    // The same code and message, so the response does not reveal which handles exist.
    assert.deepEqual(wrongPassword.body, unknownHandle.body)
  })
})

test('login requires a device fingerprint, because every credential is device-bound', async () => {
  await withHub(async ({ call }) => {
    await call('POST', '/auth/register', REGISTER)
    const response = await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'INVALID_FINGERPRINT')
  })
})

test('a second login from the same device reuses the device row rather than duplicating it', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    const again = await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password, ...DEVICE })
    assert.equal(again.body.device.id, login.device.id)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 1)
  })
})

test('a second device from the same user gets its own identity', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    const second = await call('POST', '/auth/login', {
      userHandle: 'alice', password: REGISTER.password, fingerprint: 'sha256:second-device', publicKey: 'ed25519:BBBB', label: 'Phone',
    })
    assert.notEqual(second.body.device.id, login.device.id)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 2)
  })
})

// ---------------------------------------------------------------- HTTP: authorization

test('a protected route refuses a missing, malformed, or forged token', async () => {
  await withHub(async ({ call }) => {
    await registerAndLogin(call)
    assert.equal((await call('GET', '/auth/me')).status, 401)
    assert.equal((await call('GET', '/auth/me', undefined, 'not-a-token')).status, 401)
    const forged = issueAccessToken({ signingKey: 'another-key-entirely-0000000000000000', userId: 'someone', deviceId: 'x', ttlSeconds: 900 })
    assert.equal((await call('GET', '/auth/me', undefined, forged)).status, 401)
  })
})

test('a valid token identifies the caller on a protected route', async () => {
  await withHub(async ({ call }) => {
    const { login } = await registerAndLogin(call)
    const me = await call('GET', '/auth/me', undefined, login.accessToken)
    assert.equal(me.status, 200)
    assert.equal(me.body.user.userHandle, 'alice')
    assert.equal(me.body.deviceId, login.device.id)
  })
})

test('a token whose user was deleted is refused rather than trusted', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    // Foreign keys protect the credential rows, so removing an account means removing what
    // depends on it first. The point of the case is that the token stops working, not how
    // the account was removed.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['refresh_tokens', 'devices', 'users']) db.exec(`DELETE FROM ${table}`)
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')

    const me = await call('GET', '/auth/me', undefined, login.accessToken)
    assert.equal(me.status, 401)
    assert.equal(me.body.error.code, 'UNKNOWN_USER')
  })
})

test('the schema makes it impossible to leave a device or token pointing at a deleted user', async () => {
  await withHub(async ({ call, db }) => {
    await registerAndLogin(call)
    // Deleting the user while its device exists must fail: an orphaned device would be a
    // credential with no account behind it.
    assert.throws(() => db.prepare('DELETE FROM users WHERE user_handle = ?').run('alice'), /FOREIGN KEY constraint failed/)
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM devices').get().n, 1)
  })
})

// ---------------------------------------------------------------- HTTP: refresh

test('refresh rotates the token and invalidates the one that was presented', async () => {
  await withHub(async ({ call }) => {
    const { login } = await registerAndLogin(call)
    const first = await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(first.status, 200, first.raw)
    assert.notEqual(first.body.refreshToken, login.refreshToken)
    assert.match(first.body.accessToken, /^wg1\.k1\./)

    // The original is now consumed. Presenting it again is the reuse signal, so the
    // device's credentials are withdrawn rather than a new token issued.
    const replay = await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(replay.status, 401)
    assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSED')

    // Reuse withdrew the whole device, so the rotated token is dead too. It reports
    // REVOKED rather than REUSED because revocation is checked first: the token's own
    // state is irrelevant once its device is gone. Either code denies access, which is
    // the property that matters.
    const afterReuse = await call('POST', '/auth/refresh', { refreshToken: first.body.refreshToken })
    assert.equal(afterReuse.status, 401)
    assert.equal(afterReuse.body.error.code, 'REFRESH_TOKEN_REVOKED')

    // And the device is genuinely revoked, so its access token stops working as well.
    const me = await call('GET', '/auth/me', undefined, first.body.accessToken)
    assert.equal(me.status, 403)
    assert.equal(me.body.error.code, 'DEVICE_REVOKED')
  })
})

test('refresh refuses an unknown, missing, or expired token', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    assert.equal((await call('POST', '/auth/refresh', {})).status, 400)
    assert.equal((await call('POST', '/auth/refresh', { refreshToken: 'wgref_nothing-like-a-real-token' })).status, 401)

    db.prepare('UPDATE refresh_tokens SET expires_at = ? WHERE user_id = ?').run('2000-01-01T00:00:00.000Z', login.user.id)
    const expired = await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(expired.status, 401)
    assert.equal(expired.body.error.code, 'REFRESH_TOKEN_EXPIRED')
  })
})

test('logout revokes the refresh token and is idempotent', async () => {
  await withHub(async ({ call }) => {
    const { login } = await registerAndLogin(call)
    assert.equal((await call('POST', '/auth/logout', { refreshToken: login.refreshToken })).status, 200)
    // An unknown token is reported as success, so logout cannot be used to test whether a
    // token exists.
    assert.equal((await call('POST', '/auth/logout', { refreshToken: login.refreshToken })).status, 200)
    assert.equal((await call('POST', '/auth/logout', { refreshToken: 'wgref_never-issued' })).status, 200)
    const after = await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(after.status, 401)
    assert.equal(after.body.error.code, 'REFRESH_TOKEN_REVOKED')
  })
})

// ---------------------------------------------------------------- HTTP: device revocation

test('revoking a device stops its access token immediately', async () => {
  await withHub(async ({ call }) => {
    const { login } = await registerAndLogin(call)
    assert.equal((await call('GET', '/auth/me', undefined, login.accessToken)).status, 200)
    const revoked = await call('POST', `/devices/${login.device.id}/revoke`, {}, login.accessToken)
    assert.equal(revoked.status, 200)
    assert.ok(revoked.body.device.revokedAt !== null)

    // The access token is still cryptographically valid, but its device is not, so the
    // very next request is refused. This is the property that makes short token lifetimes
    // meaningful.
    const after = await call('GET', '/auth/me', undefined, login.accessToken)
    assert.equal(after.status, 403)
    assert.equal(after.body.error.code, 'DEVICE_REVOKED')

    // And its refresh token cannot mint a new one.
    const refresh = await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })
    assert.equal(refresh.status, 401)
  })
})

test('a revoked device cannot log in again without re-registering', async () => {
  await withHub(async ({ call }) => {
    const { login } = await registerAndLogin(call)
    await call('POST', `/devices/${login.device.id}/revoke`, {}, login.accessToken)
    const retry = await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password, ...DEVICE })
    assert.equal(retry.status, 403)
    assert.equal(retry.body.error.code, 'DEVICE_REVOKED')
  })
})

test('a user cannot revoke another user\'s device', async () => {
  await withHub(async ({ call }) => {
    const alice = await registerAndLogin(call)
    const bob = await registerAndLogin(call,
      { userHandle: 'bob', displayName: 'Bob Li', password: 'bob-password-long-enough' },
      { fingerprint: 'sha256:bob-device', publicKey: 'ed25519:CCCC', label: 'Bob laptop' })

    const attempt = await call('POST', `/devices/${alice.login.device.id}/revoke`, {}, bob.login.accessToken)
    assert.equal(attempt.status, 403)
    assert.equal(attempt.body.error.code, 'NOT_YOUR_DEVICE')
    // Alice's device is untouched.
    assert.equal((await call('GET', '/auth/me', undefined, alice.login.accessToken)).status, 200)
  })
})

test('the device list shows only the caller\'s own devices', async () => {
  await withHub(async ({ call }) => {
    const alice = await registerAndLogin(call)
    await registerAndLogin(call,
      { userHandle: 'bob', displayName: 'Bob Li', password: 'bob-password-long-enough' },
      { fingerprint: 'sha256:bob-device', publicKey: 'ed25519:CCCC' })

    const list = await call('GET', '/devices', undefined, alice.login.accessToken)
    assert.equal(list.status, 200)
    assert.equal(list.body.devices.length, 1)
    assert.equal(list.body.devices[0].fingerprint, DEVICE.fingerprint)
  })
})

test('logout-all withdraws every refresh token for the user across devices', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password, fingerprint: 'sha256:second-device', publicKey: 'ed25519:DDDD' })
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL').get().n, 2)

    const response = await call('POST', '/auth/logout-all', {}, login.accessToken)
    assert.equal(response.status, 200)
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL').get().n, 0)
    // The access token keeps working until it expires: it is verified without a database
    // read, which is the documented trade of that design.
    assert.equal((await call('GET', '/auth/me', undefined, login.accessToken)).status, 200)
  })
})

test('the auth config route tells a client what to expect, without exposing secrets', async () => {
  await withHub(async ({ call }) => {
    const response = await call('GET', '/auth/config')
    assert.equal(response.status, 200)
    // `protocol` is the wire contract a client must speak. Returning the Hub's build version here
    // instead would make every client that checks it refuse a correctly configured Hub, so the
    // field is asserted rather than assumed.
    assert.equal(response.body.protocol, protocolVersion)
    assert.match(response.body.protocol, /^wg\.v\d+$/)
    assert.equal(typeof response.body.hubVersion, 'string')
    assert.notEqual(response.body.protocol, response.body.hubVersion)
    assert.equal(response.body.registrationMode, 'open')
    assert.equal(response.body.accessTokenTtlSeconds, 900)
    assert.equal(response.raw.includes(SIGNING_KEY), false)
    assert.equal(response.raw.includes('HUB_'), false)
  })
})

// ---------------------------------------------------------------- audit and data hygiene

test('identity events are recorded in the audit trail with the acting device', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    await call('POST', `/devices/${login.device.id}/revoke`, {}, login.accessToken)
    const events = db.prepare('SELECT event_type, outcome, actor_user_id, actor_device_id FROM audit_events ORDER BY occurred_at, rowid').all()
    const types = events.map(event => event.event_type)
    for (const expected of ['user.created', 'device.registered', 'device.revoked']) {
      assert.ok(types.includes(expected), `expected an audit event for ${expected}, got ${types.join(', ')}`)
    }
    assert.equal(events.every(event => event.outcome === 'success'), true)
    // No audit row may carry a credential in its detail payload.
    const details = db.prepare('SELECT safe_details_json FROM audit_events').all().map(row => row.safe_details_json).join(' ')
    assert.equal(details.includes(REGISTER.password), false)
    assert.equal(details.includes(login.refreshToken), false)
  })
})

test('no credential the Hub issued is recoverable from the database', async () => {
  await withHub(async ({ call, db, login: _unused }) => {
    const { login } = await registerAndLogin(call)
    const dump = db.prepare("SELECT type, name, sql FROM sqlite_master").all().map(row => `${row.sql ?? ''}`).join('\n')
    // Schema-level check: the access token is never stored at all.
    assert.equal(/access_token/i.test(dump), false)

    const rows = []
    for (const table of ['users', 'devices', 'refresh_tokens', 'audit_events']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) rows.push(JSON.stringify(row))
    }
    const everything = rows.join('\n')
    assert.equal(everything.includes(login.accessToken), false, 'a live access token was found in the database')
    assert.equal(everything.includes(login.refreshToken), false, 'a live refresh token was found in the database')
    assert.equal(everything.includes(REGISTER.password), false, 'a password was found in the database')
  })
})

test('a disabled account cannot authenticate and its outstanding credentials stop working', async () => {
  await withHub(async ({ call, db }) => {
    const { login } = await registerAndLogin(call)
    const { setUserStatus } = await import('../src/auth/store.js')
    setUserStatus(db, { userId: login.user.id, status: 'disabled' })

    assert.equal(db.prepare('SELECT count(*) AS n FROM devices WHERE revoked_at IS NULL').get().n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM refresh_tokens WHERE revoked_at IS NULL').get().n, 0)

    const me = await call('GET', '/auth/me', undefined, login.accessToken)
    assert.equal(me.status, 403)
    assert.equal((await call('POST', '/auth/login', { userHandle: 'alice', password: REGISTER.password, ...DEVICE })).status, 403)
    assert.equal((await call('POST', '/auth/refresh', { refreshToken: login.refreshToken })).status, 401)
  })
})
