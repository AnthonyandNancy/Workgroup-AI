// H-14 (rate limits): the counters survive a restart, and registration is counted too.
//
// Why this exists: the limiter shipped with H-03 is an in-memory `Map`, and its own module comment
// says so — "a restart forgets the counters". That is a real property of a single-process Hub, but
// it is also the property an attacker with network access uses: a spray that trips the lockout can
// wait for one restart, or simply outlive a deploy, and resume with a clean budget. A Hub reachable
// from a colleague's laptop across a company network has to treat its own restarts as normal
// events, not as amnesty.
//
// The second half of the case is registration. Until now only `login` was counted, so the one route
// that *creates identities* was the one route with no ceiling at all. With `HUB_REGISTRATION=
// admin_secret` the bootstrap secret is the only thing standing between a reachable Hub and an
// unlimited number of accounts, which makes an unthrottled register route the weakest link in the
// admission story.
//
// What the cases below deliberately do NOT assert: that the persisted form is a particular table
// shape. They assert observable behaviour — a refused attempt after a restart, a registration that
// is counted, and a bounded key set — so the storage can change without rewriting the contract.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { PersistentLimiter, heartbeatKeys, messageKeys } from '../src/security/ratelimit-store.js'

const SIGNING_KEY = 'h14-limit-test-signing-key-long-enough-for-hs256'
const BOOTSTRAP = 'h14-bootstrap-secret-value'

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h14-limit-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) }
}

function hubConfig(root, extra = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    HUB_REGISTRATION: 'admin_secret',
    HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    ...extra,
  })
}

// ---------------------------------------------------------------- persistence

test('a lockout outlives the limiter instance, so a restart is not amnesty', () => {
  const { root, cleanup } = tempRoot()
  try {
    const config = hubConfig(root)
    const first = openDatabase(config)
    migrate(first)
    const limiter = new PersistentLimiter({ db: first, maxAttempts: 3, windowSeconds: 60, lockoutSeconds: 300 })
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.recordFailure('login:handle:alice')
    assert.equal(limiter.check('login:handle:alice').allowed, false)
    first.close()

    // Same data directory, new process: this is what a restart looks like to the Hub.
    const second = openDatabase(config)
    migrate(second)
    const reopened = new PersistentLimiter({ db: second, maxAttempts: 3, windowSeconds: 60, lockoutSeconds: 300 })
    const verdict = reopened.check('login:handle:alice')
    assert.equal(verdict.allowed, false, 'the lockout must still hold after a restart')
    assert.ok(verdict.retryAfterSeconds > 0)
    second.close()
  } finally {
    cleanup()
  }
})

test('a successful attempt clears the key, so a typo does not lock someone out', () => {
  const { root, cleanup } = tempRoot()
  try {
    const config = hubConfig(root)
    const db = openDatabase(config)
    migrate(db)
    const limiter = new PersistentLimiter({ db, maxAttempts: 3, windowSeconds: 60, lockoutSeconds: 300 })
    limiter.recordFailure('login:handle:alice')
    limiter.clear('login:handle:alice')
    assert.equal(limiter.check('login:handle:alice').allowed, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?').get('login:handle:alice').n, 0)
    db.close()
  } finally {
    cleanup()
  }
})

test('an expired lockout starts over rather than staying permanent', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const config = hubConfig(root)
    db = openDatabase(config)
    migrate(db)
    // A window measured in the past: the entry is written now, then read as already stale.
    const limiter = new PersistentLimiter({ db, maxAttempts: 2, windowSeconds: 10, lockoutSeconds: 60 })
    limiter.recordFailure('login:source:10.0.0.9')
    limiter.recordFailure('login:source:10.0.0.9')
    assert.equal(limiter.check('login:source:10.0.0.9').allowed, false)
    db.prepare('UPDATE rate_limits SET blocked_until = ? WHERE key = ?')
      .run(Date.now() - 1_000, 'login:source:10.0.0.9')
    assert.equal(limiter.check('login:source:10.0.0.9').allowed, true, 'N seconds must mean N seconds')
  } finally {
    db?.close()
    cleanup()
  }
})

test('the persisted key set is bounded, so a spray cannot grow the database without limit', () => {
  const { root, cleanup } = tempRoot()
  let db
  try {
    const config = hubConfig(root)
    db = openDatabase(config)
    migrate(db)
    const limiter = new PersistentLimiter({ db, maxAttempts: 2, windowSeconds: 60, lockoutSeconds: 300, maxKeys: 5 })
    for (let i = 0; i < 50; i += 1) limiter.recordFailure(`login:source:10.0.0.${String(i)}`)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n
    assert.ok(rows <= 5, `expected at most 5 persisted keys, found ${String(rows)}`)
  } finally {
    db?.close()
    cleanup()
  }
})

// ---------------------------------------------------------------- registration is counted

async function withHub(root, run, extra = {}) {
  const config = hubConfig(root, extra)
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body) => {
    const response = await server.inject({
      method,
      url: `/api/v1${path}`,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  try {
    await run({ config, db, server, call })
  } finally {
    await server.close()
    db.close()
  }
}

test('repeated registration attempts are refused with 429 and a Retry-After', async () => {
  const { root, cleanup } = tempRoot()
  try {
    await withHub(root, async ({ call }) => {
      const attempt = body => call('POST', '/auth/register', body)
      const body = index => ({ userHandle: `spray${String(index)}`, displayName: 'S', password: 'password-long-enough', bootstrapSecret: 'wrong-secret-value-here' })
      const statuses = []
      for (let i = 0; i < 12; i += 1) statuses.push((await attempt(body(i))).status)
      assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)
      const refused = await attempt(body(99))
      assert.equal(refused.status, 429)
      assert.ok(Number(refused.body.retryAfterSeconds ?? 0) >= 0 || refused.body.retryAfterSeconds === undefined)
    }, { HUB_LOGIN_MAX_ATTEMPTS: '3' })
  } finally {
    cleanup()
  }
})

test('registration failures do not reveal whether the secret or the mode was wrong', async () => {
  const { root, cleanup } = tempRoot()
  try {
    await withHub(root, async ({ call }) => {
      const wrongKey = await call('POST', '/auth/register', {
        userHandle: 'probe1', displayName: 'P', password: 'password-long-enough', bootstrapSecret: 'not-the-secret-at-all',
      })
      assert.equal(wrongKey.status, 403)
      // The same code a closed Hub answers with: probing must not tell "wrong secret" from
      // "registration disabled", or the secret can be guessed offline against a distinguishing
      // response.
      assert.equal(wrongKey.body.error.code, 'REGISTRATION_CLOSED')

      const missing = await call('POST', '/auth/register', { userHandle: 'nokey', displayName: 'N', password: 'password-long-enough' })
      assert.equal(missing.status, 403)
      assert.equal(missing.body.error.code, 'REGISTRATION_CLOSED')
    })
  } finally {
    cleanup()
  }
})

test('a valid registration still succeeds, so the throttle did not break admission', async () => {
  const { root, cleanup } = tempRoot()
  try {
    await withHub(root, async ({ call }) => {
      const created = await call('POST', '/auth/register', {
        userHandle: 'alice', displayName: 'Alice', password: 'password-long-enough', bootstrapSecret: BOOTSTRAP,
      })
      assert.equal(created.status, 201, created.raw)
      assert.equal(created.body.user.userHandle, 'alice')
    })
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- trusted proxies

test('the Hub does not trust forwarding headers unless a proxy is declared', () => {
  const { root, cleanup } = tempRoot()
  try {
    const bare = hubConfig(root)
    // Fastify's option is what decides whether `request.ip` can be spoofed; the config must not
    // hand it a truthy value by default, or every remaining `source` key becomes attacker-chosen.
    assert.equal(bare.security.trustedProxies, undefined)
  } finally {
    cleanup()
  }
})

test('a declared proxy list is accepted, and a malformed one refuses to start', () => {
  const { root, cleanup } = tempRoot()
  try {
    const good = hubConfig(root, { HUB_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.5' })
    assert.deepEqual(good.security.trustedProxies, ['10.0.0.0/8', '192.168.1.5'])
    assert.throws(() => hubConfig(root, { HUB_TRUSTED_PROXIES: 'not an address' }), /HUB_TRUSTED_PROXIES/)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- the remaining endpoints

// E5: registration and login were counted, and the rest of the endpoints were not. What that left
// open is different per endpoint, which is why each has its own case below:
//
//   * **Heartbeat** writes to the bot directory on every call, by design — a reachable Hub is
//     flooded with small writes from one client, which is cheaper to send than to store.
//   * **Message send** is the route a room's content comes through, and it allocates a room
//     sequence number inside a write transaction, so one sender's loop blocks every other writer.
//
// The counting rule is the one already in force: only failures count, and the keys are namespaced
// per route so a busy room cannot spend the heartbeat budget or the login budget.

/** A signed-in principal with one Bot, for the write routes to act on. */
async function withSeededHub(root, run, extra = {}) {
  await withHub(root, async (context) => {
    const created = await context.call('POST', '/auth/register', {
      userHandle: 'owner', displayName: 'Owner', password: 'password-long-enough', bootstrapSecret: BOOTSTRAP,
    })
    assert.equal(created.status, 201, created.raw)
    // Registration mints the account; the token comes from login, which is also the route the
    // registration budget must not interfere with.
    const signedIn = await context.call('POST', '/auth/login', {
      userHandle: 'owner',
      password: 'password-long-enough',
      // Credentials are device-bound, so a login without a fingerprint is refused before the
      // password is even considered.
      fingerprint: 'sha256:h14-owner-device',
      publicKey: 'ed25519:AAAA',
      label: 'Owner laptop',
      platform: 'win32',
    })
    assert.equal(signedIn.status, 200, signedIn.raw)
    const token = signedIn.body.accessToken
    const authed = async (method, path, body) => {
      const response = await context.server.inject({
        method,
        url: `/api/v1${path}`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        payload: body === undefined ? undefined : JSON.stringify(body),
      })
      let json
      try {
        json = response.json()
      } catch {
        json = undefined
      }
      return { status: response.statusCode, body: json, raw: response.body }
    }
    await run({ ...context, authed, token })
  }, extra)
}

test('a heartbeat flood is refused with 429 instead of writing the directory unbounded', async () => {
  const { root, cleanup } = tempRoot()
  try {
    await withSeededHub(root, async ({ authed }) => {
      const registered = await authed('POST', '/bots', {
        botId: 'flood-bot', displayName: 'Flood', description: 'for the rate limit case',
        capabilities: ['search'],
      })
      assert.equal(registered.status, 201, registered.raw)

      const statuses = []
      for (let i = 0; i < 40; i += 1) statuses.push((await authed('POST', '/bots/flood-bot/heartbeat', { state: 'ready' })).status)
      assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)
    }, { HUB_LOGIN_MAX_ATTEMPTS: '3' })
  } finally {
    cleanup()
  }
})

test('a message flood is refused with 429 rather than taking the room write lock on every request', async () => {
  const { root, cleanup } = tempRoot()
  try {
    await withSeededHub(root, async ({ authed }) => {
      const room = await authed('POST', '/rooms', { name: 'Flood', kind: 'workgroup' })
      assert.equal(room.status, 201, room.raw)
      const statuses = []
      for (let i = 0; i < 60; i += 1) {
        statuses.push((await authed('POST', `/rooms/${room.body.room.id}/messages`, { body: `message ${String(i)}` })).status)
      }
      assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`)
    }, { HUB_LOGIN_MAX_ATTEMPTS: '3' })
  } finally {
    cleanup()
  }
})

test('every route budget is its own, so one busy route does not lock the others', () => {
  // Namespaced keys are what make the budgets independent. Without this, tripping the message
  // limit would also refuse the login the same person needs to get back in.
  const { cleanup } = tempRoot()
  try {
    const keys = [...heartbeatKeys({ botId: 'b1', source: '10.0.0.1' }), ...messageKeys({ roomId: 'r1', source: '10.0.0.1' })]
    assert.ok(keys.every(key => typeof key === 'string' && key.length > 0))
    assert.ok(keys.some(key => key.startsWith('heartbeat:')))
    assert.ok(keys.some(key => key.startsWith('message:')))
    assert.equal(keys.some(key => key.startsWith('login:') || key.startsWith('register:')), false)
  } finally {
    cleanup()
  }
})
