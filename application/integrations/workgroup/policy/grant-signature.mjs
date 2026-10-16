// Verifying a dispatch grant's signature, on the owner's machine.
//
// The Hub signs with an Ed25519 key (`server/src/modules/tasks/signing.js`) and publishes the public
// half at `GET /dispatch/keys`. This module is the other half: the check the executor runs before it
// presents a nonce, so a forged frame is refused locally rather than being caught only because the
// Hub happened to say no.
//
// The encoding must match the Hub's byte for byte, or every legitimate dispatch fails. That encoding
// is therefore not described twice: it is fixed here as a field order and a separator, and the Hub's
// module documents the same rule. `grantSigningBytes` is exported so the Hub's suite can pin the two
// implementations to the same bytes rather than trusting that they agree.
//
// `node:crypto` is the only dependency: this ships inside the application, which must not import
// anything from `server/`, and the verification itself is a single `verify` call.

import { createPublicKey, verify as verifyBytes } from 'node:crypto'

/** The payload fields a grant signature covers, in the order they are joined. */
export const SIGNED_GRANT_FIELDS = Object.freeze(['grantId', 'taskId', 'botId', 'expiresAt'])

/**
 * The exact bytes a signature covers.
 *
 * A fixed order joined by `\n` rather than `JSON.stringify` of the object: key order in a JSON object
 * is not guaranteed across serializations, so an object-based encoding could produce different bytes
 * for the same grant and refuse legitimate dispatches. None of the four fields can contain a newline,
 * so the separator is unambiguous. An absent field is written as an empty string rather than omitted,
 * so two different grants cannot encode to the same bytes.
 *
 * @param payload - the grant fields.
 * @returns the bytes that were signed.
 */
export function grantSigningBytes(payload) {
  return Buffer.from(SIGNED_GRANT_FIELDS.map(field => String(payload?.[field] ?? '')).join('\n'), 'utf8')
}

/**
 * Verify one grant's signature against a published key set.
 *
 * @param {{ grant: object }} input - the grant as it arrived, carrying `signature` and `keyId`.
 * @param {{ keys: Map<string, string | object> | Record<string, string | object> }} options - public
 *   keys by id, as PEM strings or `KeyObject`s.
 * @returns `{ valid: true }`, or `{ valid: false, reason }`. Never throws for malformed input: a bad
 *   signature is a refusal the caller reports, not an exception, because hostile frames are exactly
 *   what this function is expected to see.
 */
export function verifyGrantSignature({ grant }, { keys } = {}) {
  const keyId = grant?.keyId
  if (typeof keyId !== 'string' || keyId === '') return { valid: false, reason: 'the grant names no signing key' }
  if (typeof grant?.signature !== 'string' || grant.signature === '') return { valid: false, reason: 'the grant carries no signature' }

  const lookup = keys instanceof Map ? keys : new Map(Object.entries(keys ?? {}))
  if (lookup.size === 0) return { valid: false, reason: 'no signing keys are known, so nothing can be verified' }
  // An unknown id is refused rather than tried against every key: trying them all would accept a
  // signature made under a key the Hub retired, and it turns rotation into a slower check.
  const material = lookup.get(keyId)
  if (material === undefined) return { valid: false, reason: `the grant names signing key ${keyId}, which is not published` }

  try {
    const publicKey = isKeyObject(material) ? material : createPublicKey(material)
    const ok = verifyBytes(null, grantSigningBytes({ grantId: grant.id, taskId: grant.taskId, botId: grant.botId, expiresAt: grant.expiresAt }), publicKey, Buffer.from(grant.signature, 'base64'))
    return ok ? { valid: true } : { valid: false, reason: 'the signature does not match the grant it covers' }
  } catch (error) {
    return { valid: false, reason: `the signature could not be checked (${error.message})` }
  }
}

/** Whether a value is already a parsed key, which `createPublicKey` rejects rather than accepts back. */
function isKeyObject(value) {
  return typeof value === 'object' && value !== null && typeof value.export === 'function' && typeof value.asymmetricKeyType === 'string'
}
