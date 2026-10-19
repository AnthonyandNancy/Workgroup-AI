// Tasks and approvals: the cross-user delegation state machine.
//
// This module is the project's highest safety surface, and every rule below exists because
// the corresponding mistake would let work start without its owner's consent:
//
//  1. **A task starts awaiting approval and cannot skip it.** There is no code path from
//     creation to `APPROVED` that does not go through a decision recorded by the owner's own
//     authenticated device. The transition table has no edge that does it.
//  2. **Only the owner may decide.** The approver is checked against `owner_user_id`, not
//     against room membership, role, or the requester's claim. The owner's Chief cannot
//     approve on their behalf — a Chief is not a user.
//  3. **The transition table is the authority, and it is enforced in the transaction.** Every
//     move is checked against `TASK_TRANSITIONS` while holding the write lock, and carries
//     `expectedVersion` so two racing decisions cannot both win.
//  4. **A terminal state is terminal.** `COMPLETED`, `SHARED`, `REJECTED`, `EXPIRED`,
//     `CANCELLED`, and `FAILED` accept no further transition. Continuing work after one of
//     them requires a new task and a new approval — "resume" is how an approval gets reused
//     for work nobody approved.
//  5. **Cancellation bumps `revocation_version`.** A local executor compares the version it
//     was granted against the current one; a bump is what makes an in-flight grant stop
//     being valid without the Hub having to reach into the owner's machine.
//  6. **The public progress record is a separate, redacted stream.** `task_events` holds what
//     the room may see; it must never carry the owner's file paths, tool output, or model
//     context. The executor's private detail stays local.
//
// What this module deliberately does NOT do: run anything. It records intent, consent, and
// state. Execution happens on the owner's machine, checked against the grant this module
// issues.

import { randomUUID } from 'node:crypto'
import { requireMember, RoomError } from '../rooms/store.js'
import { isBotInRoom } from '../rooms/bots.js'
import { isVisibleTo } from '../bots/store.js'

export class TaskError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TaskError'
    this.code = code
  }
}

/** Every state a task may be in. Mirrors the schema CHECK constraint. */
export const TASK_STATES = Object.freeze([
  'PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'RUNNING', 'REVIEW_REQUIRED',
  'COMPLETED', 'SHARED', 'REJECTED', 'CANCELLING', 'CANCELLED', 'EXPIRED', 'FAILED',
])

/** Terminal states: nothing follows them, and no grant may outlive them. */
export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'SHARED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED'])

/**
 * The complete transition table.
 *
 * Read this as the answer to "what may happen next". A missing edge is a refusal, not an
 * oversight: `PENDING_APPROVAL → RUNNING` is absent because it is exactly the hop that would
 * start work before the owner agreed to it.
 */
export const TASK_TRANSITIONS = Object.freeze({
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  APPROVED: ['QUEUED', 'CANCELLING', 'CANCELLED', 'FAILED', 'EXPIRED'],
  QUEUED: ['RUNNING', 'CANCELLING', 'CANCELLED', 'FAILED', 'EXPIRED'],
  RUNNING: ['REVIEW_REQUIRED', 'COMPLETED', 'CANCELLING', 'FAILED'],
  REVIEW_REQUIRED: ['COMPLETED', 'SHARED', 'CANCELLING', 'FAILED'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  // Terminal states map to an empty list rather than being absent, so a lookup always
  // returns an answer and the "resume a finished task" mistake is impossible to make by
  // forgetting a key.
  COMPLETED: [],
  SHARED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
})

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state)
}

export function canTransition(from, to) {
  const allowed = TASK_TRANSITIONS[from]
  return allowed !== undefined && allowed.includes(to)
}

const DESCRIPTION_MAX = 20_000
const ASSIGNMENT_MODES = ['existing_bot', 'chief_auto', 'create_bot']
/** How long an approval's grant stays valid. A task not started in this window expires. */
const APPROVAL_TTL_SECONDS_DEFAULT = 60 * 60 * 24

export function assertDescription(description) {
  if (typeof description !== 'string') throw new TaskError('A task description must be a string', 'INVALID_DESCRIPTION')
  const value = description.trim()
  if (value.length === 0) throw new TaskError('A task description must not be empty', 'INVALID_DESCRIPTION')
  if (description.length > DESCRIPTION_MAX) throw new TaskError(`A task description must be at most ${DESCRIPTION_MAX} characters`, 'INVALID_DESCRIPTION')
  return value
}

function nowIso(now) {
  return now.toISOString()
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'task', ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), nowIso(now))
}

/** Append a room-visible progress record. Never carries owner-private detail. */
function taskEvent(db, { taskId, actorUserId, eventType, payload, now }) {
  const id = randomUUID()
  db.prepare(`INSERT INTO task_events (id, task_id, actor_user_id, event_type, public_payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, taskId, actorUserId ?? null, eventType, JSON.stringify(payload ?? {}), nowIso(now))
  return id
}

export function findTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}

export function findApprovalForTask(db, taskId) {
  return db.prepare('SELECT * FROM approvals WHERE task_id = ?').get(taskId)
}

/**
 * The last failure category a task published to its room, if any.
 *
 * The room's task list is drawn from `tasks`, which carries no event history; this is the one
 * redacted fact from that history the list needs so a failed task can say why without opening the
 * detail. It reads the stored public payload, which the progress route already restricted to an
 * upper-case category.
 */
export function latestProgressReason(db, taskId) {
  const row = db.prepare(`SELECT json_extract(public_payload_json, '$.reason') AS reason
    FROM task_events WHERE task_id = ? AND event_type = 'task.progress'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(taskId)
  return typeof row?.reason === 'string' && row.reason !== '' ? row.reason : undefined
}

export function listTaskEvents(db, taskId) {
  return db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, rowid').all(taskId)
}

/** Tasks in one room, newest first. Membership is the caller's responsibility to have proven. */
export function listTasksForRoom(db, roomId) {
  return db.prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at DESC').all(roomId)
}

/** Tasks awaiting one owner's decision, which is what their client shows as a queue. */
export function listPendingForOwner(db, ownerUserId) {
  return db.prepare(`SELECT * FROM tasks WHERE owner_user_id = ? AND state = 'PENDING_APPROVAL' ORDER BY created_at`).all(ownerUserId)
}

/**
 * Approved tasks that still have to start on this owner's Host.
 *
 * This is the owner's execution queue, not the room's task list: it exists so a Host that was
 * offline (or simply not watching the room) when the approval happened can still find the work.
 * Only `APPROVED` is listed — a task already moved to `QUEUED` had its grant consumed by some
 * Host, and re-listing it would invite a second Host to consume another grant for the same work.
 */
export function listApprovedForOwner(db, ownerUserId) {
  return db.prepare(`SELECT * FROM tasks WHERE owner_user_id = ? AND state = 'APPROVED' ORDER BY created_at`).all(ownerUserId)
}

// ---------------------------------------------------------------- creation

/**
 * Create a task that is waiting for its owner's decision.
 *
 * The requester must be a member of the room; the owner must be a member too, because a task
 * addressed to somebody who is not in the room has no conversation to belong to. The target
 * Bot must be one the owner actually published and that the requester may see — otherwise a
 * requester could name any Bot id and learn from the answer which ones exist.
 */
export function createTask(db, {
  roomId, requesterUserId, requesterDeviceId, ownerUserId, targetBotId, description,
  now = new Date(),
}) {
  const text = assertDescription(description)
  // A dissolved workgroup cannot take new work: nobody remains to watch it, and an approval taken
  // here could still be minted into a grant on the owner's machine.
  const roomRow = db.prepare('SELECT dissolved_at FROM rooms WHERE id = ?').get(roomId)
  if (roomRow !== undefined && roomRow.dissolved_at !== null && roomRow.dissolved_at !== undefined) {
    throw new TaskError('This workgroup has been dissolved, so it cannot take new tasks.', 'ROOM_DISSOLVED')
  }
  requireMember(db, { roomId, userId: requesterUserId })
  // The owner must also be in the room: a task is room-scoped, and its progress is posted
  // where the requester can see it.
  requireMember(db, { roomId, userId: ownerUserId })
  // A task may be addressed to the requester's own Bot: a workgroup carries the original group
  // chat's basic ability to put its own Bots to work. `decideTask` still makes the owner the only
  // approver, so a task to yourself is approved, granted and audited exactly like any other, and
  // no cross-user authority is implied by it.
  if (targetBotId !== undefined && targetBotId !== null) {
    if (!isBotInRoom(db, { roomId, ownerUserId, botId: targetBotId })) {
      throw new TaskError('That Bot is not a member of this workgroup', 'BOT_NOT_AVAILABLE')
    }
  }

  const id = randomUUID()
  const createdAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO tasks
      (id, room_id, requester_user_id, owner_user_id, target_bot_id, description, state, version, revocation_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 0, 0, ?, ?)`)
      .run(id, roomId, requesterUserId, ownerUserId, targetBotId ?? null, text, createdAt, createdAt)
    taskEvent(db, { taskId: id, actorUserId: requesterUserId, eventType: 'task.created', payload: { state: 'PENDING_APPROVAL' }, now })
    audit(db, { actorUserId: requesterUserId, actorDeviceId: requesterDeviceId, eventType: 'task.created', objectId: id, outcome: 'success', details: { roomId, ownerUserId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return findTask(db, id)
}

/**
 * Move a task, enforcing the transition table and optimistic version under the write lock.
 *
 * @param {object} db
 * @param {{ taskId: string, to: string, expectedVersion: number, actorUserId?: string, actorDeviceId?: string, eventType?: string, payload?: object, extra?: object, now?: Date }} options
 */
export function transition(db, options) {
  const { taskId, to, expectedVersion, actorUserId, actorDeviceId, eventType, payload, extra = {}, now = new Date() } = options
  if (!TASK_STATES.includes(to)) throw new TaskError(`Unknown task state ${to}`, 'UNKNOWN_STATE')
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  let updated
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    if (task === undefined) throw new TaskError('No such task', 'NO_SUCH_TASK')
    if (Number(expectedVersion) !== task.version) {
      // Two racing decisions must not both succeed; the loser retries against fresh state.
      throw new TaskError(`This task has moved on (expected version ${expectedVersion}, current ${task.version})`, 'VERSION_CONFLICT')
    }
    if (!canTransition(task.state, to)) {
      throw new TaskError(`A task in ${task.state} cannot become ${to}`, 'ILLEGAL_TRANSITION')
    }
    const columns = { ...extra }
    const assignments = ['state = ?', 'version = version + 1', 'updated_at = ?']
    const values = [to, stamp]
    for (const [column, value] of Object.entries(columns)) {
      assignments.push(`${column} = ?`)
      values.push(value)
    }
    values.push(taskId, task.version)
    db.prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND version = ?`).run(...values)
    // Cancelling raises the revocation version: this is what invalidates a grant the local
    // executor already holds, without the Hub needing to reach into the owner's machine.
    if (to === 'CANCELLING' || to === 'CANCELLED') {
      db.prepare('UPDATE tasks SET revocation_version = revocation_version + 1 WHERE id = ?').run(taskId)
    }
    taskEvent(db, { taskId, actorUserId, eventType: eventType ?? `task.${to.toLowerCase()}`, payload: { state: to, ...payload }, now })
    audit(db, { actorUserId, actorDeviceId, eventType: `task.state.${to}`, objectId: taskId, outcome: 'success', now })
    db.exec('COMMIT')
    updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
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

// ---------------------------------------------------------------- approval

/**
 * Record the owner's decision.
 *
 * This is the single function that can move a task out of `PENDING_APPROVAL`, and it checks
 * three things that each matter on their own:
 *
 *  * the caller is the task's `owner_user_id` — not a room admin, not the requester, not the
 *    owner's Chief;
 *  * the decision is `approve` or `reject`, and an approval names a valid assignment mode;
 *  * an approval records the exact scope it granted, so the local executor can compare what
 *    it was told against what it is about to do.
 */
export function decideTask(db, {
  taskId, approverUserId, approverDeviceId, decision, expectedVersion,
  assignmentMode, assignedBotId, approvedScope, ttlSeconds = APPROVAL_TTL_SECONDS_DEFAULT, now = new Date(),
}) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new TaskError('A decision must be approve or reject', 'INVALID_DECISION')
  }
  const task = findTask(db, taskId)
  if (task === undefined) throw new TaskError('No such task', 'NO_SUCH_TASK')
  // Object-level authority: the owner decides, and nobody else. This is checked before the
  // transition so a wrong approver never even reaches the state machine.
  if (task.owner_user_id !== approverUserId) {
    throw new TaskError('Only the task owner may decide it', 'NOT_TASK_OWNER')
  }
  if (decision === 'approve') {
    if (assignmentMode !== undefined && !ASSIGNMENT_MODES.includes(assignmentMode)) {
      throw new TaskError(`An assignment mode must be one of ${ASSIGNMENT_MODES.join(', ')}`, 'INVALID_ASSIGNMENT_MODE')
    }
    if (assignmentMode === 'existing_bot' && (assignedBotId === undefined || assignedBotId === null)) {
      // Naming an existing Bot without saying which one is a request the executor cannot
      // honour, so it is refused at approval time rather than discovered at run time.
      throw new TaskError('Choosing an existing Bot requires its botId', 'MISSING_ASSIGNED_BOT')
    }
    if (assignedBotId !== undefined && assignedBotId !== null) {
      const visible = isVisibleTo(db, { ownerUserId: approverUserId, botId: assignedBotId, viewerUserId: approverUserId })
      if (!visible) throw new TaskError('That Bot is not in your directory', 'BOT_NOT_IN_DIRECTORY')
    }
  }

  const decidedAt = nowIso(now)
  const expiresAt = decision === 'approve' ? new Date(now.getTime() + ttlSeconds * 1000).toISOString() : null
  const scope = {
    // The scope is recorded verbatim so the local executor and the Hub agree on what was
    // granted. It is the owner's statement, so the Hub does not invent defaults for it.
    ...(approvedScope ?? {}),
    requesterUserId: task.requester_user_id,
    ownerUserId: task.owner_user_id,
    roomId: task.room_id,
    taskId: task.id,
    ...(assignmentMode === undefined ? {} : { assignmentMode }),
    ...(assignedBotId === undefined || assignedBotId === null ? {} : { assignedBotId }),
  }

  db.exec('BEGIN IMMEDIATE')
  let updated
  try {
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
    if (current === undefined) throw new TaskError('No such task', 'NO_SUCH_TASK')
    if (current.owner_user_id !== approverUserId) throw new TaskError('Only the task owner may decide it', 'NOT_TASK_OWNER')
    if (Number(expectedVersion) !== current.version) {
      throw new TaskError(`This task has moved on (expected version ${expectedVersion}, current ${current.version})`, 'VERSION_CONFLICT')
    }
    if (current.state !== 'PENDING_APPROVAL') {
      throw new TaskError(`This task was already decided (${current.state})`, 'ALREADY_DECIDED')
    }
    const to = decision === 'approve' ? 'APPROVED' : 'REJECTED'
    if (!canTransition(current.state, to)) throw new TaskError(`A task in ${current.state} cannot become ${to}`, 'ILLEGAL_TRANSITION')

    // `approvals.task_id` is unique, so a second decision for the same task is a database
    // error rather than a silent overwrite of the first.
    db.prepare(`INSERT INTO approvals
      (id, task_id, approver_user_id, approver_device_id, decision, scope_json, expires_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), taskId, approverUserId, approverDeviceId, decision, JSON.stringify(scope), expiresAt, decidedAt)

    db.prepare(`UPDATE tasks SET state = ?, version = version + 1, updated_at = ?,
      assignment_mode = ?, assigned_bot_id = ? WHERE id = ? AND version = ?`)
      .run(to, decidedAt,
        assignmentMode ?? null,
        assignedBotId ?? null,
        taskId, current.version)

    taskEvent(db, {
      taskId, actorUserId: approverUserId,
      eventType: decision === 'approve' ? 'task.approved' : 'task.rejected',
      // The dispatch mode is **not** part of the public payload. `task_events.public_payload_json`
      // is what `listTaskEvents` serves to every member of the room, and the mode names how the
      // owner's machine will run the work — a fact about that machine. The state is what the room
      // needs; the mode is recorded on the task row, where only the owner reads it.
      payload: { state: to },
      now,
    })
    audit(db, { actorUserId: approverUserId, actorDeviceId: approverDeviceId, eventType: `task.${decision}`, objectId: taskId, outcome: 'success', now })
    db.exec('COMMIT')
    updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    if (/UNIQUE constraint failed: approvals\.task_id/.test(error.message)) {
      throw new TaskError('This task was already decided', 'ALREADY_DECIDED')
    }
    throw error
  }
  return updated
}

// ---------------------------------------------------------------- cancellation

/**
 * Request cancellation and revoke any grant that was issued.
 *
 * The requester, the owner, or a room admin may cancel: the requester no longer wants the
 * work, the owner may withdraw consent, and an admin may stop something disruptive to the
 * room. The revocation version bump is what makes the owner's local executor refuse to
 * continue — the Hub cannot reach that machine, so it publishes a fact the machine checks.
 */
export function cancelTask(db, { taskId, actorUserId, actorDeviceId, now = new Date() }) {
  const task = findTask(db, taskId)
  if (task === undefined) throw new TaskError('No such task', 'NO_SUCH_TASK')
  const isRequester = task.requester_user_id === actorUserId
  const isOwner = task.owner_user_id === actorUserId
  let isAdmin = false
  try {
    const membership = requireMember(db, { roomId: task.room_id, userId: actorUserId })
    isAdmin = membership.role === 'owner' || membership.role === 'admin'
  } catch (error) {
    if (!(error instanceof RoomError)) throw error
  }
  if (!isRequester && !isOwner && !isAdmin) {
    throw new TaskError('Only the requester, the owner, or a room admin may cancel this task', 'NOT_ALLOWED_TO_CANCEL')
  }
  if (isTerminal(task.state)) {
    throw new TaskError(`This task is already ${task.state}`, 'ALREADY_TERMINAL')
  }

  // From a state that has not started, cancellation is immediate; a task already running is
  // asked to stop first, because a local process may be mid-step.
  const to = task.state === 'RUNNING' || task.state === 'REVIEW_REQUIRED' ? 'CANCELLING' : 'CANCELLED'
  const updated = transition(db, {
    taskId, to, expectedVersion: task.version, actorUserId, actorDeviceId,
    eventType: 'task.cancelled', payload: { state: to, cancelledBy: actorUserId }, now,
  })
  return updated
}

/** Operator-initiated cancellation used by Hub administration dissolution. */
export function cancelTaskAsOperator(db, { taskId, actorOperatorId, now = new Date() }) {
  const task = findTask(db, taskId)
  if (task === undefined || isTerminal(task.state)) return task
  const to = task.state === 'RUNNING' || task.state === 'REVIEW_REQUIRED' ? 'CANCELLING' : 'CANCELLED'
  return transition(db, {
    taskId, to, expectedVersion: task.version, actorUserId: null, actorDeviceId: null,
    eventType: 'task.cancelled', payload: { state: to, cancelledBy: null, operator: actorOperatorId }, now,
  })
}

/**
 * Mark an approval whose window has passed as expired.
 *
 * A grant has a lifetime, and an owner who approved and then went home must not have work
 * start days later. The Hub does not run the clock for the executor — the executor checks
 * `expires_at` itself — but recording the expiry keeps the room's view honest.
 */
export function expireStaleApprovals(db, { now = new Date() } = {}) {
  const stamp = nowIso(now)
  const stale = db.prepare(`SELECT t.id, t.version FROM tasks t
    JOIN approvals a ON a.task_id = t.id
    WHERE t.state = 'PENDING_APPROVAL' AND a.expires_at IS NOT NULL AND a.expires_at <= ?`).all(stamp)
  const expired = []
  for (const row of stale) {
    try {
      transition(db, { taskId: row.id, to: 'EXPIRED', expectedVersion: row.version, eventType: 'task.expired', now })
      expired.push(row.id)
    } catch (error) {
      // A task decided between the query and the transition is not an error.
      if (!(error instanceof TaskError)) throw error
    }
  }
  return expired
}

/** The Hub's wire shape for a task. Never carries the owner's private execution detail. */
/**
 * The task's wire shape.
 *
 * `includeMachine` is the redaction gate, and it defaults to **false**: which Bot was chosen, in
 * which mode, and what scope it was granted all describe the owner's machine, and the room asked for
 * a result rather than an inventory of the machine that produced it. A caller that needs those fields
 * — the owner's own client, and the requester once the task has been shared — asks for them
 * explicitly, so a new route that forgets to think about redaction publishes the safe shape instead
 * of the leaky one.
 *
 * `includeScope` implies nothing about `includeMachine`: the scope is the owner's statement about
 * what may run, and it is only ever published to the owner or to a requester after a share.
 */
export function publicTask(task, { includeScope = false, includeMachine = false, approval, includeResult = false } = {}) {
  return {
    id: task.id,
    roomId: task.room_id,
    requesterUserId: task.requester_user_id,
    ownerUserId: task.owner_user_id,
    // The Bot the *requester named* is part of their own request, so it is theirs to see back. The
    // Bot the owner *chose* is not.
    targetBotId: task.target_bot_id ?? null,
    ...(includeMachine ? {
      assignedBotId: task.assigned_bot_id ?? null,
      assignmentMode: task.assignment_mode ?? null,
    } : {}),
    description: task.description,
    state: task.state,
    version: task.version,
    revocationVersion: task.revocation_version,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    // What the work produced. Born private like the scope: it is the owner's own output, and the
    // only act that publishes it to the room is a share, which writes it as a message.
    ...(includeResult && typeof task.result_text === 'string' ? { resultText: task.result_text } : {}),
    ...(approval === undefined ? {} : {
      approval: {
        decision: approval.decision,
        decidedAt: approval.decided_at,
        expiresAt: approval.expires_at ?? null,
        ...(includeScope ? { scope: JSON.parse(approval.scope_json) } : {}),
      },
    }),
  }
}

/**
 * Record what a finished task produced, on the owner's word.
 *
 * The owner's Host is the only writer: it ran the work, so it is the only party that knows the text.
 * Stored on the task rather than in the progress stream, because a progress line is room-visible
 * while a result is not until it is shared.
 *
 * @param {object} db
 * @param {{ taskId: string, ownerUserId: string, text: string, now?: Date }} options
 * @returns the updated task row
 */
export function recordTaskResult(db, { taskId, ownerUserId, text, now = new Date() }) {
  const task = findTask(db, taskId)
  if (task === undefined) throw new TaskError('No such task', 'NO_SUCH_TASK')
  if (task.owner_user_id !== ownerUserId) throw new TaskError('Only the task owner records its result', 'NOT_TASK_OWNER')
  if (isTerminal(task.state) && task.state === 'CANCELLED') {
    throw new TaskError('A cancelled task does not take a result', 'ILLEGAL_TRANSITION')
  }
  const value = String(text ?? '').trim()
  if (value === '') throw new TaskError('A result needs some text', 'INVALID_RESULT')
  db.prepare('UPDATE tasks SET result_text = ?, updated_at = ? WHERE id = ?').run(value, nowIso(now), taskId)
  return findTask(db, taskId)
}

export function publicTaskEvent(event) {
  return {
    id: event.id,
    taskId: event.task_id,
    eventType: event.event_type,
    actorUserId: event.actor_user_id ?? null,
    payload: JSON.parse(event.public_payload_json),
    createdAt: event.created_at,
  }
}

/** A room's redacted event stream, joined through its tasks. */
export function listTaskEventsForRoom(db, { roomId, limit = 100, before } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, 200))
  const rows = db.prepare(`
    SELECT e.* FROM task_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE t.room_id = ? ${before === undefined ? '' : 'AND e.created_at < ?'}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ?`).all(...(before === undefined ? [roomId, capped] : [roomId, before, capped]))
  return rows.reverse().map(publicTaskEvent)
}

/** Non-terminal tasks that name this Bot as target or executor. */
export function openTaskIdsForBot(db, { roomId, ownerUserId, botId }) {
  return db.prepare(`SELECT id FROM tasks
    WHERE room_id = ? AND owner_user_id = ?
      AND (target_bot_id = ? OR assigned_bot_id = ?)
      AND state NOT IN ('COMPLETED','SHARED','REJECTED','EXPIRED','CANCELLED','FAILED')`)
    .all(roomId, ownerUserId, botId, botId).map(row => row.id)
}

/** Cancel a Bot's open tasks after its room membership has been removed. */
export function cancelOpenTasksForBot(db, {
  roomId, ownerUserId, botId, actorUserId, actorDeviceId, now = new Date(),
}) {
  const cancelled = []
  for (const taskId of openTaskIdsForBot(db, { roomId, ownerUserId, botId })) {
    try {
      cancelTask(db, { taskId, actorUserId, actorDeviceId, now })
      cancelled.push(taskId)
    } catch (error) {
      if (error?.code !== 'ALREADY_TERMINAL') throw error
    }
  }
  return cancelled
}

export const taskInternals = { APPROVAL_TTL_SECONDS_DEFAULT, DESCRIPTION_MAX, ASSIGNMENT_MODES }
