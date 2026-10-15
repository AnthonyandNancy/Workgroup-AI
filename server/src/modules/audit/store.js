// Audit reading and retention.
//
// The audit trail answers "what happened, who did it, and was it allowed". Writing it is spread
// across the modules that make the decisions; this module owns the two things that must be
// consistent about it:
//
//   * **Reading is bounded and filtered.** An operator investigates a specific person, object,
//     outcome, or window. Returning the whole table, or letting a caller ask for an unbounded page,
//     would make the trail unusable exactly when it is needed. Every query here has a limit.
//   * **Retention is a recorded decision.** `pruneAudit` deletes by age and writes what it did to
//     `retention_runs`. A silent sweep would leave an operator unable to answer "why is this event
//     gone", which is worse than keeping too much.
//
// What retention must never do is treat the audit trail as ordinary data. It is the record of the
// decisions the Hub enforced — approvals, refusals, revocations — so its default is "keep forever"
// and an operator has to opt into a window. That is why the configuration default is `null`.

import { randomUUID } from 'node:crypto'

const PAGE_MAX = 500
export const AUDIT_PAGE_MAX = PAGE_MAX

export class AuditError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || 100, 1), PAGE_MAX)
}

/**
 * Read audit events, newest first.
 *
 * Every filter is optional and they combine. `since` and `until` are ISO timestamps compared as
 * strings, which is exact for this format. A caller that passes nothing gets the most recent page,
 * never the whole table.
 */
export function listAuditEvents(db, { actorUserId, objectType, objectId, outcome, eventType, since, until, limit } = {}) {
  const where = []
  const params = []
  if (actorUserId !== undefined) { where.push('actor_user_id = ?'); params.push(actorUserId) }
  if (objectType !== undefined) { where.push('object_type = ?'); params.push(objectType) }
  if (objectId !== undefined) { where.push('object_id = ?'); params.push(objectId) }
  if (outcome !== undefined) { where.push('outcome = ?'); params.push(outcome) }
  if (eventType !== undefined) { where.push('event_type = ?'); params.push(eventType) }
  if (since !== undefined) { where.push('occurred_at >= ?'); params.push(since) }
  if (until !== undefined) { where.push('occurred_at <= ?'); params.push(until) }
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  return db.prepare(`SELECT * FROM audit_events ${clause} ORDER BY occurred_at DESC, rowid DESC LIMIT ?`)
    .all(...params, clampLimit(limit))
}

/** How many events match the same filters, so a caller knows whether more exist. */
export function countAuditEvents(db, filters = {}) {
  const where = []
  const params = []
  for (const [column, value] of [
    ['actor_user_id', filters.actorUserId], ['object_type', filters.objectType],
    ['object_id', filters.objectId], ['outcome', filters.outcome], ['event_type', filters.eventType],
  ]) {
    if (value === undefined) continue
    where.push(`${column} = ?`)
    params.push(value)
  }
  if (filters.since !== undefined) { where.push('occurred_at >= ?'); params.push(filters.since) }
  if (filters.until !== undefined) { where.push('occurred_at <= ?'); params.push(filters.until) }
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
  return db.prepare(`SELECT count(*) AS n FROM audit_events ${clause}`).get(...params).n
}

/** The event types the Hub writes, for an operator building a query. */
export function auditEventTypes(db) {
  return db.prepare('SELECT DISTINCT event_type FROM audit_events ORDER BY event_type').all().map(row => row.event_type)
}

/** One event by id, for following a trail from an object or a report. */
export function findAuditEvent(db, id) {
  return db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id)
}

/**
 * Delete audit events older than a cutoff, and record what happened.
 *
 * `dryRun` reports what would go without deleting, which is what an operator should run first: a
 * retention window that turns out to be too short cannot be undone, and the audit trail is the one
 * table where that mistake matters most.
 */
export function pruneAudit(db, { cutoff, dryRun = false, now = new Date() } = {}) {
  if (typeof cutoff !== 'string' || cutoff.length === 0) {
    throw new AuditError('A retention cutoff is required', 'MISSING_CUTOFF')
  }
  const removable = db.prepare('SELECT count(*) AS n FROM audit_events WHERE occurred_at < ?').get(cutoff).n
  const total = db.prepare('SELECT count(*) AS n FROM audit_events').get().n
  if (dryRun) {
    return { scope: 'audit', cutoff, deleted: 0, wouldDelete: removable, kept: total, dryRun: true, ranAt: now.toISOString() }
  }
  const ranAt = now.toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM audit_events WHERE occurred_at < ?').run(cutoff)
    // The run itself is recorded in the same transaction as the delete, so the count and the
    // effect cannot disagree.
    db.prepare(`INSERT INTO retention_runs (id, scope, cutoff, deleted_count, kept_count, ran_at)
      VALUES (?, 'audit', ?, ?, ?, ?)`)
      .run(randomUUID(), cutoff, removable, total - removable, ranAt)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return { scope: 'audit', cutoff, deleted: removable, kept: total - removable, dryRun: false, ranAt }
}

/** The cutoff an age in days implies, as an ISO timestamp. */
export function cutoffForDays(days, now = new Date()) {
  if (!Number.isSafeInteger(days) || days <= 0) throw new AuditError('Retention days must be a positive integer', 'INVALID_RETENTION')
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** What previous retention runs did, newest first. */
export function listRetentionRuns(db, limit = 50) {
  return db.prepare('SELECT * FROM retention_runs ORDER BY ran_at DESC LIMIT ?').all(clampLimit(limit))
}

export function publicAuditEvent(row) {
  return {
    id: row.id,
    actorUserId: row.actor_user_id ?? null,
    actorDeviceId: row.actor_device_id ?? null,
    eventType: row.event_type,
    objectType: row.object_type,
    objectId: row.object_id ?? null,
    outcome: row.outcome,
    details: JSON.parse(row.safe_details_json),
    occurredAt: row.occurred_at,
  }
}

export const auditInternals = { PAGE_MAX, clampLimit }
