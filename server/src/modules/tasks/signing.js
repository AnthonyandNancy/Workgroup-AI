// Asymmetric signing for dispatch grants.
//
// Why asymmetric at all, when the Hub already signs its access tokens with HMAC: those tokens are
// verified by the Hub itself, so one shared key is enough. A dispatch grant is different — it is
// verified on **the owner's machine**, which is not the machine that issued it. With HMAC that
// machine would need the same secret the Hub signs with, so every participating desktop would hold a
// key that can mint any grant for any task. A signature the verifier cannot produce is the whole
// point, and Ed25519 is the cheapest way to get one: no parameters to choose, no padding to get
// wrong, and a 64-byte signature that fits in an HTTP body.
//
// What this does **not** replace: the nonce. The two answer different questions and both are checked.
// This module only answers "did the Hub issue exactly this, unmodified?"; `grants.js` answers "is
// this the first presentation?". Removing the nonce in favour of the signature would make a captured
// grant replayable, because a valid signature stays valid.
//
// Rotation works the way the token keyring already works: keys are addressed by id, the current id
// signs, and older ids may still verify. A machine that has cached a public key keeps verifying
// during a rollout instead of failing closed on a key it has never seen.
//
// The private key never leaves this process: it is read from configuration into a `KeyObject` and is
// never returned by any exported function.

import { createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto'

/** The payload fields a grant signature covers. One list, so signing and verifying cannot disagree. */
export const SIGNED_GRANT_FIELDS = Object.freeze(['grantId', 'taskId', 'botId', 'expiresAt'])

export class SigningError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SigningError'
    this.code = code
  }
}

/**
 * The exact bytes a signature covers.
 *
 * The fields are written in a fixed order and with an explicit separator rather than as
 * `JSON.stringify` of the object: key order in a JSON object is not guaranteed across
 * serializations, so an object-based encoding would produce different bytes for the same grant and
 * refuse legitimate dispatches. `\n` cannot appear in a grant id, task id, Bot id, or ISO timestamp,
 * so it is unambiguous as a separator.
 *
 * A field that is absent is written as an empty string rather than omitted, so `{ taskId: 't' }` and
 * `{ taskId: 't', botId: undefined }` cannot collide.
 *
 * @param payload - the grant fields to cover.
 * @returns the bytes to sign.
 */
export function grantSigningBytes(payload) {
  return Buffer.from(SIGNED_GRANT_FIELDS.map(field => String(payload?.[field] ?? '')).join('\n'), 'utf8')
}

/**
 * Build a signer from a configured private key.
 *
 * @param {{ privateKey: string | object, keyId?: string }} options - `privateKey` is PKCS#8 PEM or a
 *   `KeyObject`; it is never echoed anywhere.
 * @returns `{ sign(payload): { signature, keyId }, keyId }` where `signature` is base64.
 */
export function createGrantSigner({ privateKey, keyId = 'k1' }) {
  if (privateKey === undefined || privateKey === null) {
    throw new SigningError('A grant signer needs a private key', 'NO_PRIVATE_KEY')
  }
  if (typeof keyId !== 'string' || keyId === '') {
    throw new SigningError('A grant signer needs a key id, so a verifier knows which key to use', 'NO_KEY_ID')
  }
  // A PEM string is parsed; an already-parsed `KeyObject` is used as it is, because
  // `createPrivateKey` refuses a KeyObject rather than accepting it back.
  const key = isKeyObject(privateKey) ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new SigningError(`A grant signing key must be Ed25519, got ${String(key.asymmetricKeyType)}`, 'WRONG_KEY_TYPE')
  }
  return {
    keyId,
    sign(payload) {
      const signature = signBytes(null, grantSigningBytes(payload), key)
      return { signature: signature.toString('base64'), keyId }
    },
  }
}

/** Whether a value is already a parsed key, which `createPrivateKey`/`createPublicKey` reject. */
function isKeyObject(value) {
  return typeof value === 'object' && value !== null && typeof value.export === 'function' && typeof value.asymmetricKeyType === 'string'
}

/**
 * Build the signing key set a Hub runs with.
 *
 * Keys are addressed by id so rotation is possible without a flag day: the current id signs, and ids
 * listed here may still verify. That matters because a machine that cached a public key during a
 * rollout must keep accepting dispatches signed by a key it already knows.
 *
 * `previous` is a map of `id -> public PEM` — verification only. It deliberately cannot sign, so
 * listing a retired key does not keep minting grants under it.
 *
 * @param {{ privateKey?: string | object, keyId?: string, previous?: Record<string, string> }} options
 * @returns `undefined` when no private key is configured, otherwise:
 *   `{ keyId, signer, publicKeys: Map<string, string> }` with PEM public keys for publication.
 */
export function createSigningKeySet({ privateKey, keyId = 'k1', previous = {} } = {}) {
  if (privateKey === undefined || privateKey === null) return undefined
  const parsed = isKeyObject(privateKey) ? privateKey : createPrivateKey(privateKey)
  if (parsed.asymmetricKeyType !== 'ed25519') {
    throw new SigningError(`A grant signing key must be Ed25519, got ${String(parsed.asymmetricKeyType)}`, 'WRONG_KEY_TYPE')
  }
  if (Object.prototype.hasOwnProperty.call(previous, keyId)) {
    throw new SigningError(`The signing key id ${keyId} is also listed as a previous key; a rotation needs a new id`, 'DUPLICATE_KEY_ID')
  }
  const publicKeys = new Map()
  publicKeys.set(keyId, createPublicKey(parsed).export({ type: 'spki', format: 'pem' }))
  for (const [id, pem] of Object.entries(previous)) publicKeys.set(id, isKeyObject(pem) ? createPublicKey(pem).export({ type: 'spki', format: 'pem' }) : pem)
  return { keyId, signer: createGrantSigner({ privateKey: parsed, keyId }), publicKeys }
}

/**
 * Verify a grant signature against a published key set.
 *
 * @param {{ payload: object, signature?: string, keyId?: string }} presented - what the caller holds.
 * @param {{ keys: Map<string, string | object> | Record<string, string | object> }} options - the
 *   verifier's key set, keyed by key id. A key may be a PEM string or a `KeyObject`.
 * @returns `{ valid: true }` or `{ valid: false, reason }`. Never throws for bad input: a malformed
 *   signature is a refusal, not an exception, because the caller has to answer the dispatch either
 *   way and an exception is easy to mishandle into a crash on hostile input.
 */
export function verifyGrantSignature(presented, { keys } = {}) {
  const keyId = presented?.keyId
  if (typeof keyId !== 'string' || keyId === '') return { valid: false, reason: 'the grant names no signing key' }
  if (typeof presented?.signature !== 'string' || presented.signature === '') return { valid: false, reason: 'the grant carries no signature' }

  const lookup = keys instanceof Map ? keys : new Map(Object.entries(keys ?? {}))
  if (lookup.size === 0) return { valid: false, reason: 'no signing keys are configured to verify against' }
  const material = lookup.get(keyId)
  // An unknown id is refused rather than tried against every key: trying them all turns a key
  // rotation into a slower check, and it would accept a signature under a key the Hub retired.
  if (material === undefined) return { valid: false, reason: `the grant names signing key ${keyId}, which is not published` }

  try {
    const publicKey = isKeyObject(material) ? material : createPublicKey(material)
    let signature
    try {
      signature = Buffer.from(presented.signature, 'base64')
    } catch (error) {
      return { valid: false, reason: `the signature is not valid base64 (${error.message})` }
    }
    // `verify` returns a boolean for Ed25519 and throws only for a malformed key, which is why both
    // are handled rather than only the false case.
    const ok = verifyBytes(null, grantSigningBytes(presented.payload), publicKey, signature)
    return ok ? { valid: true } : { valid: false, reason: 'the signature does not match the grant it covers' }
  } catch (error) {
    return { valid: false, reason: `the signature could not be checked (${error.message})` }
  }
}
