// Hub tokens: signed access tokens, opaque refresh tokens, and per-device API keys.
//
// Three distinct credentials, because the Hub needs three different lifetimes and
// revocation properties:
//
//   access  — a short-lived HMAC-signed token. Verified without a database read, so a
//             busy Hub does not query on every request. Carries the user and device it
//             was issued to; revoking a device therefore takes effect when the token
//             expires, which is why its lifetime is minutes, not days.
//   refresh — an opaque random string stored only as a SHA-256 hash. Database-backed, so
//             it can be revoked immediately, and rotation on use makes a stolen refresh
//             token detectably single-use.
//   device  — an opaque random key stored only as a hash, scoped to one device. This is
//             what ties a claim to a specific machine.
//
// Nothing here trusts a client-supplied `alg`, user id, or device id: the access token
// payload is authenticated by the MAC, and the kid names the key version in use so a
// signing key can be rotated without invalidating every outstanding token at once.
//
// Rotation is the reason `kid` is a field rather than a constant. The Hub holds a *keyring*:
// one current key that signs, plus any number of older keys that still verify. Rotating is a
// configuration change followed by a wait of one access-token lifetime, so there is never a
// window in which a user holds a token the Hub refuses to accept. H-03 reserved the field and
// recorded the gap; H-13 supplies the keyring that reads it.

import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto'

const ACCESS_PREFIX = 'wg1'
/** The kid used when a deployment configures a single signing key. */
export const ACCESS_TOKEN_KID = 'k1'
/** A kid is a short opaque label. It is inside the MAC, so it cannot be moved to another key. */
const KID_PATTERN = /^k[0-9a-z]{1,15}$/
const REFRESH_BYTES = 32
const DEVICE_KEY_BYTES = 32

export class TokenError extends Error {
  constructor(message, code = 'INVALID_TOKEN') {
    super(message)
    this.name = 'TokenError'
    this.code = code
  }
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function fromBase64url(value) {
  return Buffer.from(value, 'base64url')
}

/** A URL-safe, high-entropy opaque secret. */
export function generateOpaqueSecret(bytes = REFRESH_BYTES) {
  return base64url(randomBytes(bytes))
}

export function generateDeviceKey() {
  return `wgdev_${base64url(randomBytes(DEVICE_KEY_BYTES))}`
}

export function generateRefreshToken() {
  return `wgref_${base64url(randomBytes(REFRESH_BYTES))}`
}

/**
 * Hash a secret for storage. The Hub never stores a usable refresh or device credential,
 * so a database leak does not hand over live sessions.
 *
 * A plain SHA-256 (not a password KDF) is right here: these are 256-bit random values, so
 * there is no dictionary to attack and the Hub must be able to look one up by hash.
 */
export function hashOpaqueSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex')
}

/** Lookup key for an opaque secret, so the Hub can find the row without scanning. */
export function secretLookupId(secret) {
  // A short, non-secret prefix used only to narrow the query. It leaks 64 bits of a
  // 256-bit value, which does not help an attacker guess the rest.
  return createHash('sha256').update(String(secret), 'utf8').digest('hex').slice(0, 16)
}

/**
 * A set of signing keys, one of which is current.
 *
 * The Hub signs with `currentKid` and verifies with any key it still holds. That asymmetry is
 * what makes rotation a non-event for users: change the configured key, keep the old one
 * listed, and every token issued before the change keeps working until it expires on its own.
 *
 * A kid that is not in the keyring is refused (`UNKNOWN_KEY_ID`) rather than tried against the
 * current key: falling back to the current key would make a rotation look like it worked while
 * every old token silently started failing one request later.
 */
export class TokenKeyring {
  /**
   * @param {{ currentKid?: string, keys: Map<string, string> | Record<string, string> }} options
   */
  constructor({ currentKid = ACCESS_TOKEN_KID, keys }) {
    const entries = keys instanceof Map ? [...keys.entries()] : Object.entries(keys ?? {})
    if (entries.length === 0) throw new Error('A token keyring needs at least one key')
    /** @type {Map<string, string>} */
    this.keys = new Map()
    for (const [kid, key] of entries) {
      if (!KID_PATTERN.test(kid)) throw new Error(`Token key id ${JSON.stringify(kid)} must look like k1, k2, krot2024`)
      if (typeof key !== 'string' || key.length === 0) throw new Error(`Token key ${kid} has no material`)
      this.keys.set(kid, key)
    }
    if (!this.keys.has(currentKid)) throw new Error(`The current token key id ${currentKid} is not in the keyring`)
    this.currentKid = currentKid
  }

  /** The key new tokens are signed with. */
  get current() {
    return this.keys.get(this.currentKid)
  }

  /** The key a token names, or undefined when this Hub does not hold it. */
  keyFor(kid) {
    return this.keys.get(kid)
  }

  get kids() {
    return [...this.keys.keys()]
  }
}

/**
 * Build the keyring from configuration.
 *
 * `HUB_TOKEN_SIGNING_KEY` is the current key; `HUB_TOKEN_SIGNING_KEY_PREVIOUS` is an optional
 * comma-separated `kid:key` list of keys that may still verify. The format is explicit about the
 * kid because the operator must be able to say which key an outstanding token was signed with,
 * and deriving it from position would break the moment two rotations overlap.
 *
 * A rotation therefore needs the current key to have a *different* kid from every previous key.
 * That is why `currentKid` is settable: rotating from `k1` to `k1` would silently overwrite the
 * old key with the new one, and every outstanding token would start failing — the exact outage
 * this code exists to prevent. The collision is refused at start-up rather than discovered by
 * users.
 *
 * @param {{ tokenSigningKey?: string, currentKid?: string, previousKeys?: Map<string, string> }} input
 * @returns {TokenKeyring | undefined} undefined when no key is configured (tests and local runs)
 */
export function keyringFromConfig({ tokenSigningKey, currentKid = ACCESS_TOKEN_KID, previousKeys }) {
  if (tokenSigningKey === undefined) return undefined
  const keys = new Map(previousKeys ?? [])
  if (keys.has(currentKid)) {
    throw new Error(
      `HUB_TOKEN_SIGNING_KEY is configured as ${currentKid}, which HUB_TOKEN_SIGNING_KEY_PREVIOUS also holds. ` +
      'Rotating a key requires a new key id: set HUB_TOKEN_SIGNING_KEY_CURRENT_KID so the old key stays verifiable.',
    )
  }
  keys.set(currentKid, tokenSigningKey)
  return new TokenKeyring({ currentKid, keys })
}

/**
 * Parse `kid:key,kid:key` into a key map.
 *
 * A malformed entry is a configuration error the operator must see, not a silently dropped key:
 * a dropped previous key means users are locked out with no diagnostic that says why.
 *
 * @param {string | undefined} raw
 * @returns {Map<string, string>}
 */
export function parsePreviousKeys(raw) {
  const keys = new Map()
  if (raw === undefined) return keys
  for (const entry of String(raw).split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const separator = trimmed.indexOf(':')
    if (separator < 1) throw new Error(`Each HUB_TOKEN_SIGNING_KEY_PREVIOUS entry must be kid:key, got ${JSON.stringify(trimmed.slice(0, 24))}`)
    const kid = trimmed.slice(0, separator)
    const key = trimmed.slice(separator + 1)
    if (!KID_PATTERN.test(kid)) throw new Error(`Previous token key id ${JSON.stringify(kid)} must look like k1, k2, krot2024`)
    if (key.length < 32) throw new Error(`Previous token key ${kid} must be at least 32 characters`)
    keys.set(kid, key)
  }
  return keys
}

function sign(signingKey, kid, payloadPart) {
  return createHmac('sha256', signingKey).update(`${ACCESS_PREFIX}.${kid}.${payloadPart}`).digest()
}

/**
 * Issue a short-lived access token.
 *
 * @param {{ signingKey?: string, keyring?: TokenKeyring, userId: string, deviceId: string, ttlSeconds: number, now?: Date, sessionId?: string }} options
 */
export function issueAccessToken(options) {
  const { signingKey, keyring, userId, deviceId, ttlSeconds, now = new Date(), sessionId } = options
  const kid = keyring?.currentKid ?? ACCESS_TOKEN_KID
  const key = keyring?.current ?? signingKey
  if (typeof key !== 'string' || key.length === 0) throw new Error('No token signing key is configured')
  const issuedAt = Math.floor(now.getTime() / 1000)
  const payload = {
    sub: userId,
    did: deviceId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: randomUUID(),
  }
  // A session id is optional because most Hub routes authorize by user and device; it
  // exists for flows that must pin a token to one collaboration session.
  if (sessionId !== undefined) payload.sid = sessionId
  const payloadPart = base64url(JSON.stringify(payload))
  return `${ACCESS_PREFIX}.${kid}.${payloadPart}.${base64url(sign(key, kid, payloadPart))}`
}

/**
 * Verify an access token's structure, MAC, and time window.
 *
 * Returns the payload, or throws with a code the caller maps to a response. The caller is
 * still responsible for checking that the device has not been revoked since issue.
 *
 * `keyring` verifies against whichever key the token names; `signingKey` is the single-key form
 * that still only accepts `k1`. Passing neither is a programming error, not a token error.
 */
export function verifyAccessToken(token, { signingKey, keyring, now = new Date(), clockSkewSeconds = 30 } = {}) {
  if (typeof token !== 'string') throw new TokenError('A token is required', 'MISSING_TOKEN')
  const parts = token.split('.')
  if (parts.length !== 4) throw new TokenError('The token is malformed', 'MALFORMED_TOKEN')
  const [prefix, kid, payloadPart, macPart] = parts
  if (prefix !== ACCESS_PREFIX) throw new TokenError('The token is not a Workgroup AI access token', 'MALFORMED_TOKEN')

  let key
  if (keyring !== undefined) {
    key = keyring.keyFor(kid)
    if (key === undefined) throw new TokenError(`Unknown token key id ${kid}`, 'UNKNOWN_KEY_ID')
  } else {
    if (kid !== ACCESS_TOKEN_KID) throw new TokenError(`Unknown token key id ${kid}`, 'UNKNOWN_KEY_ID')
    key = signingKey
  }
  if (typeof key !== 'string' || key.length === 0) throw new Error('No token signing key is configured')

  const expectedMac = sign(key, kid, payloadPart)
  let actualMac
  try {
    actualMac = fromBase64url(macPart)
  } catch {
    throw new TokenError('The token signature is malformed', 'MALFORMED_TOKEN')
  }
  if (expectedMac.length !== actualMac.length || !timingSafeEqual(expectedMac, actualMac)) {
    // One message for any MAC failure: distinguishing "wrong signature" from "wrong key"
    // tells an attacker which part to work on.
    throw new TokenError('The token signature is not valid', 'BAD_SIGNATURE')
  }

  let payload
  try {
    payload = JSON.parse(fromBase64url(payloadPart).toString('utf8'))
  } catch {
    throw new TokenError('The token payload is not readable', 'MALFORMED_TOKEN')
  }
  if (payload === null || typeof payload !== 'object') throw new TokenError('The token payload is not an object', 'MALFORMED_TOKEN')
  for (const field of ['sub', 'did', 'iat', 'exp', 'jti']) {
    if (typeof payload[field] !== 'string' && typeof payload[field] !== 'number') {
      throw new TokenError(`The token payload is missing ${field}`, 'MALFORMED_TOKEN')
    }
  }
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (nowSeconds > Number(payload.exp) + clockSkewSeconds) throw new TokenError('The token has expired', 'TOKEN_EXPIRED')
  // A token whose `iat` is far in the future is a clock problem or a forgery attempt; the
  // skew allowance keeps normal drift working.
  if (Number(payload.iat) > nowSeconds + clockSkewSeconds) throw new TokenError('The token was issued in the future', 'TOKEN_NOT_YET_VALID')
  return payload
}

/** Read the `Authorization: Bearer <token>` header, or undefined when absent. */
export function bearerTokenFrom(headers) {
  const raw = headers?.authorization ?? headers?.Authorization
  if (typeof raw !== 'string') return undefined
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim())
  return match === null ? undefined : match[1].trim()
}

export function accessTokenTtlSecondsFor(config) {
  return config.tokens.accessTokenTtlSeconds
}
