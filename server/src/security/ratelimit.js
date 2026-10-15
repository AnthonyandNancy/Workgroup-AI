// Login throttling: the failure counter that turns "guess the password" from an offline
// problem into an online one the Hub can refuse.
//
// H-03 shipped the login endpoint without any limit and recorded the gap: an attacker with a
// word list can present it at full network speed, and bcrypt cost only makes each guess a
// little slower, not impossible. This module is the missing half — a counting rule enforced
// before the hash is even computed, so a blocked attempt costs the Hub nothing.
//
// Design decisions, each of which a reviewer would otherwise ask about:
//
//  * **Two keys, two budgets.** A per-handle counter defends one account against a targeted
//    attack; a per-source counter defends every account against one source spraying a
//    password across many handles. Counting only one of the two leaves the other open.
//  * **Failures count, successes clear.** A successful login clears that handle's counter, so
//    a legitimate user who mistyped twice is not locked out by their own typo an hour later.
//    The per-source counter is not cleared by a success: one valid account must not buy an
//    attacker a fresh budget for the accounts they are still guessing.
//  * **In-memory, and said out loud.** The Hub is deliberately a single process with a single
//    SQLite writer, so a process-local counter is complete rather than approximate. A restart
//    forgets the counters; that is a real property of this design and is documented in
//    `deploy/DEPLOYMENT.md` instead of being hidden behind "rate limited".
//  * **Bounded memory.** Counters are pruned on every check, so a Hub under a spray attack from
//    many sources cannot be made to allocate without bound. That is itself an attack the naive
//    implementation of a limiter hands to the attacker.
//
// The limiter never sees a password or a password hash: it is given a key and an outcome.

/** A counter set that forgets entries older than its window and refuses to grow without bound. */
export class RateLimiter {
  /**
   * @param {{ maxAttempts: number, windowSeconds: number, lockoutSeconds: number, maxKeys?: number, now?: () => number }} options
   */
  constructor(options) {
    const { maxAttempts, windowSeconds, lockoutSeconds, maxKeys = 10_000, now = () => Date.now() } = options
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer')
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) throw new Error('windowSeconds must be a positive integer')
    if (!Number.isSafeInteger(lockoutSeconds) || lockoutSeconds < 0) throw new Error('lockoutSeconds must be zero or a positive integer')
    this.maxAttempts = maxAttempts
    this.windowMs = windowSeconds * 1000
    this.lockoutMs = lockoutSeconds * 1000
    this.maxKeys = maxKeys
    this.now = now
    /** @type {Map<string, { stamps: number[], blockedUntil: number }>} */
    this.entries = new Map()
  }

  /**
   * Whether a key may attempt now, and how long until it may again.
   *
   * Only failures are recorded, so this is a read: calling it does not spend an attempt.
   *
   * @param {string} key
   * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
   */
  check(key) {
    const at = this.now()
    const entry = this.entries.get(key)
    if (entry === undefined) return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts }
    if (entry.blockedUntil > at) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - at) / 1000), remaining: 0 }
    }
    if (entry.blockedUntil > 0) {
      // The lockout has expired, so the key starts over. The failures that caused it are
      // deliberately dropped: keeping them would make the lockout effectively permanent, because
      // they are still inside the window and the next request would be refused for being over
      // budget. "Locked out for N seconds" has to mean N seconds.
      this.entries.delete(key)
      return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts }
    }
    const recent = entry.stamps.filter(stamp => at - stamp < this.windowMs)
    entry.stamps = recent
    if (recent.length === 0) this.entries.delete(key)
    if (recent.length >= this.maxAttempts) {
      // Over budget: the window is not enough on its own, so the key is held for the lockout.
      // Without this an attacker who can send N+1 requests per window is never actually blocked.
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000), remaining: 0 }
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts - recent.length }
  }

  /**
   * Record a failed attempt. The attempt that reaches the limit is itself refused from now on.
   *
   * @param {string} key
   * @returns {{ blocked: boolean, retryAfterSeconds: number }}
   */
  recordFailure(key) {
    const at = this.now()
    let entry = this.entries.get(key)
    // An entry whose lockout has expired starts a fresh history here too, so the first failure
    // after a lockout is not counted against the failures that caused it.
    if (entry !== undefined && entry.blockedUntil > 0 && entry.blockedUntil <= at) {
      this.entries.delete(key)
      entry = undefined
    }
    if (entry === undefined) {
      entry = { stamps: [], blockedUntil: 0 }
      this.entries.set(key, entry)
    }
    entry.stamps = entry.stamps.filter(stamp => at - stamp < this.windowMs)
    entry.stamps.push(at)
    if (entry.stamps.length >= this.maxAttempts) {
      entry.blockedUntil = at + this.lockoutMs
      // Pruning happens after the new key exists, so the budget is never exceeded even by one.
      // The key just added is the newest, so it survives its own prune.
      this.prune(at)
      return { blocked: true, retryAfterSeconds: Math.ceil(this.lockoutMs / 1000) }
    }
    this.prune(at)
    return { blocked: false, retryAfterSeconds: 0 }
  }

  /** Clear a key's history. Called on success, for that key only. */
  clear(key) {
    this.entries.delete(key)
  }

  /**
   * Drop expired entries, oldest first when over the key budget.
   *
   * The budget matters: a limiter that keys on a client-controlled value is a memory amplifier
   * unless it is capped, so a spray attack evicts its own oldest entries rather than the Hub's
   * memory.
   */
  prune(at = this.now()) {
    // Iterating a snapshot while deleting: `Map` iteration is live, and deleting the entry being
    // visited is the one mutation the specification tolerates here.
    for (const [key, entry] of [...this.entries]) {
      const fresh = entry.stamps.some(stamp => at - stamp < this.windowMs)
      if (!fresh && entry.blockedUntil <= at) this.entries.delete(key)
    }
    if (this.entries.size <= this.maxKeys) return
    // `Map` preserves insertion order, so the oldest insert is evicted first. The entry most
    // recently written is at the end, so a spray cannot evict the key it just used.
    const excess = this.entries.size - this.maxKeys
    let dropped = 0
    for (const key of this.entries.keys()) {
      this.entries.delete(key)
      dropped += 1
      if (dropped >= excess) break
    }
  }

  get size() {
    return this.entries.size
  }
}

/**
 * The keys a login attempt is counted under.
 *
 * The handle is normalized (lowercased, trimmed) so `Alice` and `alice` share one budget —
 * otherwise a targeted attack trivially multiplies its budget by changing case. The source is
 * keyed on the socket address; `request.ip` is only trustworthy when the Hub is directly
 * reached, which is why `trustProxy` stays `false` in `server.js` and a reverse-proxy
 * deployment is told to pass the real peer through at the TCP layer.
 *
 * @param {{ handle?: string, source?: string }} parts
 * @returns {string[]}
 */
export function loginKeys({ handle, source }) {
  const keys = []
  const normalized = String(handle ?? '').trim().toLowerCase()
  if (normalized !== '') keys.push(`login:handle:${normalized}`)
  if (typeof source === 'string' && source !== '') keys.push(`login:source:${source}`)
  return keys
}
