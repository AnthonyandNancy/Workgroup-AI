// H-03 identity routes: registration, login, refresh, logout, device listing and revocation.
//
// Authorization rules this module enforces, in one place:
//
//  * Registration obeys the Hub's configured mode. `open` admits anyone (development and
//    the test suite); `admin_secret` requires the operator's bootstrap secret; `closed`
//    refuses everyone, for a Hub whose accounts are provisioned out of band.
//  * A login is a credential check plus a live device check. A revoked device never
//    receives a token, even with the correct password.
//  * Access tokens authorize a route only together with a live device row, so revoking a
//    device takes effect on the next request rather than when the token expires.
//  * A user may only see and revoke their own devices.

import { issueAccessToken, generateRefreshToken } from '../auth/tokens.js'
import { loginKeys } from '../security/ratelimit.js'
import { registrationKeys } from '../security/ratelimit-store.js'
import { protocolVersion } from '../version.js'
import {
  IdentityError, createUser, createGuestIdentity, findUserByHandle, findUserById, registerDevice, findDeviceById, listDevices,
  isDeviceActive, revokeDevice, revokeAllForUser, issueRefreshToken, findRefreshToken, rotateRefreshToken,
  revokeRefreshToken, touchDevice,
} from '../auth/store.js'
import { hashPassword, verifyPassword, needsRehash, assertPasswordAcceptable, PasswordPolicyError } from '../auth/password.js'

const HANDLE_MIN = 3
const HANDLE_MAX = 32

function authError(reply, status, code, message) {
  return reply.code(status).send({ error: { code, message } })
}

/** Map a domain error to a response without leaking which half of a check failed. */
function identityFailure(reply, error) {
  if (error instanceof PasswordPolicyError) return authError(reply, 400, 'PASSWORD_POLICY', error.message)
  switch (error.code) {
    case 'INVALID_HANDLE':
    case 'INVALID_DISPLAY_NAME':
    case 'INVALID_PUBLIC_KEY':
    case 'INVALID_FINGERPRINT':
      return authError(reply, 400, error.code, error.message)
    case 'HANDLE_TAKEN':
      return authError(reply, 409, 'HANDLE_TAKEN', error.message)
    case 'ACCOUNT_DISABLED':
      return authError(reply, 403, 'ACCOUNT_DISABLED', error.message)
    case 'DEVICE_ALREADY_REGISTERED':
      return authError(reply, 409, 'DEVICE_ALREADY_REGISTERED', error.message)
    case 'NO_SUCH_USER':
    case 'NO_SUCH_DEVICE':
      return authError(reply, 404, error.code, error.message)
    default:
      throw error
  }
}

/**
 * Registration gate.
 *
 * The refusal for a bad bootstrap secret is deliberately the same status and shape as a
 * closed Hub, so probing cannot tell "wrong secret" from "registration disabled".
 */
function registrationAllowed(config, body, reply) {
  if (config.registration.mode === 'closed') {
    return authError(reply, 403, 'REGISTRATION_CLOSED', 'Registration is closed on this Hub')
  }
  if (config.registration.mode === 'admin_secret' && !config.registration.acceptsBootstrapSecret(body?.bootstrapSecret)) {
    return authError(reply, 403, 'REGISTRATION_CLOSED', 'Registration is closed on this Hub')
  }
  return undefined
}

/** Shape a user row for a response: never the password hash. */
function publicUser(user) {
  return {
    id: user.id,
    userHandle: user.user_handle,
    displayName: user.display_name,
    status: user.status,
    createdAt: user.created_at,
  }
}

function publicDevice(device) {
  return {
    id: device.id,
    label: device.label ?? null,
    platform: device.platform ?? null,
    appVersion: device.app_version ?? null,
    fingerprint: device.fingerprint,
    revokedAt: device.revoked_at ?? null,
    lastSeenAt: device.last_seen_at ?? null,
    lastLoginAt: device.last_login_at ?? null,
    createdAt: device.created_at,
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function bootstrapSourceKey(source) {
  return `bootstrap:source:${typeof source === 'string' && source !== '' ? source : 'unknown'}`
}

function parseBootstrapRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: ['INVALID_BOOTSTRAP_REQUEST', 'A bootstrap request object is required'] }
  }
  if (typeof body.installationId !== 'string' || !UUID_PATTERN.test(body.installationId)) {
    return { error: ['INVALID_INSTALLATION_ID', 'installationId must be a UUID'] }
  }
  const deviceLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel.trim() : ''
  if (deviceLabel.length < 1 || deviceLabel.length > 120) {
    return { error: ['INVALID_DEVICE_LABEL', 'deviceLabel must be 1-120 characters'] }
  }
  const platform = typeof body.platform === 'string' ? body.platform.trim() : ''
  if (platform.length < 1 || platform.length > 64) {
    return { error: ['INVALID_PLATFORM', 'platform must be 1-64 characters'] }
  }
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion.trim() : ''
  if (appVersion.length > 120) {
    return { error: ['INVALID_APP_VERSION', 'appVersion must be at most 120 characters'] }
  }
  return { value: { installationId: body.installationId, deviceLabel, platform, appVersion: appVersion || null } }
}

/**
 * Fastify plugin holding every H-03 route. Registered from `src/api/index.js`.
 *
 * The authenticator itself lives in `../auth/request.js`: the rooms module needs the same
 * rule, and a second copy here is exactly how two resource modules drift apart.
 */
export async function identityRoutes(fastify) {
  const { config, db } = fastify.hub
  // The server builds the one shared authenticator; reading it here keeps this module from
  // having its own idea of what a valid caller is.
  const requireAuth = fastify.hub.requireAuth
  // One limiter per Hub, built from configuration and shared by every login attempt. A limiter
  // constructed per request would count nothing.
  const loginLimiter = fastify.hub.loginLimiter
  // Registration gets its own counter with the same rule. It is a separate instance because the
  // keys carry a different prefix: a shared budget would let a burst of failed registrations lock
  // out sign-in for the same address, which is a denial of service an attacker can trigger for
  // free.
  const registerLimiter = fastify.hub.registerLimiter
  const bootstrapLimiter = fastify.hub.bootstrapLimiter

  // ---- anonymous bootstrap ----

  fastify.post('/api/v1/auth/bootstrap', async (request, reply) => {
    const sourceKey = bootstrapSourceKey(request.ip)
    const verdict = bootstrapLimiter.check(sourceKey)
    if (!verdict.allowed) {
      reply.header('retry-after', String(verdict.retryAfterSeconds))
      return authError(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many bootstrap attempts; wait before trying again')
    }

    if (!config.anonymousBootstrapEnabled) {
      bootstrapLimiter.recordFailure(sourceKey)
      return authError(reply, 403, 'ANONYMOUS_BOOTSTRAP_DISABLED', 'Anonymous bootstrap is disabled on this Hub')
    }

    const parsed = parseBootstrapRequest(request.body ?? {})
    if (parsed.error !== undefined) {
      bootstrapLimiter.recordFailure(sourceKey)
      return authError(reply, 400, parsed.error[0], parsed.error[1])
    }

    const now = new Date()
    const refreshSecret = generateRefreshToken()
    let session
    try {
      session = createGuestIdentity(db, {
        deviceLabel: parsed.value.deviceLabel,
        platform: parsed.value.platform,
        appVersion: parsed.value.appVersion,
        refreshSecret,
        refreshTokenTtlSeconds: config.tokens.refreshTokenTtlSeconds,
        now,
      })
    } catch (error) {
      bootstrapLimiter.recordFailure(sourceKey)
      request.log.error({ err: error }, 'anonymous bootstrap failed')
      return authError(reply, 500, 'BOOTSTRAP_FAILED', 'The Hub could not create a guest session')
    }

    const accessToken = issueAccessToken({
      keyring: config.tokenKeyring,
      signingKey: config.readTokenSigningKey(),
      userId: session.user.id,
      deviceId: session.device.id,
      ttlSeconds: config.tokens.accessTokenTtlSeconds,
      now,
    })
    bootstrapLimiter.clear(sourceKey)
    return reply.code(201).send({
      user: publicUser(session.user),
      device: publicDevice(session.device),
      accessToken,
      refreshToken: refreshSecret,
      accessTokenExpiresAt: new Date(now.getTime() + config.tokens.accessTokenTtlSeconds * 1000).toISOString(),
      refreshTokenExpiresAt: session.refresh.expiresAt,
    })
  })

  // ---- registration ----

  fastify.post('/api/v1/auth/register', async (request, reply) => {
    const body = request.body ?? {}
    // Throttled before the secret comparison and before the password hash: a refused attempt must
    // cost the Hub nothing beyond the check, or the limiter itself becomes the amplifier. The route
    // that mints identities is the one an open Hub most needs a ceiling on, because the bootstrap
    // secret is the only other thing between a reachable Hub and unlimited accounts.
    const keys = registrationKeys({ source: request.ip })
    for (const key of keys) {
      const verdict = registerLimiter.check(key)
      if (!verdict.allowed) {
        reply.header('retry-after', String(verdict.retryAfterSeconds))
        return authError(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many registration attempts; wait before trying again')
      }
    }
    const denied = registrationAllowed(config, body, reply)
    if (denied !== undefined) {
      // A refused attempt is what the counter exists for: without this, only successful
      // registrations would be counted and the limit would never be reached by an attacker.
      for (const key of keys) registerLimiter.recordFailure(key)
      return denied
    }
    try {
      assertPasswordAcceptable(body.password)
    } catch (error) {
      for (const key of keys) registerLimiter.recordFailure(key)
      return identityFailure(reply, error)
    }

    const passwordHash = await hashPassword(body.password)
    let user
    try {
      user = createUser(db, { handle: body.userHandle, displayName: body.displayName, passwordHash })
    } catch (error) {
      for (const key of keys) registerLimiter.recordFailure(key)
      return identityFailure(reply, error)
    }
    // A successful registration clears the caller's own history, so an operator onboarding several
    // colleagues from one machine is not locked out by the retries that got them there.
    for (const key of keys) registerLimiter.clear(key)
    return reply.code(201).send({ user: publicUser(user) })
  })

  // ---- login ----

  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const body = request.body ?? {}
    // Throttled before the password hash is computed: a blocked attempt must cost the Hub
    // nothing, otherwise the limiter itself becomes the denial-of-service.
    const keys = loginKeys({ handle: body.userHandle, source: request.ip })
    for (const key of keys) {
      const verdict = loginLimiter.check(key)
      if (!verdict.allowed) {
        // 429 with `Retry-After`, because a client that cannot see when to try again will try
        // again immediately and extend its own lockout.
        reply.header('retry-after', String(verdict.retryAfterSeconds))
        return authError(reply, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts; wait before trying again')
      }
    }

    const user = findUserByHandle(db, body.userHandle)
    // The password is verified even when the handle is unknown, against a throwaway hash,
    // so a caller cannot tell existing handles from missing ones by response time.
    const storedHash = user?.password_hash
    const ok = await verifyPassword(body.password ?? '', storedHash ?? DUMMY_HASH)
    if (user === undefined || !ok) {
      for (const key of keys) loginLimiter.recordFailure(key)
      // Recorded as a log line, not an audit row. An unauthenticated request must not be able
      // to make the Hub write to its audit table: a spray across many handles from many sources
      // would grow the log an operator keeps for evidence. The structured log name is enough to
      // alert on, and the limiter caps how many of these one source can produce.
      request.log.warn({ event: 'login.failed', handle: typeof body.userHandle === 'string' ? body.userHandle : null, source: request.ip }, 'sign-in failed')
      return authError(reply, 401, 'INVALID_CREDENTIALS', 'The handle or password is not correct')
    }
    if (user.status !== 'active') {
      // Not counted as a failure: the caller proved who they are, and counting it would let a
      // disabled user's own retries lock out the account they legitimately own.
      return authError(reply, 403, 'ACCOUNT_DISABLED', 'This account is disabled')
    }
    if (typeof body.fingerprint !== 'string' || body.fingerprint.length < 8) {
      return authError(reply, 400, 'INVALID_FINGERPRINT', 'A device fingerprint is required')
    }
    // The credentials were right, so this key's history is spent, not carried forward: a user
    // who mistyped twice this morning starts fresh once they get in.
    for (const key of keys) loginLimiter.clear(key)

    // Reuse the device row for a known fingerprint so a client that restarts keeps its
    // identity; a revoked device is reported rather than silently replaced.
    let device = db.prepare('SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?').get(user.id, body.fingerprint)
    if (device !== undefined && device.revoked_at !== null && device.revoked_at !== undefined) {
      return authError(reply, 403, 'DEVICE_REVOKED', 'This device has been revoked; register it again to continue')
    }
    if (device === undefined) {
      try {
        device = registerDevice(db, {
          userId: user.id,
          publicKey: body.publicKey ?? `unregistered:${body.fingerprint}`,
          fingerprint: body.fingerprint,
          label: body.label,
          platform: body.platform,
          appVersion: body.appVersion,
        })
      } catch (error) {
        return identityFailure(reply, error)
      }
    }

    // A login that succeeded with a weaker hash upgrades it in place, so raising the cost
    // parameter does not require a password reset for every account.
    if (needsRehash(user.password_hash)) {
      try {
        const upgraded = await hashPassword(body.password)
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(upgraded, user.id)
      } catch {
        // An upgrade that fails must not fail the login the user already passed.
      }
    }

    const now = new Date()
    db.prepare('UPDATE devices SET last_login_at = ? WHERE id = ?').run(now.toISOString(), device.id)
    touchDevice(db, { deviceId: device.id, now })

    const accessToken = issueAccessToken({
      keyring: config.tokenKeyring,
      signingKey: config.readTokenSigningKey(),
      userId: user.id,
      deviceId: device.id,
      ttlSeconds: config.tokens.accessTokenTtlSeconds,
      now,
    })
    const refreshSecret = generateRefreshToken()
    const refresh = issueRefreshToken(db, {
      userId: user.id,
      deviceId: device.id,
      secret: refreshSecret,
      ttlSeconds: config.tokens.refreshTokenTtlSeconds,
      now,
    })

    return reply.code(200).send({
      user: publicUser(user),
      device: publicDevice(findDeviceById(db, device.id)),
      accessToken,
      refreshToken: refreshSecret,
      accessTokenExpiresIn: config.tokens.accessTokenTtlSeconds,
      refreshTokenExpiresAt: refresh.expiresAt,
    })
  })

  // ---- refresh ----

  fastify.post('/api/v1/auth/refresh', async (request, reply) => {
    const body = request.body ?? {}
    const secret = body.refreshToken
    if (typeof secret !== 'string' || secret.length === 0) {
      return authError(reply, 400, 'MISSING_REFRESH_TOKEN', 'A refresh token is required')
    }
    const row = findRefreshToken(db, secret)
    if (row === undefined) return authError(reply, 401, 'INVALID_REFRESH_TOKEN', 'The refresh token is not valid')

    const now = new Date()
    const nowString = now.toISOString()
    if (row.revoked_at !== null && row.revoked_at !== undefined) {
      return authError(reply, 401, 'REFRESH_TOKEN_REVOKED', 'The refresh token has been revoked')
    }
    if (row.expires_at <= nowString) return authError(reply, 401, 'REFRESH_TOKEN_EXPIRED', 'The refresh token has expired')

    if (row.used_at !== null && row.used_at !== undefined) {
      // Reuse of a consumed token means two parties hold it. Withdraw the whole device's
      // credentials rather than guessing which party is legitimate.
      revokeDevice(db, { deviceId: row.device_id, actorUserId: row.user_id, now })
      return authError(reply, 401, 'REFRESH_TOKEN_REUSED', 'This refresh token was already used; the device has been signed out')
    }
    if (!isDeviceActive(db, { deviceId: row.device_id, userId: row.user_id })) {
      revokeRefreshToken(db, { tokenId: row.id, now })
      return authError(reply, 403, 'DEVICE_REVOKED', 'This device has been revoked')
    }
    const user = findUserById(db, row.user_id)
    if (user === undefined) return authError(reply, 401, 'UNKNOWN_USER', 'The refresh token names an unknown user')
    if (user.status !== 'active') return authError(reply, 403, 'ACCOUNT_DISABLED', 'This account is disabled')

    const newSecret = generateRefreshToken()
    const rotated = rotateRefreshToken(db, {
      presentedId: row.id,
      userId: row.user_id,
      deviceId: row.device_id,
      newSecret,
      ttlSeconds: config.tokens.refreshTokenTtlSeconds,
      now,
    })
    touchDevice(db, { deviceId: row.device_id, now })
    const accessToken = issueAccessToken({
      keyring: config.tokenKeyring,
      signingKey: config.readTokenSigningKey(),
      userId: row.user_id,
      deviceId: row.device_id,
      ttlSeconds: config.tokens.accessTokenTtlSeconds,
      now,
    })
    return reply.code(200).send({
      accessToken,
      refreshToken: newSecret,
      accessTokenExpiresIn: config.tokens.accessTokenTtlSeconds,
      refreshTokenExpiresAt: rotated.expiresAt,
    })
  })

  // ---- logout ----

  fastify.post('/api/v1/auth/logout', async (request, reply) => {
    const body = request.body ?? {}
    const secret = body.refreshToken
    if (typeof secret !== 'string' || secret.length === 0) {
      return authError(reply, 400, 'MISSING_REFRESH_TOKEN', 'A refresh token is required')
    }
    const row = findRefreshToken(db, secret)
    // An unknown or already-revoked token is reported as success: logout is idempotent and
    // must not become an oracle for whether a given token exists.
    if (row !== undefined) revokeRefreshToken(db, { tokenId: row.id })
    return reply.code(200).send({ status: 'signed-out' })
  })

  fastify.post('/api/v1/auth/logout-all', { preHandler: requireAuth }, async (request, reply) => {
    revokeAllForUser(db, { userId: request.auth.user.id })
    return reply.code(200).send({ status: 'all-sessions-revoked' })
  })

  // ---- current user and devices ----

  fastify.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request) => ({
    user: publicUser(request.auth.user),
    deviceId: request.auth.deviceId,
  }))

  fastify.get('/api/v1/devices', { preHandler: requireAuth }, async (request) => ({
    devices: listDevices(db, request.auth.user.id).map(publicDevice),
  }))

  fastify.post('/api/v1/devices/:deviceId/revoke', { preHandler: requireAuth }, async (request, reply) => {
    const target = findDeviceById(db, request.params.deviceId)
    if (target === undefined) return authError(reply, 404, 'NO_SUCH_DEVICE', 'No such device')
    // Object-level check: a user may revoke their own devices and nobody else's, even with
    // a valid token for a different account.
    if (target.user_id !== request.auth.user.id) {
      return authError(reply, 403, 'NOT_YOUR_DEVICE', 'That device belongs to another account')
    }
    revokeDevice(db, { deviceId: target.id, actorUserId: request.auth.user.id })
    // A live socket is a live session. Revoking the device must close it, or the revoked
    // client keeps receiving room events until it happens to reconnect.
    for (const connection of [...fastify.hub.realtime.connections.values()]) {
      if (connection.deviceId !== target.id) continue
      try {
        connection.socket.close(4403, 'this device was revoked')
      } catch {
        // Already gone.
      }
      fastify.hub.realtime.release(connection)
    }
    return reply.code(200).send({ device: publicDevice(findDeviceById(db, target.id)) })
  })

  fastify.get('/api/v1/auth/config', async () => ({
    // `protocol` is the wire contract a client must speak (`wg.v1`), which is the field this
    // route exists to publish. It used to carry the Hub's build version (`0.1.0`), so a client
    // that checked it the way `checkHubProtocol` does would refuse every correctly configured
    // Hub. The build version is reported separately rather than dropped: it is what an operator
    // quotes when reporting a problem.
    protocol: protocolVersion,
    hubVersion: fastify.hub.version,
    registrationMode: config.registration.mode,
    handlePolicy: { minLength: HANDLE_MIN, maxLength: HANDLE_MAX, pattern: '^[a-z0-9][a-z0-9._-]{2,31}$' },
    accessTokenTtlSeconds: config.tokens.accessTokenTtlSeconds,
  }))
}

// A fixed, well-formed scrypt hash used only to give the unknown-handle login path the same
// work as a real check, so response timing does not reveal which handles exist. It hashes no
// usable password: the 32-byte salt is all zero and the digest is a literal that no input
// produces.
const DUMMY_HASH = `scrypt$16384$8$1$${'AAAAAAAAAAAAAAAAAAAAAA=='}$${'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='}`

export const identityRouteInternals = { publicUser, publicDevice, registrationAllowed }
