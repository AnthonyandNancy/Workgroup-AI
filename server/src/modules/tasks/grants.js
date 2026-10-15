// One-time dispatch grants.
//
// A grant is the Hub's answer to "how does the owner's machine prove that this specific
// dispatch was approved?" Four properties make it safe, and each is a separate check because
// they fail independently:
//
//  1. **Single use.** `consumeGrant` marks `consumed_at` in the same transaction that verifies,
//     so two racing dispatches cannot both succeed. A second presentation of the same nonce
//     is refused — that is what stops a captured grant from being replayed.
//  2. **Bound to a task, an owner, a device, and a Bot.** A valid nonce for task X cannot be
//     used to dispatch task Y, and a grant issued to one device does not work from another.
//  3. **Bounded in time, twice.** The grant carries its own `expires_at`, clamped at mint time
//     to the approval's expiry. An approval that lapses therefore cannot be outlived by a
//     grant minted just before it lapsed.
//  4. **Revocable, and revocation is a fact the machine checks.** `revoked_at` and the
//     recorded `revocation_version` mean a cancellation invalidates grants without the Hub
//     reaching into anyone's computer: the executor compares what it holds against what the
//     Hub now says.
//
// The nonce is stored only as a SHA-256 hash. The Hub never needs to read a grant back — it
// only needs to recognise one it issued — so a database leak yields no usable grants.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { TaskError, findTask, findApprovalForTask, isTerminal } from '../tasks/store.js'

export class GrantError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'GrantError'
    this.code = code
  }
}

/** Grants are short-lived by nature: they exist to authorise one dispatch, not to be kept. */
const GRANT_TTL_SECONDS_DEFAULT = 300

export function nonceHashOf(nonce) {
  return createHash('sha256').update(String(nonce), 'utf8').digest('hex')
}

function generateNonce() {
  return `wggrant_${randomBytes(32).toString('base64url')}`
}

function nowIso(now) {
  return now.toISOString()
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'dispatch_grant', ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), nowIso(now))
}

export function findGrantByNonce(db, nonce) {
  return db.prepare('SELECT * FROM dispatch_grants WHERE nonce_hash = ?').get(nonceHashOf(nonce))
}

export function listGrantsForTask(db, taskId) {
  return db.prepare('SELECT * FROM dispatch_grants WHERE task_id = ? ORDER BY issued_at').all(taskId)
}

/**
 * Mint one grant for an approved task.
 *
 * Only the owner's own authenticated device may mint: this is a second, independent check
 * beside the approval itself, so a task that somehow reached `APPROVED` in another way still
 * cannot be dispatched without the owner's live credential.
 *
 * @returns {{ grantId: string, nonce: string, expiresAt: string, taskId: string, botId: string|null }}
 *   The nonce is returned exactly once; the Hub keeps only its hash.
 */
export function mintGrant(db, {
  taskId, ownerUserId, ownerDeviceId, botId, ttlSeconds = GRANT_TTL_SECONDS_DEFAULT, now = new Date(),
}) {
  const task = findTask(db, taskId)
  if (task === undefined) throw new GrantError('No such task', 'NO_SUCH_TASK')
  if (task.owner_user_id !== ownerUserId) {
    // The same object-level rule as deciding: a grant is the owner's, and nobody else's.
    throw new GrantError('Only the task owner may mint a dispatch grant', 'NOT_TASK_OWNER')
  }
  if (isTerminal(task.state)) {
    // A finished task must not produce a dispatchable grant, or cancel-then-dispatch would be
    // a way to run work the owner already stopped.
    throw new GrantError(`This task is ${task.state} and cannot be dispatched`, 'TASK_NOT_DISPATCHABLE')
  }
  const approval = findApprovalForTask(db, taskId)
  if (approval === undefined || approval.decision !== 'approve') {
    throw new GrantError('This task has no approval to dispatch', 'NO_APPROVAL')
  }
  // A rejected task, or one whose approval lapsed, is not dispatchable.
  if (approval.expires_at !== null && approval.expires_at <= nowIso(now)) {
    throw new GrantError('This approval has expired', 'APPROVAL_EXPIRED')
  }
  if (task.state !== 'APPROVED' && task.state !== 'QUEUED') {
    // Dispatching from RUNNING would double-start; from PENDING_APPROVAL would skip consent.
    throw new GrantError(`A task in ${task.state} cannot be dispatched`, 'TASK_NOT_DISPATCHABLE')
  }

  const effectiveBotId = botId ?? task.assigned_bot_id ?? null
  const nonce = generateNonce()
  const id = randomUUID()
  const issuedAt = nowIso(now)
  // Clamp to the approval's expiry so a grant can never outlive the consent behind it.
  const ownExpiry = new Date(now.getTime() + ttlSeconds * 1000)
  const expiresAt = approval.expires_at !== null && Date.parse(approval.expires_at) < ownExpiry.getTime()
    ? approval.expires_at
    : ownExpiry.toISOString()

  db.exec('BEGIN IMMEDIATE')
  try {
    // Re-read under the write lock: a cancellation between the checks above and here must not
    // produce a live grant.
    const current = db.prepare('SELECT state, revocation_version FROM tasks WHERE id = ?').get(taskId)
    if (isTerminal(current.state)) throw new GrantError(`This task is ${current.state} and cannot be dispatched`, 'TASK_NOT_DISPATCHABLE')
    if (current.state !== 'APPROVED' && current.state !== 'QUEUED') {
      throw new GrantError(`A task in ${current.state} cannot be dispatched`, 'TASK_NOT_DISPATCHABLE')
    }
    db.prepare(`INSERT INTO dispatch_grants
      (id, task_id, approval_id, owner_user_id, device_id, bot_id, nonce_hash, revocation_version, issued_at, expires_at, scope_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId, approval.id, ownerUserId, ownerDeviceId, effectiveBotId, nonceHashOf(nonce),
        current.revocation_version, issuedAt, expiresAt, approval.scope_json)
    audit(db, { actorUserId: ownerUserId, actorDeviceId: ownerDeviceId, eventType: 'grant.minted', objectId: id, outcome: 'success', details: { taskId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return { grantId: id, nonce, expiresAt, taskId, botId: effectiveBotId }
}

/**
 * Verify and consume a grant, in one transaction.
 *
 * This is the function a local executor's request goes through. Every refusal below is a
 * distinct code so the executor can log why it did not start, and so a test can prove each
 * rule rather than proving only that *something* was refused.
 *
 * @returns {{ ok: true, grant: object, scope: object }} on success
 * @throws {GrantError} on any failed check
 */
export function consumeGrant(db, { nonce, taskId, deviceId, now = new Date() }) {
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  let result
  try {
    const grant = db.prepare('SELECT * FROM dispatch_grants WHERE nonce_hash = ?').get(nonceHashOf(nonce))
    // An unknown nonce and a nonce for the wrong task are given the same code: telling a
    // caller that "the grant exists but is for another task" would confirm a captured nonce.
    if (grant === undefined) throw new GrantError('This dispatch grant is not valid', 'UNKNOWN_GRANT')
    if (grant.task_id !== taskId) throw new GrantError('This dispatch grant is not valid', 'UNKNOWN_GRANT')

    if (grant.revoked_at !== null && grant.revoked_at !== undefined) {
      throw new GrantError('This dispatch grant was revoked', 'GRANT_REVOKED')
    }
    if (grant.consumed_at !== null && grant.consumed_at !== undefined) {
      // The replay path. A grant is for one dispatch; a second presentation is refused and
      // recorded, because it means either a relayed capture or a client retrying a response
      // it never saw — and both must not start the work twice.
      audit(db, { actorUserId: grant.owner_user_id, actorDeviceId: grant.device_id, eventType: 'grant.replay_refused', objectId: grant.id, outcome: 'refused', details: { taskId }, now })
      db.exec('COMMIT')
      throw new GrantError('This dispatch grant was already used', 'GRANT_ALREADY_USED')
    }
    if (grant.expires_at <= stamp) throw new GrantError('This dispatch grant has expired', 'GRANT_EXPIRED')

    // The grant is bound to the device it was minted for: another machine holding the nonce
    // still cannot dispatch.
    if (grant.device_id !== deviceId) throw new GrantError('This dispatch grant is not valid', 'UNKNOWN_GRANT')

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(grant.task_id)
    if (task === undefined) throw new GrantError('This dispatch grant is not valid', 'UNKNOWN_GRANT')
    if (isTerminal(task.state)) throw new GrantError(`This task is ${task.state}`, 'TASK_TERMINAL')
    // The revocation check: this is where a cancellation reaches a machine that is holding a
    // grant. The recorded version must still be current.
    if (task.revocation_version !== grant.revocation_version) {
      throw new GrantError('This dispatch grant was revoked by a cancellation', 'GRANT_REVOKED')
    }

    db.prepare('UPDATE dispatch_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(stamp, grant.id)
    // The task moves to QUEUED as part of consuming the grant, so "dispatched" is a single
    // fact rather than two writes that could disagree.
    if (task.state === 'APPROVED') {
      db.prepare("UPDATE tasks SET state = 'QUEUED', version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
        .run(stamp, task.id, task.version)
      db.prepare(`INSERT INTO task_events (id, task_id, actor_user_id, event_type, public_payload_json, created_at)
        VALUES (?, ?, ?, 'task.dispatched', ?, ?)`)
        .run(randomUUID(), task.id, grant.owner_user_id, JSON.stringify({ state: 'QUEUED' }), stamp)
    }
    audit(db, { actorUserId: grant.owner_user_id, actorDeviceId: grant.device_id, eventType: 'grant.consumed', objectId: grant.id, outcome: 'success', details: { taskId }, now })
    db.exec('COMMIT')
    result = { ok: true, grant, scope: JSON.parse(grant.scope_json) }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return result
}

/**
 * Revoke every unexpired, unconsumed grant for a task.
 *
 * Called when the task is cancelled. The revocation version bump in `cancelTask` already
 * makes outstanding grants fail the version check; this marks them explicitly so an operator
 * reading the table sees the same thing the executor would conclude.
 */
export function revokeGrantsForTask(db, { taskId, now = new Date() }) {
  const stamp = nowIso(now)
  const result = db.prepare(`UPDATE dispatch_grants SET revoked_at = ?
    WHERE task_id = ? AND revoked_at IS NULL AND consumed_at IS NULL`).run(stamp, taskId)
  return result.changes
}

/** A grant's public shape. Never returns the nonce: the Hub does not keep it. */
export function publicGrant(grant) {
  return {
    id: grant.id,
    taskId: grant.task_id,
    botId: grant.bot_id ?? null,
    issuedAt: grant.issued_at,
    expiresAt: grant.expires_at,
    consumedAt: grant.consumed_at ?? null,
    revokedAt: grant.revoked_at ?? null,
    revocationVersion: grant.revocation_version,
  }
}

export const grantInternals = { GRANT_TTL_SECONDS_DEFAULT, generateNonce, TaskError }
