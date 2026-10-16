// Hub group memory: what a workgroup agrees to remember, with a source, an author, a
// revision trail, and a scope.
//
// The design problem is that "memory" in a collaboration tool means two incompatible things:
// a note one person wrote for themselves, and something the group will act on later. A Hub
// that cannot tell them apart either over-shares a private note or loses a decision. So every
// entry here carries four facts that make its status checkable rather than assumed:
//
//   source    `sourceMessageId` names the message it came from, when there is one. An entry
//             with no source is the author's own statement, which is a weaker claim and is
//             labelled as such rather than presented as agreed.
//   author    who wrote it. Kept forever, including across edits, so a correction does not
//             silently change who said what.
//   revision  every edit appends to `memory_revisions` with the previous and new body. A
//             correction is visible as a correction; the earlier text is never lost.
//   scope     who may read it. It cannot be wider than the room: a memory is group property,
//             and there is no path that publishes one outside its room.
//
// Two rules come from the acceptance criteria and shape the queries:
//
//  * **Membership is checked in the database, on every read and write**, exactly as the room
//    and message modules do it. Knowing a room id, or having been a member once, grants
//    nothing.
//  * **Deletion is a timestamp, never a row removal.** A group's history is the thing members
//    rely on when they disagree about what was decided, so a deletion that erased the trail
//    would remove the evidence that a correction happened. The body is cleared and the entry
//    stops being returned; the revision trail and the audit entry remain.
//
// Search is deliberately substring, case-insensitive, over the entry body. Semantic search is
// not implemented and is not claimed: a caller gets what it asked for, literally.

import { randomUUID } from 'node:crypto'
import { RoomError, requireMember, membershipOf } from '../rooms/store.js'

export class MemoryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

const BODY_MAX = 20_000
const QUERY_MAX = 200
/** How many entries one search returns. Bounded so a query cannot pull a whole room's memory. */
export const MEMORY_PAGE_MAX = 200

/**
 * Who a memory is for.
 *
 * Only two scopes exist, and neither can widen access: `room` is every current member, and
 * `author` is the person who wrote it. There is no cross-room scope, because a group's memory
 * is the group's.
 */
export const MEMORY_SCOPES = ['room', 'author']

export function assertBody(body) {
  if (typeof body !== 'string') throw new MemoryError('A memory body must be a string', 'INVALID_BODY')
  const value = body.trim()
  if (value.length === 0) throw new MemoryError('A memory body must not be empty', 'INVALID_BODY')
  if (value.length > BODY_MAX) throw new MemoryError(`A memory body must be at most ${BODY_MAX} characters`, 'INVALID_BODY')
  return value
}

export function assertScope(scope) {
  const value = scope ?? 'room'
  if (!MEMORY_SCOPES.includes(value)) {
    throw new MemoryError(`A memory scope must be one of ${MEMORY_SCOPES.join(', ')}`, 'INVALID_SCOPE')
  }
  return value
}

function nowIso(now) {
  return now.toISOString()
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'group_memory', ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), nowIso(now))
}

/** Whether an entry is currently readable: not deleted, and not past its validity window. */
function isLive(row, now) {
  if (row.deleted_at !== null && row.deleted_at !== undefined) return false
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= nowIso(now)) return false
  return true
}

function aclOf(row) {
  try {
    return JSON.parse(row.acl_json)
  } catch {
    // A corrupted scope must not widen access: fall back to the narrowest reading.
    return { scope: 'author' }
  }
}

/**
 * Whether this viewer may read this entry.
 *
 * Membership is the caller's responsibility to have already proven — every public function
 * here calls `requireMember` first — so this compares the viewer against the entry's own scope.
 */
export function mayRead(row, viewerUserId, now = new Date()) {
  if (!isLive(row, now)) return false
  if (row.author_user_id === viewerUserId) return true
  return aclOf(row).scope === 'room'
}

// ---------------------------------------------------------------- writes

/**
 * Evict the oldest entries until the room is back inside its ceiling.
 *
 * Called inside the caller's transaction, before the new entry is inserted, so the ceiling is a
 * property of the committed state rather than something two concurrent writers could each satisfy
 * on their own.
 *
 * Eviction reuses the deletion semantics this module already has, and for the same reason: the
 * revision trail and the audit row are what make a decision checkable later, so an eviction that
 * removed the row would remove the evidence. The body is cleared, the scope narrowed, `deleted_at`
 * stamped — and an operator reading the trail can tell `memory.evicted` (a ceiling did it) from
 * `memory.deleted` (the author changed their mind) or `memory.deleted_by_admin` (an admin removed
 * it), which are three different facts about the same disappearance.
 *
 * `maxPerRoom` of `0` (or absent) means "no ceiling", which is what keeps an upgraded Hub from
 * evicting memory it already holds.
 *
 * @returns {number} how many entries were evicted
 */
function evictToCeiling(db, { roomId, maxPerRoom, now }) {
  if (!Number.isSafeInteger(maxPerRoom) || maxPerRoom < 1) return 0
  // Room for the entry about to be inserted, so the committed count never exceeds the ceiling.
  const live = db.prepare(`SELECT COUNT(*) AS n FROM group_memories
    WHERE room_id = ? AND deleted_at IS NULL`).get(roomId).n
  const overflow = live - maxPerRoom + 1
  if (overflow <= 0) return 0

  // Oldest first, ties broken by insertion order. `updated_at` moves on edit, so a frequently
  // corrected entry is not the first to go: eviction is about age of last relevance, not creation.
  const victims = db.prepare(`SELECT id, author_user_id, room_id FROM group_memories
    WHERE room_id = ? AND deleted_at IS NULL
    ORDER BY updated_at ASC, rowid ASC LIMIT ?`).all(roomId, overflow)
  const stamp = nowIso(now)
  for (const victim of victims) {
    // The previous body goes to the revision trail, so the eviction leaves the same kind of trace
    // an edit does rather than silently blanking the entry.
    db.prepare(`INSERT INTO memory_revisions (id, memory_id, revision, editor_user_id, previous_body, new_body, changed_at)
      SELECT ?, id, revision + 1, author_user_id, body, NULL, ? FROM group_memories WHERE id = ?`)
      .run(randomUUID(), stamp, victim.id)
    db.prepare(`UPDATE group_memories SET body = '', acl_json = ?, deleted_at = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ scope: 'author', deleted: true, evicted: true }), stamp, stamp, victim.id)
    audit(db, {
      actorUserId: null, actorDeviceId: null, eventType: 'memory.evicted', objectId: victim.id,
      outcome: 'success', details: { roomId: victim.room_id, reason: 'quota', limit: maxPerRoom }, now,
    })
  }
  return victims.length
}

/**
 * Remember something in a room.
 *
 * `sourceMessageId`, when given, must name a message in **this** room: a memory that cites a
 * message from another room would let a member quote across a boundary they cannot read.
 *
 * `maxPerRoom` is the room's ceiling. It is passed in rather than read from configuration here so
 * this module keeps owning the rule while the route keeps owning the policy — and so a test can
 * drive the rule without a config object.
 */
export function createMemory(db, {
  roomId, authorUserId, authorDeviceId, body, sourceMessageId, scope = 'room', expiresAt = null, maxPerRoom = 0, now = new Date(),
}) {
  requireMember(db, { roomId, userId: authorUserId })
  const text = assertBody(body)
  const memoryScope = assertScope(scope)

  if (sourceMessageId !== undefined && sourceMessageId !== null) {
    const source = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(sourceMessageId)
    if (source === undefined) throw new MemoryError('No such source message', 'NO_SUCH_SOURCE')
    if (source.room_id !== roomId) {
      throw new MemoryError('The source message belongs to another room', 'SOURCE_IN_ANOTHER_ROOM')
    }
  }
  if (expiresAt !== null && typeof expiresAt !== 'string') {
    throw new MemoryError('expiresAt must be an ISO timestamp or null', 'INVALID_EXPIRY')
  }

  const id = randomUUID()
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    evictToCeiling(db, { roomId, maxPerRoom, now })
    db.prepare(`INSERT INTO group_memories
      (id, room_id, author_user_id, source_message_id, body, acl_json, revision, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, roomId, authorUserId, sourceMessageId ?? null, text, JSON.stringify({ scope: memoryScope }), expiresAt, stamp, stamp)
    audit(db, { actorUserId: authorUserId, actorDeviceId: authorDeviceId, eventType: 'memory.created', objectId: id, outcome: 'success', details: { roomId, scope: memoryScope }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return findMemory(db, id)
}

export function findMemory(db, id) {
  return db.prepare('SELECT * FROM group_memories WHERE id = ?').get(id)
}

/**
 * Correct an entry.
 *
 * The previous body goes into `memory_revisions` in the same transaction that changes the
 * body, so the trail cannot disagree with the entry. The revision number is the entry's own
 * counter, which is what makes "which version did I read" answerable.
 */
export function reviseMemory(db, {
  memoryId, editorUserId, editorDeviceId, body, expectedRevision, expiresAt, now = new Date(),
}) {
  const existing = findMemory(db, memoryId)
  if (existing === undefined) throw new MemoryError('No such memory', 'NO_SUCH_MEMORY')
  // Object-level check before the state machine: only the author may correct it, and a room
  // admin who can remove a member still cannot rewrite what that member said.
  if (existing.author_user_id !== editorUserId) {
    throw new MemoryError('Only the author may correct this memory', 'NOT_THE_AUTHOR')
  }
  if (existing.deleted_at !== null && existing.deleted_at !== undefined) {
    throw new MemoryError('This memory was deleted', 'MEMORY_DELETED')
  }
  const text = assertBody(body)
  const stamp = nowIso(now)

  db.exec('BEGIN IMMEDIATE')
  let updated
  try {
    const current = db.prepare('SELECT * FROM group_memories WHERE id = ?').get(memoryId)
    if (current === undefined) throw new MemoryError('No such memory', 'NO_SUCH_MEMORY')
    // Optimistic lock: two corrections from one author must not silently overwrite each other.
    if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
      throw new MemoryError(`This memory has moved on (expected revision ${expectedRevision}, current ${current.revision})`, 'REVISION_CONFLICT')
    }
    const nextRevision = current.revision + 1
    db.prepare(`INSERT INTO memory_revisions (id, memory_id, revision, editor_user_id, previous_body, new_body, changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), memoryId, nextRevision, editorUserId, current.body, text, stamp)
    db.prepare('UPDATE group_memories SET body = ?, revision = ?, updated_at = ?, expires_at = ? WHERE id = ? AND revision = ?')
      .run(text, nextRevision, stamp, expiresAt === undefined ? current.expires_at : expiresAt, memoryId, current.revision)
    audit(db, { actorUserId: editorUserId, actorDeviceId: editorDeviceId, eventType: 'memory.revised', objectId: memoryId, outcome: 'success', details: { revision: nextRevision }, now })
    db.exec('COMMIT')
    updated = db.prepare('SELECT * FROM group_memories WHERE id = ?').get(memoryId)
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return updated
}

/**
 * Delete an entry.
 *
 * The author may always delete their own; a room admin may delete any entry in their room, and
 * that right is recorded as an admin action rather than disguised as the author's. The body is
 * cleared so a deleted entry cannot leak through a later read, while the row, its revisions,
 * and the audit entry stay: the group can still see that something was deleted and by whom.
 */
export function deleteMemory(db, { memoryId, actorUserId, actorDeviceId, now = new Date() }) {
  const existing = findMemory(db, memoryId)
  if (existing === undefined) throw new MemoryError('No such memory', 'NO_SUCH_MEMORY')
  if (existing.deleted_at !== null && existing.deleted_at !== undefined) {
    // Deleting twice is not an error: an idempotent delete keeps a retry harmless.
    return existing
  }
  // Membership first, and a non-member is refused as if the entry did not exist. Reporting
  // "you may not delete this" to somebody who is not in the room would confirm that the entry
  // exists — the same leak the read paths avoid by answering 404.
  requireMember(db, { roomId: existing.room_id, userId: actorUserId })

  // Admin rights are the second question: a member who is neither the author nor an admin is
  // told they may not delete it, which is correct because they already know the entry exists.
  const isAuthor = existing.author_user_id === actorUserId
  const membership = membershipOf(db, { roomId: existing.room_id, userId: actorUserId })
  const isAdmin = membership !== undefined && (membership.role === 'owner' || membership.role === 'admin')
  if (!isAuthor && !isAdmin) {
    throw new MemoryError('Only the author or a room admin may delete this memory', 'NOT_ALLOWED_TO_DELETE')
  }

  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    // The body is cleared and the scope narrowed, so a read that somehow still matched this row
    // returns nothing rather than the deleted text.
    db.prepare(`UPDATE group_memories SET body = '', acl_json = ?, deleted_at = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ scope: 'author', deleted: true }), stamp, stamp, memoryId)
    audit(db, {
      actorUserId, actorDeviceId, eventType: isAuthor ? 'memory.deleted' : 'memory.deleted_by_admin',
      objectId: memoryId, outcome: 'success', details: { roomId: existing.room_id }, now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return findMemory(db, memoryId)
}

// ---------------------------------------------------------------- reads

/** Entries a member can currently read, newest first. */
export function listMemories(db, { roomId, viewerUserId, limit = MEMORY_PAGE_MAX, now = new Date() }) {
  requireMember(db, { roomId, userId: viewerUserId })
  // Visibility is filtered in the query, not after it. Filtering a page after LIMIT would let a
  // page of author-scoped entries push a readable one past the limit, so a member would see fewer
  // entries than exist with no way to page further.
  const rows = db.prepare(`SELECT * FROM group_memories
    WHERE room_id = ?
      AND deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
      AND (author_user_id = ? OR json_extract(acl_json, '$.scope') = 'room')
    ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .all(roomId, nowIso(now), viewerUserId, clampLimit(limit))
  return rows.filter(row => mayRead(row, viewerUserId, now))
}

/** One page size, bounded, whatever the caller asked for. */
function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || MEMORY_PAGE_MAX, 1), MEMORY_PAGE_MAX)
}

/**
 * Search a room's memory.
 *
 * Matching is a literal, case-insensitive substring over the body. Only entries the viewer may
 * read are searched, so a member cannot learn that an author-scoped entry exists by watching a
 * query for it either.
 */
export function searchMemories(db, { roomId, viewerUserId, query, limit = MEMORY_PAGE_MAX, now = new Date() }) {
  requireMember(db, { roomId, userId: viewerUserId })
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new MemoryError('A search query must not be empty', 'INVALID_QUERY')
  }
  if (query.length > QUERY_MAX) throw new MemoryError(`A search query must be at most ${QUERY_MAX} characters`, 'INVALID_QUERY')
  const needle = query.trim().toLowerCase()
  // The scope filter is part of the query, so an author-scoped entry can neither be returned by
  // a matching pattern nor consume a row of the caller's page.
  const rows = db.prepare(`SELECT * FROM group_memories
    WHERE room_id = ?
      AND deleted_at IS NULL
      AND lower(body) LIKE ?
      AND (expires_at IS NULL OR expires_at > ?)
      AND (author_user_id = ? OR json_extract(acl_json, '$.scope') = 'room')
    ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .all(roomId, `%${needle}%`, nowIso(now), viewerUserId, clampLimit(limit))
  return rows.filter(row => mayRead(row, viewerUserId, now))
}

/** One entry, if the viewer may read it. A refusal is reported as "not found". */
export function readMemory(db, { memoryId, viewerUserId, now = new Date() }) {
  const row = findMemory(db, memoryId)
  if (row === undefined) return undefined
  const membership = membershipOf(db, { roomId: row.room_id, userId: viewerUserId })
  // Two independent checks: current membership of the room, then the entry's own scope. A
  // removed member fails the first even if the entry is room-scoped.
  if (membership === undefined) return undefined
  if (!mayRead(row, viewerUserId, now)) return undefined
  return row
}

/** The correction trail for one entry, oldest first. Only readable if the entry is. */
export function listRevisions(db, { memoryId, viewerUserId, now = new Date() }) {
  const row = readMemory(db, { memoryId, viewerUserId, now })
  if (row === undefined) return undefined
  return db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision').all(memoryId)
}

export function publicMemory(row, now = new Date()) {
  const acl = aclOf(row)
  return {
    id: row.id,
    roomId: row.room_id,
    authorUserId: row.author_user_id,
    sourceMessageId: row.source_message_id ?? null,
    body: row.body,
    scope: acl.scope,
    revision: row.revision,
    expiresAt: row.expires_at ?? null,
    deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Stated rather than implied: a caller deciding how much to trust an entry needs to know
    // whether it cites a message or is only someone's assertion.
    sourced: row.source_message_id !== null && row.source_message_id !== undefined,
    live: isLive(row, now),
  }
}

export function publicRevision(row) {
  return {
    revision: row.revision,
    editorUserId: row.editor_user_id,
    previousBody: row.previous_body,
    newBody: row.new_body,
    changedAt: row.changed_at,
  }
}

export const memoryInternals = { BODY_MAX, QUERY_MAX, isLive, aclOf }
