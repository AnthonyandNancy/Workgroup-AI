// Password hashing for Hub accounts.
//
// scrypt is used through Node's built-in crypto rather than a native bcrypt/argon2 addon:
// the Hub must install from `server/` alone on a clean Linux host, and a package that needs
// a compiler toolchain is a deployment risk the project does not need to take. scrypt is
// memory-hard and is a supported password-hashing choice.
//
// Parameters are stored inside each hash string, so raising the cost later does not
// invalidate existing passwords: old hashes keep verifying with their own parameters and
// are re-hashed on the next successful login (see `needsRehash`).

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

const SCHEME = 'scrypt'
const CURRENT = Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 64 })
const SALT_BYTES = 16
// scrypt needs roughly 128 * N * r bytes; the Node default `maxmem` is 32 MiB, which
// 16384 * 8 * 128 = 16 MiB fits. The ceiling is stated explicitly so a future cost bump
// fails loudly here instead of at run time.
const MAX_MEM = 64 * 1024 * 1024

export class PasswordPolicyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PasswordPolicyError'
  }
}

/**
 * Minimum password policy.
 *
 * Length is the requirement that actually raises the cost of guessing; composition rules
 * (a digit, a symbol) are deliberately not imposed, since they push users toward
 * predictable substitutions without adding entropy.
 */
export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 512

export function assertPasswordAcceptable(password) {
  if (typeof password !== 'string') throw new PasswordPolicyError('Password must be a string')
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  // An upper bound stops an attacker turning login into a memory-exhaustion lever, which
  // is the one real cost of an unconstrained input to a memory-hard KDF.
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
  // A password made only of whitespace is almost certainly a mistake, and it is the kind
  // that survives the length check above.
  if (password.trim().length === 0) throw new PasswordPolicyError('Password must not be only whitespace')
}

/**
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$saltB64$hashB64`
 */
export async function hashPassword(password) {
  assertPasswordAcceptable(password)
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, CURRENT.keyLen, { N: CURRENT.N, r: CURRENT.r, p: CURRENT.p, maxmem: MAX_MEM })
  return [SCHEME, CURRENT.N, CURRENT.r, CURRENT.p, salt.toString('base64'), derived.toString('base64')].join('$')
}

/** Parse a stored hash. Returns undefined instead of throwing, so callers can fail closed. */
export function parsePasswordHash(stored) {
  if (typeof stored !== 'string') return undefined
  const parts = stored.split('$')
  if (parts.length !== 6) return undefined
  const [scheme, n, r, p, saltB64, hashB64] = parts
  if (scheme !== SCHEME) return undefined
  const N = Number(n)
  const rr = Number(r)
  const pp = Number(p)
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(rr) || !Number.isSafeInteger(pp)) return undefined
  if (N <= 1 || rr <= 0 || pp <= 0) return undefined
  let salt
  let hash
  try {
    salt = Buffer.from(saltB64, 'base64')
    hash = Buffer.from(hashB64, 'base64')
  } catch {
    return undefined
  }
  if (salt.length === 0 || hash.length === 0) return undefined
  return { N, r: rr, p: pp, salt, hash }
}

/**
 * Verify a password against a stored hash.
 *
 * The comparison is constant-time. A malformed stored hash returns false rather than
 * throwing, because a corrupt row must fail the login, not crash the request.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string') return false
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return false
  // Refuse absurd parameters rather than honouring a row that was tampered with into a
  // memory-exhaustion attack; the bounds match what `hashPassword` can produce today.
  if (parsed.N > 1 << 22 || parsed.r > 32 || parsed.p > 16 || parsed.hash.length > 1024) return false
  let derived
  try {
    derived = await scrypt(password, parsed.salt, parsed.hash.length, { N: parsed.N, r: parsed.r, p: parsed.p, maxmem: MAX_MEM })
  } catch {
    return false
  }
  if (derived.length !== parsed.hash.length) return false
  return timingSafeEqual(derived, parsed.hash)
}

/** True when a stored hash was made with weaker parameters than this release uses. */
export function needsRehash(stored) {
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return true
  return parsed.N < CURRENT.N || parsed.r < CURRENT.r || parsed.p < CURRENT.p || parsed.hash.length < CURRENT.keyLen
}

export const passwordInternals = { CURRENT, SALT_BYTES }
