// Hub rooms: creation, membership, invitations, and the membership checks every other
// module asks for.
//
// One rule decides the shape of this module: **membership is checked in the database, on
// every access, never inferred from a client's claim.** A room id is not a secret — it
// travels in URLs and logs — so knowing one must grant nothing. Every read and write below
// starts from a membership row, and the routes above it cannot skip that step.
//
// Two further rules come from the acceptance criteria:
//
//  * An invitation is an explicit, expiring offer to one named user. Knowing a userId is
//    not permission to add that person, so the target must accept.
//  * Removal is a timestamp, not a delete. The audit trail keeps naming who was in the
//    room and when they left, and a member who was removed cannot be re-added implicitly
//    by an old invitation.

import { randomUUID } from 'node:crypto'

export class RoomError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RoomError'
    this.code = code
  }
}

const ROOM_NAME_MAX = 120
const INVITATION_TTL_SECONDS_DEFAULT = 60 * 60 * 24 * 7
export const ROOM_ROLES = ['owner', 'admin', 'member']
/** Roles an invitation may grant. Ownership is not transferable by invitation. */
export const INVITABLE_ROLES = ['admin', 'member']

/**
 * The kinds a room may be.
 *
 * `ordinary` is the default and the meaning every pre-existing room keeps; `workgroup` is a Hub
 * room whose members are real people on other machines and whose Bot work needs an approval.
 * The Hub owns this fact: a client asks for a kind at creation and then reads it back, because a
 * client that guessed would draw workgroup affordances over an ordinary room the moment a name
 * collided.
 */
export const ROOM_KINDS = ['ordinary', 'workgroup']
export const DEFAULT_ROOM_KIND = 'ordinary'

function nowIso(now) {
  return now.toISOString()
}

function isoPlusSeconds(now, seconds) {
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

export function assertRoomName(name) {
  const value = String(name ?? '').trim()
  if (value.length < 1 || value.length > ROOM_NAME_MAX) {
    throw new RoomError(`A room name must be 1-${ROOM_NAME_MAX} characters`, 'INVALID_ROOM_NAME')
  }
  return value
}

/**
 * The kind a room is being created as.
 *
 * An unrecognised kind is refused rather than quietly treated as `ordinary`. A caller that asked
 * for a workgroup and silently received an ordinary room would later find workgroup rules
 * missing, with nothing in any log to explain why — the failure would surface as a permission
 * that did not apply, long after the request that caused it.
 */
export function assertRoomKind(kind) {
  const value = kind ?? DEFAULT_ROOM_KIND
  if (!ROOM_KINDS.includes(value)) {
    throw new RoomError(`A room kind must be one of ${ROOM_KINDS.join(', ')}`, 'INVALID_ROOM_KIND')
  }
  return value
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      actorUserId ?? null,
      actorDeviceId ?? null,
      eventType,
      objectType,
      objectId ?? null,
      outcome,
      // Audit detail is a small caller-chosen map: never a message body, file path, or token.
      JSON.stringify(details ?? {}),
      nowIso(now),
    )
}

// ---------------------------------------------------------------- membership

/**
 * The caller's live membership row, or undefined.
 *
 * A `removed_at` stamp ends membership just as firmly as an absent row, so both cases
 * return undefined and no caller has to remember the second condition.
 */
export function membershipOf(db, { roomId, userId }) {
  const row = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId)
  if (row === undefined) return undefined
  return row.removed_at === null || row.removed_at === undefined ? row : undefined
}

export function isMember(db, { roomId, userId }) {
  return membershipOf(db, { roomId, userId }) !== undefined
}

export function isRoomAdmin(db, { roomId, userId }) {
  const membership = membershipOf(db, { roomId, userId })
  return membership !== undefined && (membership.role === 'owner' || membership.role === 'admin')
}

/**
 * Require a live membership, or throw.
 *
 * Routes call this before touching any room-scoped data. A non-member gets
 * `NOT_A_MEMBER`, and the route turns that into 404 rather than 403 so a prober cannot use
 * the status to learn that a room id exists.
 */
export function requireMember(db, { roomId, userId }) {
  const membership = membershipOf(db, { roomId, userId })
  if (membership === undefined) throw new RoomError('No such room, or you are not a member', 'NOT_A_MEMBER')
  return membership
}

export function requireRoomAdmin(db, { roomId, userId }) {
  const membership = requireMember(db, { roomId, userId })
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new RoomError('This action needs a room admin', 'NOT_A_ROOM_ADMIN')
  }
  return membership
}

export function findRoom(db, roomId) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
}

export function listRoomsFor(db, userId) {
  return db.prepare(`
    SELECT r.*, m.role AS member_role, m.joined_at AS member_joined_at
    FROM rooms r
    JOIN room_members m ON m.room_id = r.id
    WHERE m.user_id = ? AND m.removed_at IS NULL
    ORDER BY r.created_at
  `).all(userId)
}

export function listMembers(db, roomId) {
  return db.prepare(`
    SELECT m.*, u.user_handle, u.display_name, u.status AS user_status
    FROM room_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.room_id = ? AND m.removed_at IS NULL
    ORDER BY m.joined_at
  `).all(roomId)
}

// ---------------------------------------------------------------- creation

/**
 * Create a room with the creator as owner.
 *
 * Room and owner membership are written in one transaction: a room whose creator is not a
 * member would be unreachable by anyone, including the person who just made it.
 *
 * `kind` is recorded here rather than inferred later from members or name. The audit entry
 * carries it too, so "was this room ever a workgroup" is answerable from the trail alone.
 */
export function createRoom(db, { name, ownerUserId, ownerDeviceId, kind, now = new Date() }) {
  const roomName = assertRoomName(name)
  const roomKind = assertRoomKind(kind)
  const id = randomUUID()
  const createdAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO rooms (id, name, owner_user_id, next_seq, created_at, kind) VALUES (?, ?, ?, 1, ?, ?)')
      .run(id, roomName, ownerUserId, createdAt, roomKind)
    db.prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, ownerUserId, 'owner', createdAt)
    audit(db, { actorUserId: ownerUserId, actorDeviceId: ownerDeviceId, eventType: 'room.created', objectType: 'room', objectId: id, outcome: 'success', details: { name: roomName, kind: roomKind }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return findRoom(db, id)
}

export function renameRoom(db, { roomId, name, actorUserId, actorDeviceId, now = new Date() }) {
  const roomName = assertRoomName(name)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(roomName, roomId)
    if (result.changes === 0) throw new RoomError('No such room', 'NO_SUCH_ROOM')
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.renamed', objectType: 'room', objectId: roomId, outcome: 'success', details: { name: roomName }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return findRoom(db, roomId)
}

// ---------------------------------------------------------------- invitations

export class InvitationError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'InvitationError'
    this.code = code
  }
}

/** One invitation, with the room and inviter names the wire shape publishes. */
export function findInvitation(db, id) {
  // The joins are the same ones `listInvitationsFor` uses, because `publicInvitation` publishes
  // `roomName` and `inviterDisplayName` when they are present. Without them the *create* response
  // omitted the room name while the *list* response included it, so an inviter could not tell
  // which room a freshly sent invitation was for.
  return db.prepare(`
    SELECT i.*, r.name AS room_name, u.user_handle AS inviter_handle, u.display_name AS inviter_display_name
    FROM invitations i
    JOIN rooms r ON r.id = i.room_id
    JOIN users u ON u.id = i.inviter_user_id
    WHERE i.id = ?
  `).get(id)
}

/** Pending, unexpired invitations addressed to a user. */
export function listInvitationsFor(db, userId, now = new Date()) {
  return db.prepare(`
    SELECT i.*, r.name AS room_name, u.user_handle AS inviter_handle, u.display_name AS inviter_display_name
    FROM invitations i
    JOIN rooms r ON r.id = i.room_id
    JOIN users u ON u.id = i.inviter_user_id
    WHERE i.target_user_id = ? AND i.status = 'pending' AND i.expires_at > ?
    ORDER BY i.created_at
  `).all(userId, nowIso(now))
}

/**
 * Invite one named user to a room.
 *
 * The inviter must be a room admin; the target must be an active account. The invitation
 * names a role from `INVITABLE_ROLES`, so an invitation can never hand out ownership.
 * Re-inviting someone who already has a pending invitation returns that invitation instead
 * of accumulating them.
 */
export function createInvitation(db, {
  roomId, inviterUserId, inviterDeviceId, targetUserId, role = 'member',
  ttlSeconds = INVITATION_TTL_SECONDS_DEFAULT, now = new Date(),
}) {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new InvitationError(`An invitation role must be one of ${INVITABLE_ROLES.join(', ')}`, 'INVALID_ROLE')
  }
  const target = db.prepare('SELECT id, status FROM users WHERE id = ?').get(targetUserId)
  if (target === undefined) throw new InvitationError('No such user', 'NO_SUCH_USER')
  if (target.status !== 'active') throw new InvitationError('That account is disabled', 'ACCOUNT_DISABLED')

  // Inviting an existing member is a no-op the caller should hear about, not a silent
  // second membership row.
  if (isMember(db, { roomId, userId: targetUserId })) {
    throw new InvitationError('That user is already a member', 'ALREADY_A_MEMBER')
  }

  const existing = db.prepare(`SELECT * FROM invitations
    WHERE room_id = ? AND target_user_id = ? AND status = 'pending' AND expires_at > ?`)
    .get(roomId, targetUserId, nowIso(now))
  if (existing !== undefined) return existing

  const id = randomUUID()
  const createdAt = nowIso(now)
  const expiresAt = isoPlusSeconds(now, ttlSeconds)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO invitations (id, room_id, inviter_user_id, target_user_id, role, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, roomId, inviterUserId, targetUserId, role, expiresAt, createdAt)
    audit(db, { actorUserId: inviterUserId, actorDeviceId: inviterDeviceId, eventType: 'invitation.created', objectType: 'invitation', objectId: id, outcome: 'success', details: { roomId, role }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return findInvitation(db, id)
}

/**
 * Accept an invitation.
 *
 * Only the named recipient may accept: this is the object-level check that makes an
 * invitation an offer rather than an assignment. Expiry is evaluated at accept time, so a
 * stale invitation that was never cleaned up cannot be used.
 */
export function acceptInvitation(db, { invitationId, userId, deviceId, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined) throw new InvitationError('No such invitation', 'NO_SUCH_INVITATION')
  // A recipient mismatch is reported as "no such invitation" so an unrelated user cannot
  // use the response to confirm that an invitation id exists.
  if (invitation.target_user_id !== userId) throw new InvitationError('No such invitation', 'NO_SUCH_INVITATION')
  if (invitation.status !== 'pending') throw new InvitationError(`This invitation was already ${invitation.status}`, 'INVITATION_NOT_PENDING')
  if (invitation.expires_at <= nowIso(now)) {
    db.prepare("UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'").run(invitationId)
    throw new InvitationError('This invitation has expired', 'INVITATION_EXPIRED')
  }

  const room = findRoom(db, invitation.room_id)
  if (room === undefined) throw new InvitationError('The room no longer exists', 'NO_SUCH_ROOM')

  const joinedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    // Accepting re-activates a row whose membership was previously removed, rather than
    // leaving the old `removed_at` in place and silently granting nothing.
    db.prepare(`INSERT INTO room_members (room_id, user_id, role, joined_at, removed_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(room_id, user_id) DO UPDATE SET role = excluded.role, joined_at = excluded.joined_at, removed_at = NULL`)
      .run(invitation.room_id, userId, invitation.role, joinedAt)
    db.prepare("UPDATE invitations SET status = 'accepted' WHERE id = ? AND status = 'pending'").run(invitationId)
    audit(db, { actorUserId: userId, actorDeviceId: deviceId, eventType: 'invitation.accepted', objectType: 'invitation', objectId: invitationId, outcome: 'success', details: { roomId: invitation.room_id, role: invitation.role }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return { room: findRoom(db, invitation.room_id), membership: membershipOf(db, { roomId: invitation.room_id, userId }) }
}

export function declineInvitation(db, { invitationId, userId, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined || invitation.target_user_id !== userId) {
    throw new InvitationError('No such invitation', 'NO_SUCH_INVITATION')
  }
  if (invitation.status !== 'pending') throw new InvitationError(`This invitation was already ${invitation.status}`, 'INVITATION_NOT_PENDING')
  db.prepare("UPDATE invitations SET status = 'declined' WHERE id = ? AND status = 'pending'").run(invitationId)
  audit(db, { actorUserId: userId, eventType: 'invitation.declined', objectType: 'invitation', objectId: invitationId, outcome: 'success', now })
  return findInvitation(db, invitationId)
}

/** Withdraw a pending invitation. Only the inviter or a room admin may do it. */
export function revokeInvitation(db, { invitationId, actorUserId, actorDeviceId, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined) throw new InvitationError('No such invitation', 'NO_SUCH_INVITATION')
  const allowed = invitation.inviter_user_id === actorUserId
    || isRoomAdmin(db, { roomId: invitation.room_id, userId: actorUserId })
  if (!allowed) throw new InvitationError('Only the inviter or a room admin may withdraw this invitation', 'NOT_ALLOWED')
  if (invitation.status !== 'pending') throw new InvitationError(`This invitation was already ${invitation.status}`, 'INVITATION_NOT_PENDING')
  db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'").run(invitationId)
  audit(db, { actorUserId, actorDeviceId, eventType: 'invitation.revoked', objectType: 'invitation', objectId: invitationId, outcome: 'success', now })
  return findInvitation(db, invitationId)
}

// ---------------------------------------------------------------- removal

/**
 * Remove a member.
 *
 * The owner cannot be removed — a room with no owner has nobody who can administer it —
 * and nobody may remove themselves through this path (leaving is a separate intent).
 * Removal also revokes that member's pending invitations to the room, so a removal cannot
 * be undone by accepting an offer that was already in flight.
 */
export function removeMember(db, { roomId, userId, actorUserId, actorDeviceId, now = new Date() }) {
  const membership = membershipOf(db, { roomId, userId })
  if (membership === undefined) throw new RoomError('That user is not a member', 'NOT_A_MEMBER')
  if (membership.role === 'owner') throw new RoomError('The room owner cannot be removed', 'CANNOT_REMOVE_OWNER')
  if (userId === actorUserId) throw new RoomError('Use leave to remove yourself', 'CANNOT_REMOVE_SELF')

  const removedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE room_members SET removed_at = ? WHERE room_id = ? AND user_id = ? AND removed_at IS NULL')
      .run(removedAt, roomId, userId)
    db.prepare("UPDATE invitations SET status = 'revoked' WHERE room_id = ? AND target_user_id = ? AND status = 'pending'")
      .run(roomId, userId)
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.member_removed', objectType: 'room', objectId: roomId, outcome: 'success', details: { removedUserId: userId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return { roomId, userId, removedAt }
}

/** Leave a room. The owner must transfer ownership first... which V1 does not offer. */
export function leaveRoom(db, { roomId, userId, deviceId, now = new Date() }) {
  const membership = membershipOf(db, { roomId, userId })
  if (membership === undefined) throw new RoomError('No such room, or you are not a member', 'NOT_A_MEMBER')
  if (membership.role === 'owner') {
    throw new RoomError('The room owner cannot leave; remove the room or transfer ownership instead', 'OWNER_CANNOT_LEAVE')
  }
  const removedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE room_members SET removed_at = ? WHERE room_id = ? AND user_id = ? AND removed_at IS NULL')
      .run(removedAt, roomId, userId)
    db.prepare("UPDATE invitations SET status = 'revoked' WHERE room_id = ? AND target_user_id = ? AND status = 'pending'")
      .run(roomId, userId)
    audit(db, { actorUserId: userId, actorDeviceId: deviceId, eventType: 'room.left', objectType: 'room', objectId: roomId, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return { roomId, userId, removedAt }
}

export function setMemberRole(db, { roomId, userId, role, actorUserId, actorDeviceId, now = new Date() }) {
  if (!INVITABLE_ROLES.includes(role)) {
    throw new RoomError(`A member role must be one of ${INVITABLE_ROLES.join(', ')}`, 'INVALID_ROLE')
  }
  const membership = membershipOf(db, { roomId, userId })
  if (membership === undefined) throw new RoomError('That user is not a member', 'NOT_A_MEMBER')
  if (membership.role === 'owner') throw new RoomError("The owner's role cannot be changed", 'CANNOT_CHANGE_OWNER')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?').run(role, roomId, userId)
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.role_changed', objectType: 'room', objectId: roomId, outcome: 'success', details: { targetUserId: userId, role }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return membershipOf(db, { roomId, userId })
}

/** Public shape of a room row for a response, including the caller's own role and its kind. */
export function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    kind: room.kind ?? DEFAULT_ROOM_KIND,
    ownerUserId: room.owner_user_id,
    createdAt: room.created_at,
    ...(room.member_role === undefined ? {} : { myRole: room.member_role }),
  }
}

export function publicMember(member) {
  return {
    userId: member.user_id,
    userHandle: member.user_handle,
    displayName: member.display_name,
    role: member.role,
    joinedAt: member.joined_at,
    // Present only when the caller supplied it: this module has no opinion about connections, and
    // the route that does reaches the socket table through the realtime hub.
    ...(member.online === undefined ? {} : { online: member.online }),
  }
}

export function publicInvitation(invitation) {
  return {
    id: invitation.id,
    roomId: invitation.room_id,
    ...(invitation.room_name === undefined ? {} : { roomName: invitation.room_name }),
    inviterUserId: invitation.inviter_user_id,
    ...(invitation.inviter_display_name === undefined ? {} : { inviterDisplayName: invitation.inviter_display_name }),
    targetUserId: invitation.target_user_id,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expires_at,
    createdAt: invitation.created_at,
  }
}

export const roomInternals = { ROOM_NAME_MAX, INVITATION_TTL_SECONDS_DEFAULT }
