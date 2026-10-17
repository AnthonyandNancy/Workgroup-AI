// A-01: the application can configure a Hub, register a device, sign in, and agree on a protocol.
//
// Two halves, both necessary:
//
//   * **Against the real Hub.** The server package is not mocked. A client that talks to a fake
//     is a client that has never met the contract: the field names, the status codes, the error
//     envelope, and the refresh rotation are all things this test would otherwise be guessing at.
//     The Hub is started here exactly as `server/src/index.js` starts it — same config loader, same
//     migrations, same Fastify instance — on an ephemeral port, over real HTTP.
//   * **The refusals.** Most of the value of a handshake is in what it rejects. A wrong protocol,
//     an unreachable Hub, a closed registration, a revoked device, and a stale token each get a
//     case, because each one is a distinct thing for the person at the keyboard to do.
//
// The client is imported as the application will import { recycleTestPath } from './recycle.mjs'
import it, through its own entry point, so a
// change to how the module is shaped breaks this test rather than only breaking at runtime.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  createHubClient,
  deviceFingerprint,
  hubStatePath,
  resolveHubUrl,
  PROTOCOL_VERSION,
  HubProtocolError,
  HUB_ERROR_CODES,
  checkHubProtocol,
  apiRootOf,
  tokenNeedsRefresh,
} from '../protocol/hub-client.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const SERVER_ROOT = resolve(HERE, '..', '..', '..', '..', 'server')
const SIGNING_KEY = 'a01-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a01-bootstrap-secret'

/** Start a real Hub on an ephemeral port and wait until it answers. */
async function startRealHub({ registration = 'admin_secret', env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a01-'))
  const port = 19000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'),
      HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_REGISTRATION: registration,
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(`${base}/api/v1/health/live`)
      if (response.ok) break
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`the Hub never came up:\n${log}`)
    }
    await new Promise(resume => setTimeout(resume, 150))
  }

  return {
    base,
    log: () => log,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resume => setTimeout(resume, 5000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      recycleTestPath(root)
    },
    root,
  }
}

let hub
const temporaryDirs = []

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'workgroup-a01-client-'))
  temporaryDirs.push(path)
  return path
}

beforeAll(async () => {
  hub = await startRealHub()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
  for (const path of temporaryDirs) recycleTestPath(path)
}, 30_000)

function client(options = {}) {
  return createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test', ...options })
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('protocol handshake', () => {
  it('reads the Hub\u2019s protocol and accepts a Hub that speaks the same version', async () => {
    const config = await client().handshake()
    assert.equal(config.protocol, PROTOCOL_VERSION)
    assert.equal(config.registrationMode, 'admin_secret')
    // The handle policy comes from the Hub, not from a constant here: the client validating
    // handles against its own copy would reject handles the Hub accepts.
    assert.equal(config.handlePolicy.minLength, 3)
    assert.equal(config.handlePolicy.maxLength, 32)
    assert.match(config.handlePolicy.pattern, /\^\[a-z0-9\]/)
    assert.ok(config.accessTokenTtlSeconds > 0)
  })

  it('refuses a Hub that speaks a different protocol, and names the side to update', () => {
    const newer = checkHubProtocol('wg.v2')
    assert.equal(newer.ok, false)
    assert.equal(newer.code, HUB_ERROR_CODES.UNSUPPORTED_PROTOCOL)
    assert.match(newer.message, /client speaks wg\.v1 but the Hub speaks wg\.v2/)
    assert.match(newer.message, /Update this client/)

    const older = checkHubProtocol('wg.v0')
    assert.equal(older.ok, false)
    // The direction matters to whoever reads it: a newer Hub means the client must be updated,
    // an older Hub means the server must be.
    assert.match(older.message, /Update the Hub/)
  })

  it('refuses something that is not a Workgroup AI Hub at all', () => {
    for (const value of [undefined, null, '', 'nonsense', 'wg.1', { protocol: 'wg.v1' }]) {
      const verdict = checkHubProtocol(value)
      assert.equal(verdict.ok, false, `expected a refusal for ${JSON.stringify(value)}`)
      assert.equal(verdict.code, HUB_ERROR_CODES.UNSUPPORTED_PROTOCOL)
      assert.match(verdict.message, /did not answer like a Workgroup AI Hub/)
    }
  })

  it('accepts a future Hub that keeps the same major version', () => {
    // A v1 Hub that adds a field is still v1; demanding the whole string match would make every
    // compatible server upgrade a client upgrade.
    assert.deepEqual(checkHubProtocol('wg.v1'), { ok: true, protocol: 'wg.v1' })
    assert.deepEqual(checkHubProtocol('  wg.v1  '), { ok: true, protocol: '  wg.v1  ' })
  })

  it('reports an unreachable Hub as unreachable, not as an authentication failure', async () => {
    const dead = createHubClient({ hubUrl: 'http://127.0.0.1:1' })
    await assert.rejects(dead.handshake(), (error) => {
      assert.equal(error.code, HUB_ERROR_CODES.HUB_UNREACHABLE)
      // The address is in the message, because that is what the person has to go and check.
      assert.match(error.message, /Cannot reach the Hub at http:\/\/127\.0\.0\.1:1\/api\/v1/)
      return true
    })
  })
})

describe('Hub address configuration', () => {
  it('accepts the shapes an operator actually types', () => {
    assert.equal(apiRootOf('https://hub.example.com'), 'https://hub.example.com/api/v1')
    assert.equal(apiRootOf('https://hub.example.com/'), 'https://hub.example.com/api/v1')
    assert.equal(apiRootOf('https://hub.example.com/api/v1'), 'https://hub.example.com/api/v1')
    assert.equal(apiRootOf('https://hub.example.com/api/v1/'), 'https://hub.example.com/api/v1')
    assert.equal(apiRootOf('http://10.0.0.5:8443'), 'http://10.0.0.5:8443/api/v1')
    assert.equal(apiRootOf('https://hub.example.com/prefix'), 'https://hub.example.com/prefix/api/v1')
  })

  it('refuses a value that is not an absolute http(s) URL', () => {
    for (const bad of ['', 'hub.example.com', '/api/v1', 'ftp://hub.example.com', 'file:///tmp/hub']) {
      assert.throws(() => apiRootOf(bad), (error) => {
        assert.equal(error.code, HUB_ERROR_CODES.NOT_CONFIGURED)
        return true
      }, `expected a refusal for ${JSON.stringify(bad)}`)
    }
  })

  it('refuses a URL with a query or fragment rather than silently dropping it', () => {
    // A pasted `?token=…` URL looks like it works, and then the token is quietly ignored.
    assert.throws(() => apiRootOf('https://hub.example.com?token=abc'), /must not carry a query string or fragment/)
    assert.throws(() => apiRootOf('https://hub.example.com#frag'), /must not carry a query string or fragment/)
  })

  it('names the variable to set when no Hub is configured', () => {
    assert.throws(() => resolveHubUrl({}), (error) => {
      assert.equal(error.code, HUB_ERROR_CODES.NOT_CONFIGURED)
      assert.match(error.message, /WORKGROUP_HUB_URL/)
      return true
    })
    // An operator who already set HUB_PUBLIC_URL on the server side is not forced to repeat it.
    assert.equal(resolveHubUrl({ HUB_PUBLIC_URL: 'https://hub.example.com' }), 'https://hub.example.com/api/v1')
    assert.equal(resolveHubUrl({ WORKGROUP_HUB_URL: 'https://wg.example.com' }), 'https://wg.example.com/api/v1')
    // An empty string is not a configured address.
    assert.throws(() => resolveHubUrl({ WORKGROUP_HUB_URL: '   ' }), /No Hub address is configured/)
  })
})

// ---------------------------------------------------------------------------
// Registration and sign-in against the real Hub
// ---------------------------------------------------------------------------

describe('registration and sign-in', () => {
  it('registers with the operator bootstrap secret and signs in from this device', async () => {
    const agent = client({ statePath: join(tempDir(), 'session.json') })
    await agent.handshake()
    const registered = await agent.register({ userHandle: 'alice', displayName: 'Alice Zhang', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    assert.equal(registered.user.userHandle, 'alice')
    assert.equal(registered.user.displayName, 'Alice Zhang')
    // The Hub never returns a password hash; neither does the client's own surface.
    assert.equal('passwordHash' in registered.user, false)

    const session = await agent.login({ userHandle: 'alice', password: PASSWORD, label: 'Alice laptop' })
    assert.equal(session.userHandle, 'alice')
    assert.ok(session.accessToken.length > 0)
    assert.ok(session.refreshToken.startsWith('wgref_'))
    assert.ok(session.deviceId.length > 0)
    assert.equal(agent.signedIn, true)

    const me = await agent.me()
    assert.equal(me.user.userHandle, 'alice')
    assert.equal(me.deviceId, session.deviceId)
    // The identity the client exposes carries the four facts a UI needs to name the user and no
    // credential at all. An exact key set is asserted so adding a token-shaped field fails here.
    assert.deepEqual(Object.keys(agent.identity).sort(), ['deviceId', 'displayName', 'userHandle', 'userId'])
    assert.equal(JSON.stringify(agent.identity).includes(session.accessToken), false)
    assert.equal(JSON.stringify(agent.identity).includes(session.refreshToken), false)
  })

  it('refuses registration without the bootstrap secret and says why it might be', async () => {
    const agent = client()
    await agent.handshake()
    await assert.rejects(agent.register({ userHandle: 'intruder', displayName: 'Intruder', password: PASSWORD }), (error) => {
      assert.equal(error.code, HUB_ERROR_CODES.REGISTRATION_REFUSED)
      assert.equal(error.status, 403)
      assert.match(error.message, /bootstrap secret, or be closed/)
      return true
    })
  })

  it('refuses a wrong password and does not create a session', async () => {
    const agent = client({ statePath: join(tempDir(), 'session.json') })
    await agent.handshake()
    await agent.register({ userHandle: 'bob', displayName: 'Bob Li', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    await assert.rejects(agent.login({ userHandle: 'bob', password: 'not-the-password' }), (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.code, 'INVALID_CREDENTIALS')
      return true
    })
    assert.equal(agent.signedIn, false)
    assert.equal(agent.identity, undefined)
  })

  it('reuses the same device row across restarts instead of registering a new device each time', async () => {
    const statePath = join(tempDir(), 'session.json')
    const first = client({ statePath })
    await first.handshake()
    await first.register({ userHandle: 'carol', displayName: 'Carol Wu', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    const firstSession = await first.login({ userHandle: 'carol', password: PASSWORD })

    // A second client process on the same machine presents the same fingerprint.
    const second = client({ statePath: join(tempDir(), 'session2.json') })
    await second.handshake()
    const secondSession = await second.login({ userHandle: 'carol', password: PASSWORD })
    assert.equal(secondSession.deviceId, firstSession.deviceId, 'a restart must not create a second device')

    const devices = await second.devices()
    assert.equal(devices.devices.length, 1, `expected one device, got ${devices.devices.map(d => d.id).join(', ')}`)
    assert.equal(devices.devices[0].label, `Workgroup AI on ${(await import('node:os')).hostname()}`)
    assert.match(devices.devices[0].platform, /darwin|linux|win32/)
  })

  it('keeps the session on disk with owner-only permissions and never stores the password', async () => {
    const statePath = join(tempDir(), 'nested', 'hub-session.json')
    const agent = client({ statePath })
    await agent.handshake()
    await agent.register({ userHandle: 'dave', displayName: 'Dave Chen', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    await agent.login({ userHandle: 'dave', password: PASSWORD })

    assert.equal(existsSync(statePath), true)
    const stored = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(stored.userHandle, 'dave')
    assert.ok(stored.refreshToken.startsWith('wgref_'))
    // The password is the one thing that must never be written down.
    assert.equal(JSON.stringify(stored).includes(PASSWORD), false)
    if (process.platform !== 'win32') {
      assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the credential file must not be group- or world-readable')
    }

    // A fresh client with the same state file is already signed in without another login.
    const reopened = client({ statePath })
    assert.equal(reopened.signedIn, true)
    assert.equal((await reopened.me()).user.userHandle, 'dave')
  })

  it('survives a corrupt credential file instead of refusing to start', async () => {
    const statePath = join(tempDir(), 'hub-session.json')
    writeFileSync(statePath, '{ this is not json')
    const agent = client({ statePath })
    // Not signed in, and usable: the recovery is to sign in again, which the client allows.
    assert.equal(agent.signedIn, false)
    await agent.handshake()
    await agent.register({ userHandle: 'erin', displayName: 'Erin Xu', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    await agent.login({ userHandle: 'erin', password: PASSWORD })
    assert.equal(agent.signedIn, true)
  })

  it('logs out by revoking the refresh token on the Hub, and forgets it locally', async () => {
    const statePath = join(tempDir(), 'session.json')
    const agent = client({ statePath })
    await agent.handshake()
    await agent.register({ userHandle: 'frank', displayName: 'Frank Ma', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    const session = await agent.login({ userHandle: 'frank', password: PASSWORD })
    const refreshToken = session.refreshToken

    await agent.logout()
    assert.equal(agent.signedIn, false)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).refreshToken, undefined)

    // The revoked token must not work: logout has to mean the Hub stops accepting it.
    const fresh = client()
    await assert.rejects(
      fresh.request('POST', '/auth/refresh', { body: { refreshToken }, auth: false }),
      (error) => {
        assert.equal(error.status, 401)
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

describe('token lifecycle', () => {
  it('refreshes a token that is close to expiring, before the request needs it', async () => {
    const dir = tempDir()
    const statePath = join(dir, 'session.json')
    const agent = client({ statePath })
    await agent.handshake()
    await agent.register({ userHandle: 'grace', displayName: 'Grace Zhao', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    const session = await agent.login({ userHandle: 'grace', password: PASSWORD })

    // The skew is a parameter, so the decision is testable at any distance from the expiry: the
    // same token is "stale" at an hour of skew and "fresh" at one second.
    assert.equal(tokenNeedsRefresh(session.accessTokenExpiresAt, { skewSeconds: 3600 }), true)
    assert.equal(tokenNeedsRefresh(session.accessTokenExpiresAt, { skewSeconds: 1 }), false)

    // A token the Hub just issued has ~15 minutes of life, which is further than the client's own
    // 60-second skew: `ensureFreshToken` must therefore decline to refresh a healthy token rather
    // than rotate on every call, which would burn refresh tokens and change the stored credential
    // on every request.
    const refreshTokenBefore = JSON.parse(readFileSync(statePath, 'utf8')).refreshToken
    assert.equal(await agent.ensureFreshToken(), false, 'a healthy token must not be rotated')
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).refreshToken, refreshTokenBefore)

    // And a token the client believes is stale *is* refreshed, rotating the refresh token with it.
    const stalePath = join(dir, 'stale.json')
    const staleAgent = client({ statePath: stalePath })
    await staleAgent.handshake()
    await staleAgent.register({ userHandle: 'grace2', displayName: 'Grace Two', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    await staleAgent.login({ userHandle: 'grace2', password: PASSWORD })
    // Simulate the passage of time by writing an expiry inside the skew window, which is what a
    // client that has been open for 14 minutes actually sees.
    const stored = JSON.parse(readFileSync(stalePath, 'utf8'))
    stored.accessTokenExpiresAt = new Date(Date.now() + 10_000).toISOString()
    writeFileSync(stalePath, JSON.stringify(stored))
    const reopened = client({ statePath: stalePath })
    assert.equal(await reopened.ensureFreshToken(), true, 'a token inside the skew window must be refreshed')

    assert.equal((await agent.me()).user.userHandle, 'grace')
  })

  it('treats a missing or unparseable expiry as needing a refresh', () => {
    assert.equal(tokenNeedsRefresh(undefined), true)
    assert.equal(tokenNeedsRefresh('not-a-date'), true)
    assert.equal(tokenNeedsRefresh(new Date(Date.now() + 3600_000).toISOString()), false)
    assert.equal(tokenNeedsRefresh(new Date(Date.now() - 1000).toISOString()), true)
  })

  it('refuses to make an authenticated request while signed out, rather than sending an empty token', async () => {
    const agent = client()
    await assert.rejects(agent.me(), (error) => {
      assert.equal(error.code, HUB_ERROR_CODES.UNAUTHENTICATED)
      return true
    })
  })

  it('recovers from a token the Hub rejects by refreshing once', async () => {
    const statePath = join(tempDir(), 'session.json')
    const agent = client({ statePath })
    await agent.handshake()
    await agent.register({ userHandle: 'heidi', displayName: 'Heidi Song', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    await agent.login({ userHandle: 'heidi', password: PASSWORD })

    // Corrupt the access token while leaving the refresh token intact: this is what a client sees
    // when its token is revoked ahead of its stated expiry.
    const stored = JSON.parse(readFileSync(statePath, 'utf8'))
    stored.accessToken = 'wg1.k1.notarealtoken.notarealmac'
    writeFileSync(statePath, JSON.stringify(stored))

    const revived = client({ statePath })
    const me = await revived.me()
    assert.equal(me.user.userHandle, 'heidi')
    // The stored token really was replaced, not merely tolerated.
    assert.notEqual(JSON.parse(readFileSync(statePath, 'utf8')).accessToken, 'wg1.k1.notarealtoken.notarealmac')
  })

  it('fails clearly when a device has been revoked, and does not keep retrying', async () => {
    const statePath = join(tempDir(), 'session.json')
    const agent = client({ statePath })
    await agent.handshake()
    await agent.register({ userHandle: 'ivan', displayName: 'Ivan He', password: PASSWORD, bootstrapSecret: BOOTSTRAP })
    const session = await agent.login({ userHandle: 'ivan', password: PASSWORD })

    const revoke = await agent.request('POST', `/devices/${session.deviceId}/revoke`)
    assert.equal(revoke.device.revokedAt !== null, true)

    // The refresh token was revoked with the device, so there is nothing to recover with: one
    // clear refusal, not an endless refresh loop.
    await assert.rejects(agent.me(), (error) => {
      assert.ok(['DEVICE_REVOKED', 'INVALID_REFRESH_TOKEN'].includes(error.code), `unexpected code ${error.code}`)
      return true
    })
  })
})

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

describe('device fingerprint', () => {
  it('is stable for one machine and different across machines', () => {
    const one = deviceFingerprint({ hostnameValue: 'laptop-a', platformValue: 'win32', archValue: 'x64' })
    const again = deviceFingerprint({ hostnameValue: 'laptop-a', platformValue: 'win32', archValue: 'x64' })
    const other = deviceFingerprint({ hostnameValue: 'laptop-b', platformValue: 'win32', archValue: 'x64' })
    assert.equal(one, again)
    assert.notEqual(one, other)
    assert.match(one, /^sha256:[0-9a-f]{64}$/)
    // The hostname must not be recoverable from the value the Hub stores.
    assert.equal(one.includes('laptop-a'), false)
  })

  it('separates the product from any other client on the same machine', () => {
    const mine = deviceFingerprint({ hostnameValue: 'laptop-a', platformValue: 'win32', archValue: 'x64', salt: 'workgroup-ai' })
    const plain = deviceFingerprint({ hostnameValue: 'laptop-a', platformValue: 'win32', archValue: 'x64' })
    assert.notEqual(mine, plain)
  })

  it('keeps the session under the product data root, not a shared location', () => {
    const path = hubStatePath('/home/alice/.workgroup-ai')
    assert.equal(path, join('/home/alice/.workgroup-ai', 'workgroup', 'hub-session.json'))
    assert.equal(path.includes('.dsh'), false, 'the fork must not write into the official product data root')
  })
})

// ---------------------------------------------------------------------------
// A Hub that refuses at the protocol level
// ---------------------------------------------------------------------------

describe('refusing a Hub that is not compatible', () => {
  it('stops before registering a device against an incompatible Hub', async () => {
    // A stand-in for an incompatible Hub: it answers /auth/config with a different protocol. The
    // point is that the client refuses *before* it would create state on the other side.
    const incompatible = createHubClient({
      hubUrl: 'https://example.invalid',
      fetchImpl: async () => new Response(JSON.stringify({ protocol: 'wg.v9', registrationMode: 'open' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    })
    await assert.rejects(incompatible.handshake(), (error) => {
      assert.ok(error instanceof HubProtocolError)
      assert.equal(error.code, HUB_ERROR_CODES.UNSUPPORTED_PROTOCOL)
      assert.match(error.message, /speaks wg\.v9/)
      return true
    })
  })

  it('does not swallow a Hub error envelope, so the caller can branch on the code', async () => {
    const refusing = createHubClient({
      hubUrl: 'https://example.invalid',
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { code: 'SOMETHING_SPECIFIC', message: 'The Hub said no' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    })
    await assert.rejects(refusing.register({ userHandle: 'x', displayName: 'X', password: PASSWORD }), (error) => {
      assert.equal(error.code, 'SOMETHING_SPECIFIC')
      assert.equal(error.status, 400)
      assert.match(error.message, /The Hub said no \(400 SOMETHING_SPECIFIC\)/)
      return true
    })
  })
})
