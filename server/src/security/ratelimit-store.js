// Durable throttling: the same counting rule as `ratelimit.js`, kept in the database.
//
// The in-memory limiter is correct about *what* to count and honest about what it forgets: a
// restart clears every counter. That is tolerable for a single-process Hub behind one office
// switch, and not tolerable for one colleagues reach an over a network, where "wait for the next
// deploy" is a strategy an attacker can actually execute. So the counters live in `rate_limits`
// and a restart is just a restart.
//
// Four decisions, each of which is load-bearing:
//
//  * **Same observable contract as `RateLimiter`.** `check`, `recordFailure`, `clear` keep their
//    signatures and their meanings, so the routes that call them do not change and the rules stay
//    in one place. Only the storage moved.
//  * **Failures count, a success clears that key.** Inherited deliberately: a legitimate user who
//    mistyped must not be locked out by their own typo an hour later.
//  * **"Locked out for N seconds" means N seconds.** An expired lockout deletes the entry rather
//    than starting a new window on top of the old failures, which would make the lockout permanent
//    in practice.
//  * **The key set is bounded.** A limiter keyed on a client-influenced value is a storage
//    amplifier unless it is capped; past `maxKeys` the oldest rows are evicted, so a spray evicts
//    its own oldest keys instead of growing the Hub's database.
//
// The `now` injection is the same shape the in-memory limiter uses, so the time-dependent paths
// (window expiry, lockout expiry) are testable without sleeping.

/** One row holds a key's recent failure stamps and, when it is over budget, its lockout end. */
export class PersistentLimiter {
  /**
   * @param {{ db: object, maxAttempts: number, windowSeconds: number, lockoutSeconds: number, maxKeys?: number, now?: () => number }} options
   */
  constructor({ db, maxAttempts, windowSeconds, lockoutSeconds, maxKeys = 10_000, now = () => Date.now() }) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer')
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) throw new Error('windowSeconds must be a positive integer')
    if (!Number.isSafeInteger(lockoutSeconds) || lockoutSeconds < 0) throw new Error('lockoutSeconds must be zero or a positive integer')
    this.db = db
    this.maxAttempts = maxAttempts
    this.windowMs = windowSeconds * 1000
    this.lockoutMs = lockoutSeconds * 1000
    this.maxKeys = maxKeys
    this.now = now
  }

  /** The stored row for one key, or `undefined`. */
  #row(key) {
    return this.db.prepare('SELECT key, stamps_json, blocked_until FROM rate_limits WHERE key = ?').get(key)
  }

  /** A row's stamps, parsed defensively: a corrupt value must not silently grant a fresh budget. */
  #stamps(row) {
    let parsed
    try {
      parsed = JSON.parse(row.stamps_json)
    } catch {
      return []
    }
    return Array.isArray(parsed) ? parsed.filter(stamp => Number.isFinite(stamp)) : []
  }

  #write(key, stamps, blockedUntil) {
    if (stamps.length === 0 && blockedUntil <= 0) {
      this.db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key)
      return
    }
    this.db.prepare(`INSERT INTO rate_limits (key, stamps_json, blocked_until, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET stamps_json = excluded.stamps_json, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(stamps), blockedUntil, new Date(this.now()).toISOString())
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
    const row = this.#row(key)
    if (row === undefined) return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts }
    if (row.blocked_until > at) {
      return { allowed: false, retryAfterSeconds: Math.ceil((row.blocked_until - at) / 1000), remaining: 0 }
    }
    // A lockout that has expired starts the key over; keeping the old stamps would refuse the next
    // request for being over a budget it no longer has.
    if (row.blocked_until > 0) {
      this.#write(key, [], 0)
      return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts }
    }
    const recent = this.#stamps(row).filter(stamp => at - stamp < this.windowMs)
    if (recent.length === 0) {
      this.#write(key, [], 0)
      return { allowed: true, retryAfterSeconds: 0, remaining: this.maxAttempts }
    }
    if (recent.length >= this.maxAttempts) {
      // Over budget: the window alone is not enough, so the key is held for the lockout.
      this.#write(key, recent, at + this.lockoutMs)
      return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000), remaining: 0 }
    }
    if (recent.length !== this.#stamps(row).length) this.#write(key, recent, 0)
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
    const row = this.#row(key)
    let stamps = []
    if (row !== undefined && !(row.blocked_until > 0 && row.blocked_until <= at)) {
      stamps = this.#stamps(row).filter(stamp => at - stamp < this.windowMs)
    }
    stamps.push(at)
    if (stamps.length >= this.maxAttempts) {
      this.#write(key, stamps, at + this.lockoutMs)
      this.prune()
      return { blocked: true, retryAfterSeconds: Math.ceil(this.lockoutMs / 1000) }
    }
    this.#write(key, stamps, 0)
    this.prune()
    return { blocked: false, retryAfterSeconds: 0 }
  }

  /** Clear a key's history. Called on success, for that key only. */
  clear(key) {
    this.db.prepare('DELETE FROM rate_limits WHERE key = ?').run(key)
  }

  /**
   * Drop entries that are neither fresh nor locked, then the oldest rows past the key budget.
   *
   * The budget matters: a limiter keyed on a client-controlled value is an amplifier unless it is
   * capped, so a spray must evict its own oldest keys rather than grow the Hub's database.
   */
  prune(at = this.now()) {
    const staleBefore = new Date(at - this.windowMs).toISOString()
    this.db.prepare('DELETE FROM rate_limits WHERE blocked_until <= ? AND updated_at <= ?').run(at, staleBefore)
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n
    if (total <= this.maxKeys) return
    const excess = total - this.maxKeys
    this.db.prepare(`DELETE FROM rate_limits WHERE key IN (
      SELECT key FROM rate_limits ORDER BY updated_at ASC, rowid ASC LIMIT ?
    )`).run(excess)
  }

  get size() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n
  }
}

/**
 * The keys a registration attempt is counted under.
 *
 * Registration has no handle to normalize into a per-account budget — the account does not exist
 * yet — so it is counted per source only. The prefix keeps these rows distinguishable from login
 * rows in the same table, which is what lets one table serve both routes without their budgets
 * interfering.
 *
 * @param {{ source?: string }} parts
 * @returns {string[]}
 */
export function registrationKeys({ source }) {
  return typeof source === 'string' && source !== '' ? [`register:source:${source}`] : []
}

/**
 * The keys a Bot heartbeat is counted under.
 *
 * A heartbeat is a write to the bot directory by design, so an unthrottled one lets a single
 * client spend the Hub's write capacity for free. It is counted per source and per Bot: the source
 * key stops one caller looping, and the Bot key stops one Bot being driven by many sources — the
 * owner's runtime is the only legitimate writer either way.
 *
 * @param {{ botId?: string, source?: string }} parts
 * @returns {string[]}
 */
export function heartbeatKeys({ botId, source }) {
  const keys = []
  if (typeof botId === 'string' && botId !== '') keys.push(`heartbeat:bot:${botId}`)
  if (typeof source === 'string' && source !== '') keys.push(`heartbeat:source:${source}`)
  return keys
}

/**
 * The keys a message send is counted under.
 *
 * Message send allocates a room sequence number inside a write transaction, so one sender in a loop
 * holds the room's single writer and blocks everybody else in it. Counted per source and per room:
 * the source key bounds one caller, and the room key bounds the damage to one room rather than
 * letting a flood in one room consume every room's shared budget.
 *
 * @param {{ roomId?: string, source?: string }} parts
 * @returns {string[]}
 */
export function messageKeys({ roomId, source }) {
  const keys = []
  if (typeof roomId === 'string' && roomId !== '') keys.push(`message:room:${roomId}`)
  if (typeof source === 'string' && source !== '') keys.push(`message:source:${source}`)
  return keys
}
