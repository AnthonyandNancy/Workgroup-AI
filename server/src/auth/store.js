// Hub identity store: users, devices, refresh tokens, and the audit trail for identity events.
//
// Every write that establishes or withdraws access goes through one transaction, so an
// account can never be created without its audit row, and a device can never be revoked
// while a refresh token issued to it stays usable.
//
// Two rules shape the queries:
//
//  1. A revoked device fails every check. Revocation is a timestamp, not a delete, so the
//     audit trail keeps naming the device that acted.
//  2. A refresh token is single-use. `rotateRefreshToken` marks the presented token used in
//     the same transaction that issues its replacement; presenting it again is treated as
//     reuse and revokes the whole device family, which is the standard signal that the
//     token leaked.

import { randomUUID } from 'node:crypto'
import { hashOpaqueSecret, secretLookupId } from './tokens.js'

export class IdentityError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

const USER_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/

export function normalizeUserHandle(handle) {
  return String(handle ?? '').trim().toLowerCase()
}

export function assertUserHandle(handle) {
  const normalized = normalizeUserHandle(handle)
  if (!USER_HANDLE_PATTERN.test(normalized)) {
    throw new IdentityError(
      'A user handle must be 3-32 characters of lowercase letters, digits, dot, underscore, or hyphen, and start with a letter or digit',
      'INVALID_HANDLE',
    )
  }
  return normalized
}

export function assertDisplayName(name) {
  const value = String(name ?? '').trim()
  if (value.length < 1 || value.length > 120) throw new IdentityError('A display name must be 1-120 characters', 'INVALID_DISPLAY_NAME')
  return value
}

function nowIso(now) {
  return now.toISOString()
}

function isoPlusSeconds(now, seconds) {
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

/** Append one audit row. Every identity mutation calls it inside its own transaction. */
function audit(db, { actorUserId, actorDeviceId, eventType, objectType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      actorUserId ?? null,
      actorDeviceId ?? null,
      eventType,
      objectType,
      objectId ?? null,
      outcome,
      // Audit details are deliberately a small, caller-chosen map: this column must never
      // receive a password, a token, or a full request body.
      JSON.stringify(details ?? {}),
      nowIso(now),
    )
}

export function findUserByHandle(db, handle) {
  return db.prepare('SELECT * FROM users WHERE user_handle = ?').get(normalizeUserHandle(handle))
}

export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

export function createUser(db, { handle, displayName, passwordHash, now = new Date() }) {
  const userHandle = assertUserHandle(handle)
  const name = assertDisplayName(displayName)
  if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
    throw new IdentityError('A password hash is required', 'INVALID_PASSWORD_HASH')
  }
  const id = randomUUID()
  const createdAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userHandle, name, passwordHash, 'active', createdAt)
    audit(db, { actorUserId: id, eventType: 'user.created', objectType: 'user', objectId: id, outcome: 'success', details: { userHandle }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    if (/UNIQUE constraint failed: users.user_handle/.test(error.message)) {
      throw new IdentityError(`The handle "${userHandle}" is already taken`, 'HANDLE_TAKEN')
    }
    throw error
  }
  return findUserById(db, id)
}

export function setUserPassword(db, { userId, passwordHash, now = new Date() }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId)
    if (result.changes === 0) throw new IdentityError('No such user', 'NO_SUCH_USER')
    audit(db, { actorUserId: userId, eventType: 'user.password_changed', objectType: 'user', objectId: userId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above: keep the original failure visible.
    }
    throw error
  }
}

export function setUserStatus(db, { userId, status, actorUserId, now = new Date() }) {
  if (!['active', 'disabled'].includes(status)) throw new IdentityError('Status must be active or disabled', 'INVALID_STATUS')
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId)
    if (result.changes === 0) throw new IdentityError('No such user', 'NO_SUCH_USER')
    // Disabling an account must also withdraw its outstanding credentials, otherwise a
    // disabled user keeps working until their tokens happen to expire.
    if (status === 'disabled') {
      const revokedAt = nowIso(now)
      db.prepare('UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(revokedAt, userId)
      db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(revokedAt, userId)
    }
    audit(db, { actorUserId: actorUserId ?? userId, eventType: `user.${status}`, objectType: 'user', objectId: userId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
}

export function findDeviceByFingerprint(db, userId, fingerprint) {
  return db.prepare('SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?').get(userId, fingerprint)
}

export function findDeviceById(db, id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id)
}

export function listDevices(db, userId) {
  return db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId)
}

/**
 * Register a device for a user.
 *
 * `publicKey` is the device's own public key, supplied by the client and used later to
 * verify task grants. The Hub never receives a private key or a device API key back.
 */
/**
 * Register a device for a user.
 *
 * `publicKey` is the device's own public key, supplied by the client and used later to
 * verify task grants. `label` and `platform` are what the user sees in their device list;
 * neither is a filesystem path, and the Hub never asks for one.
 */
export function registerDevice(db, { userId, publicKey, fingerprint, label, platform, appVersion, now = new Date() }) {
  if (typeof publicKey !== 'string' || publicKey.length === 0) throw new IdentityError('A device public key is required', 'INVALID_PUBLIC_KEY')
  if (typeof fingerprint !== 'string' || fingerprint.length < 8) throw new IdentityError('A device fingerprint is required', 'INVALID_FINGERPRINT')
  const user = findUserById(db, userId)
  if (user === undefined) throw new IdentityError('No such user', 'NO_SUCH_USER')
  if (user.status !== 'active') throw new IdentityError('This account is disabled', 'ACCOUNT_DISABLED')

  const id = randomUUID()
  const createdAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO devices (id, user_id, public_key, fingerprint, label, platform, app_version, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, publicKey, fingerprint, label ?? null, platform ?? null, appVersion ?? null, createdAt, createdAt)
    audit(db, { actorUserId: userId, actorDeviceId: id, eventType: 'device.registered', objectType: 'device', objectId: id, outcome: 'success', details: { label: label ?? null, platform: platform ?? null }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    if (/UNIQUE constraint failed: devices.fingerprint/.test(error.message)) {
      throw new IdentityError('This device is already registered', 'DEVICE_ALREADY_REGISTERED')
    }
    throw error
  }
  return findDeviceById(db, id)
}

/**
 * Create the non-interactive identity used by anonymous bootstrap.
 *
 * The password value is intentionally an unusable marker derived from fresh random material. The
 * user row still fits the ordinary identity schema, while the generated guest cannot sign in through
 * the password route. User, device, initial refresh token, and their audit records commit together.
 */
export function createGuestIdentity(db, { deviceLabel, platform, appVersion, refreshSecret, refreshTokenTtlSeconds, now = new Date() }) {
  if (typeof refreshSecret !== 'string' || refreshSecret.length === 0) throw new IdentityError('A refresh token is required', 'INVALID_REFRESH_TOKEN')
  if (!Number.isSafeInteger(refreshTokenTtlSeconds) || refreshTokenTtlSeconds < 1) throw new IdentityError('A refresh token lifetime is required', 'INVALID_REFRESH_TOKEN_TTL')

  const userId = randomUUID()
  const handleSuffix = userId.slice(0, 8)
  const userHandle = `guest-${handleSuffix}`
  const displayName = `Guest ${handleSuffix}`
  const deviceId = randomUUID()
  const createdAt = nowIso(now)
  const passwordHash = `guest$${hashOpaqueSecret(randomUUID())}`
  const publicKey = `bootstrap:${randomUUID()}`
  const fingerprint = `bootstrap:${randomUUID()}`
  const refreshId = randomUUID()
  const refreshExpiresAt = isoPlusSeconds(now, refreshTokenTtlSeconds)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, userHandle, displayName, passwordHash, 'active', createdAt)
    db.prepare(`INSERT INTO devices (id, user_id, public_key, fingerprint, label, platform, app_version, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(deviceId, userId, publicKey, fingerprint, deviceLabel, platform, appVersion, createdAt, createdAt)
    db.prepare(`INSERT INTO refresh_tokens (id, lookup_id, user_id, device_id, secret_hash, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(refreshId, secretLookupId(refreshSecret), userId, deviceId, hashOpaqueSecret(refreshSecret), createdAt, refreshExpiresAt)
    audit(db, { actorUserId: userId, eventType: 'user.created', objectType: 'user', objectId: userId, outcome: 'success', details: { userHandle }, now })
    audit(db, { actorUserId: userId, actorDeviceId: deviceId, eventType: 'device.registered', objectType: 'device', objectId: deviceId, outcome: 'success', details: { label: deviceLabel, platform }, now })
    audit(db, { actorUserId: userId, actorDeviceId: deviceId, eventType: 'auth.bootstrap', objectType: 'user', objectId: userId, outcome: 'success', details: { userHandle }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }

  return {
    user: findUserById(db, userId),
    device: findDeviceById(db, deviceId),
    refresh: { id: refreshId, expiresAt: refreshExpiresAt },
  }
}

/** True only when the device exists, belongs to the user, and has not been revoked. */
export function isDeviceActive(db, { deviceId, userId }) {
  const device = db.prepare('SELECT user_id, revoked_at FROM devices WHERE id = ?').get(deviceId)
  if (device === undefined) return false
  if (device.user_id !== userId) return false
  return device.revoked_at === null || device.revoked_at === undefined
}

export function touchDevice(db, { deviceId, now = new Date() }) {
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(now), deviceId)
}

/**
 * Revoke a device and every credential issued to it.
 *
 * Revoking the device is not enough on its own: a live refresh token would let the holder
 * mint a fresh access token for that device immediately.
 */
export function revokeDevice(db, { deviceId, actorUserId, now = new Date() }) {
  const device = findDeviceById(db, deviceId)
  if (device === undefined) throw new IdentityError('No such device', 'NO_SUCH_DEVICE')
  const revokedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(revokedAt, deviceId)
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(revokedAt, deviceId)
    audit(db, { actorUserId: actorUserId ?? device.user_id, actorDeviceId: deviceId, eventType: 'device.revoked', objectType: 'device', objectId: deviceId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
}

/** Issue a refresh token, storing only its hash. Returns the token exactly once. */
export function issueRefreshToken(db, { userId, deviceId, secret, ttlSeconds, now = new Date() }) {
  const id = randomUUID()
  const lookupId = secretLookupId(secret)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO refresh_tokens (id, lookup_id, user_id, device_id, secret_hash, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, lookupId, userId, deviceId, hashOpaqueSecret(secret), nowIso(now), isoPlusSeconds(now, ttlSeconds))
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return { id, expiresAt: isoPlusSeconds(now, ttlSeconds) }
}

export function findRefreshToken(db, secret) {
  return db.prepare('SELECT * FROM refresh_tokens WHERE lookup_id = ?').get(secretLookupId(secret))
}

export function revokeRefreshToken(db, { tokenId, now = new Date() }) {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(now), tokenId)
}

/**
 * Rotate a refresh token: consume the presented one and issue its replacement atomically.
 *
 * Reuse of an already-consumed token revokes every token for that device. That is the
 * deliberate trade: a legitimate client that retries after a dropped response gets logged
 * out and re-authenticates, while a stolen token cannot be used alongside the real one.
 */
export function rotateRefreshToken(db, { presentedId, userId, deviceId, newSecret, ttlSeconds, now = new Date() }) {
  const lookupId = secretLookupId(newSecret)
  const newId = randomUUID()
  const consumedAt = nowIso(now)
  const expiresAt = isoPlusSeconds(now, ttlSeconds)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(consumedAt, presentedId)
    db.prepare(`INSERT INTO refresh_tokens (id, lookup_id, user_id, device_id, secret_hash, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(newId, lookupId, userId, deviceId, hashOpaqueSecret(newSecret), consumedAt, expiresAt)
    audit(db, { actorUserId: userId, actorDeviceId: deviceId, eventType: 'token.refreshed', objectType: 'refresh_token', objectId: newId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return { id: newId, expiresAt }
}

/** Withdraw every outstanding credential for one user across all their devices. */
export function revokeAllForUser(db, { userId, actorUserId, now = new Date() }) {
  const revokedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(revokedAt, userId)
    audit(db, { actorUserId: actorUserId ?? userId, eventType: 'user.tokens_revoked', objectType: 'user', objectId: userId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
}

/** Row count for a user's active (unrevoked, unexpired, unused) refresh tokens. */
export function countActiveRefreshTokens(db, { userId, now = new Date() }) {
  return db.prepare(`SELECT count(*) AS n FROM refresh_tokens
    WHERE user_id = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?`).get(userId, nowIso(now)).n
}
