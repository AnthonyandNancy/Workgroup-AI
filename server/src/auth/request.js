// Request authentication shared by every protected route.
//
// This lives outside the identity routes because each resource module needs the same
// answer to "who is calling, and through which device". Keeping it in one place means a
// change to the rule — for example adding a token-version check — reaches every route at
// once instead of only the module whose author remembered.

import { bearerTokenFrom, verifyAccessToken, TokenError } from './tokens.js'
import { findUserById, isDeviceActive } from './store.js'

/**
 * Resolve the caller of a request.
 *
 * The device check happens after the signature check on purpose: an access token stays
 * cryptographically valid for its whole lifetime, so revoking a device must be enforced
 * here, on every request, rather than being waited out.
 *
 * @param {{ config: object, db: object }} deps
 * @returns {(request: object) => { user: object, deviceId: string, payload: object }}
 * @throws {TokenError} when the request carries no usable credential
 */
export function makeAuthenticator({ config, db }) {
  return function authenticate(request) {
    const token = bearerTokenFrom(request.headers)
    if (token === undefined) throw new TokenError('An access token is required', 'MISSING_TOKEN')
    // Verified against the keyring rather than one key: while a rotation is in progress the Hub
    // must accept tokens signed with either the new key or the previous one, or every user is
    // logged out at the moment the operator changes the signing key. A single-key deployment
    // yields a keyring of one, so this is the same code path either way.
    const payload = verifyAccessToken(token, { keyring: config.tokenKeyring, signingKey: config.readTokenSigningKey() })
    const user = findUserById(db, payload.sub)
    // A token for a user who no longer exists is not a valid token, whatever its signature.
    if (user === undefined) throw new TokenError('The token names an unknown user', 'UNKNOWN_USER')
    if (user.status !== 'active') throw new TokenError('This account is disabled', 'ACCOUNT_DISABLED')
    if (!isDeviceActive(db, { deviceId: payload.did, userId: user.id })) {
      throw new TokenError('This device has been revoked', 'DEVICE_REVOKED')
    }
    return { user, deviceId: payload.did, payload }
  }
}

/** Map an authentication failure to a response without disclosing which half failed. */
export function authenticationFailure(reply, error) {
  if (error instanceof TokenError) {
    const status = error.code === 'ACCOUNT_DISABLED' || error.code === 'DEVICE_REVOKED' ? 403 : 401
    return reply.code(status).send({ error: { code: error.code, message: error.message } })
  }
  throw error
}

/**
 * Build the Fastify `preHandler` a protected route attaches.
 *
 * The resolved caller lands on `request.auth`, which route handlers read.
 */
export function makeRequireAuth({ config, db }) {
  const authenticate = makeAuthenticator({ config, db })
  return async function requireAuth(request, reply) {
    try {
      request.auth = authenticate(request)
    } catch (error) {
      return authenticationFailure(reply, error)
    }
    return undefined
  }
}

/** A plain refusal used when the caller is known but not allowed to do the thing. */
export function forbidden(reply, code, message) {
  return reply.code(403).send({ error: { code, message } })
}

export function notFound(reply, code, message) {
  return reply.code(404).send({ error: { code, message } })
}
