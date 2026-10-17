// Operator-only queries and mutations for the local-demo admin web.
//
// The public room/message stores are membership-scoped: a route calls `requireMember` before it
// reads anything. That is correct for clients and wrong for an operator, who is not a room member.
// This module is the narrow operator surface: it checks `operators`, enforces `kind='workgroup'`,
// writes operator-attributed audit rows, and reuses the existing room mutations where possible.

import { randomUUID } from 'node:crypto'
import { findUserById } from '../auth/store.js'
import {
  createRoom,
  dissolveRoom,
  findRoom,
  isDissolved,
  removeMember,
  renameRoom,
} from '../modules/rooms/store.js'

export class AdminError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AdminError'
    this.code = code
  }
}

const INSERT_AUDIT = `INSERT INTO audit_events
  (id, actor_operator_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

function nowIso(now = new Date()) {
  return now.toISOString()
}

/** Write an operator-attributed audit row without a user id or a message body. */
export function writeOperatorAudit(db, {
  operatorId,
  eventType,
  objectType,
  objectId,
  details = {},
  outcome = 'success',
  now = new Date(),
}) {
  db.prepare(INSERT_AUDIT).run(
    randomUUID(),
    operatorId,
    eventType,
    objectType,
    objectId ?? null,
    outcome,
    JSON.stringify(details),
    nowIso(now),
  )
}

function publicUser(row) {
  return {
    id: row.id,
    userHandle: row.user_handle,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  }
}

/** Read-only user search for owner/member selection. */
export function listUsers(db, { query = '', limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const pattern = `%${String(query ?? '').trim()}%`
  return db.prepare(`
    SELECT id, user_handle, display_name, status, created_at
    FROM users
    WHERE user_handle LIKE ? OR display_name LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(pattern, pattern, size).map(publicUser)
}

/** A single user with devices and workgroup memberships, for the admin detail view. */
export function findAdminUser(db, userId) {
  const user = db.prepare(`
    SELECT id, user_handle, display_name, status, created_at
    FROM users WHERE id = ?
  `).get(userId)
  if (user === undefined) return undefined
  const devices = db.prepare(`
    SELECT id, label, platform, app_version, last_seen_at, revoked_at, created_at
    FROM devices WHERE user_id = ? ORDER BY created_at
  `).all(userId).map(row => ({
    id: row.id,
    label: row.label ?? null,
    platform: row.platform ?? null,
    appVersion: row.app_version ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
  }))
  const workgroups = db.prepare(`
    SELECT r.id, r.name, r.dissolved_at, m.role, m.joined_at
    FROM rooms r
    JOIN room_members m ON m.room_id = r.id
    WHERE m.user_id = ? AND m.removed_at IS NULL AND r.kind = 'workgroup'
    ORDER BY r.created_at
  `).all(userId).map(row => ({
    id: row.id,
    name: row.name,
    role: row.role,
    joinedAt: row.joined_at,
    dissolvedAt: row.dissolved_at ?? null,
  }))
  return { ...publicUser(user), devices, workgroups }
}

function publicWorkgroup(row, members = undefined) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    ownerUserId: row.owner_user_id,
    ownerHandle: row.owner_handle,
    ownerDisplayName: row.owner_display_name,
    createdAt: row.created_at,
    dissolvedAt: row.dissolved_at ?? null,
    memberCount: Number(row.member_count ?? members?.length ?? 0),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at ?? null,
    ...(members === undefined ? {} : { members }),
  }
}

/** All workgroups, never ordinary rooms. */
export function listWorkgroups(db, { query = '', status = 'live', limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const where = ["r.kind = 'workgroup'"]
  const params = []
  const text = String(query ?? '').trim()
  if (text !== '') {
    where.push('r.name LIKE ?')
    params.push(`%${text}%`)
  }
  if (status === 'live') where.push('r.dissolved_at IS NULL')
  else if (status === 'dissolved') where.push('r.dissolved_at IS NOT NULL')
  params.push(size)
  return db.prepare(`
    SELECT r.id, r.name, r.kind, r.owner_user_id, r.created_at, r.dissolved_at,
           u.user_handle AS owner_handle, u.display_name AS owner_display_name,
           (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL) AS member_count,
           (SELECT count(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count,
           (SELECT max(msg.created_at) FROM messages msg WHERE msg.room_id = r.id) AS last_message_at
    FROM rooms r
    JOIN users u ON u.id = r.owner_user_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(...params).map(row => publicWorkgroup(row))
}

function requireWorkgroup(db, workgroupId) {
  const room = findRoom(db, workgroupId)
  if (room === undefined || room.kind !== 'workgroup') {
    throw new AdminError('No such workgroup', 'NO_SUCH_WORKGROUP')
  }
  return room
}

function requireLiveWorkgroup(db, workgroupId) {
  const room = requireWorkgroup(db, workgroupId)
  if (isDissolved(room)) throw new AdminError('This workgroup has been dissolved', 'WORKGROUP_DISSOLVED')
  return room
}

/** Workgroup detail, including live members. Ordinary rooms are answered as missing. */
export function findAdminWorkgroup(db, workgroupId) {
  const row = db.prepare(`
    SELECT r.id, r.name, r.kind, r.owner_user_id, r.created_at, r.dissolved_at,
           u.user_handle AS owner_handle, u.display_name AS owner_display_name,
           (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL) AS member_count,
           (SELECT count(*) FROM messages msg WHERE msg.room_id = r.id) AS message_count,
           (SELECT max(msg.created_at) FROM messages msg WHERE msg.room_id = r.id) AS last_message_at
    FROM rooms r
    JOIN users u ON u.id = r.owner_user_id
    WHERE r.id = ? AND r.kind = 'workgroup'
  `).get(workgroupId)
  if (row === undefined) return undefined
  const members = db.prepare(`
    SELECT m.user_id, m.role, m.joined_at, u.user_handle, u.display_name, u.status
    FROM room_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? AND m.removed_at IS NULL
    ORDER BY m.joined_at
  `).all(workgroupId).map(member => ({
    userId: member.user_id,
    userHandle: member.user_handle,
    displayName: member.display_name,
    role: member.role,
    status: member.status,
    joinedAt: member.joined_at,
  }))
  return publicWorkgroup(row, members)
}

/** Create a workgroup owned by a real active user; the operator is only the auditor. */
export function createWorkgroup(db, { name, ownerUserId, operatorId, now = new Date() }) {
  if (typeof ownerUserId !== 'string' || ownerUserId === '') {
    throw new AdminError('An owner user is required', 'INVALID_OWNER')
  }
  const owner = findUserById(db, ownerUserId)
  if (owner === undefined || owner.status !== 'active') {
    throw new AdminError('The owner must be an active user', 'INVALID_OWNER')
  }
  return createRoom(db, {
    name,
    ownerUserId,
    ownerDeviceId: null,
    kind: 'workgroup',
    actorOperatorId: operatorId,
    now,
  })
}

export function renameWorkgroup(db, { workgroupId, name, operatorId, now = new Date() }) {
  requireLiveWorkgroup(db, workgroupId)
  return renameRoom(db, {
    roomId: workgroupId,
    name,
    actorUserId: null,
    actorDeviceId: null,
    actorOperatorId: operatorId,
    now,
  })
}

export function dissolveWorkgroup(db, { workgroupId, operatorId, now = new Date() }) {
  requireLiveWorkgroup(db, workgroupId)
  return dissolveRoom(db, {
    roomId: workgroupId,
    actorUserId: null,
    actorDeviceId: null,
    actorOperatorId: operatorId,
    now,
  })
}

/** Add an existing active user directly; the invitation flow is for clients, not operators. */
export function addMember(db, { workgroupId, userId, operatorId, now = new Date() }) {
  const room = requireLiveWorkgroup(db, workgroupId)
  if (typeof userId !== 'string' || userId === '') {
    throw new AdminError('A member user is required', 'INVALID_MEMBER')
  }
  const user = findUserById(db, userId)
  if (user === undefined || user.status !== 'active') {
    throw new AdminError('The member must be an active user', 'INVALID_MEMBER')
  }
  const existing = db.prepare('SELECT removed_at FROM room_members WHERE room_id = ? AND user_id = ?').get(workgroupId, userId)
  if (existing !== undefined && existing.removed_at === null) {
    throw new AdminError('That user is already a member', 'ALREADY_A_MEMBER')
  }
  const joinedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO room_members (room_id, user_id, role, joined_at)
      VALUES (?, ?, 'member', ?)
      ON CONFLICT(room_id, user_id) DO UPDATE SET
        role = 'member', joined_at = excluded.joined_at, removed_at = NULL`)
      .run(room.id, userId, joinedAt)
    writeOperatorAudit(db, {
      operatorId,
      eventType: 'room.member_added',
      objectType: 'room',
      objectId: room.id,
      details: { userId },
      now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Keep the original failure visible.
    }
    throw error
  }
  return { roomId: workgroupId, userId, joinedAt }
}

export function removeMemberAsOperator(db, { workgroupId, userId, operatorId, now = new Date() }) {
  requireLiveWorkgroup(db, workgroupId)
  return removeMember(db, {
    roomId: workgroupId,
    userId,
    actorUserId: null,
    actorDeviceId: null,
    actorOperatorId: operatorId,
    now,
  })
}

/** Message bodies are operator-readable, but the public member route stays membership-scoped. */
export function listMessages(db, { workgroupId, beforeSeq, limit = 50 } = {}) {
  requireWorkgroup(db, workgroupId)
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const select = `
    SELECT m.id, m.room_id, m.room_seq, m.sender_user_id,
           u.user_handle AS sender_handle, u.display_name AS sender_display_name,
           m.body, m.reply_to_message_id, m.created_at
    FROM messages m
    JOIN users u ON u.id = m.sender_user_id
    WHERE m.room_id = ?`
  const rows = beforeSeq === undefined
    ? db.prepare(`${select} ORDER BY m.room_seq DESC LIMIT ?`).all(workgroupId, size)
    : db.prepare(`${select} AND m.room_seq < ? ORDER BY m.room_seq DESC LIMIT ?`).all(workgroupId, beforeSeq, size)
  const messages = rows.map(row => ({
    id: row.id,
    roomId: row.room_id,
    roomSeq: row.room_seq,
    senderUserId: row.sender_user_id,
    senderHandle: row.sender_handle,
    senderDisplayName: row.sender_display_name,
    body: row.body,
    createdAt: row.created_at,
    ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
  }))
  return {
    messages,
    nextBeforeSeq: messages.length === 0 ? (beforeSeq ?? null) : messages[messages.length - 1].roomSeq,
    hasMore: messages.length === size,
  }
}
