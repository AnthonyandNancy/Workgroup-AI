// Explicit Bot membership in a room. This is deliberately separate from bot_directory:
// directory visibility answers "may this viewer discover/request this Bot?", while this module
// answers "is this Bot a member of this room?" The two must never be conflated.

import { randomUUID } from 'node:crypto'
import { isVisibleTo, findEntry, presenceOf } from '../bots/store.js'
import {
  RoomError, findRoom, isDissolved, membershipOf, requireMember, requireRoomAdmin,
} from './store.js'

export class RoomBotError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RoomBotError'
    this.code = code
  }
}

const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * How many Bots one member may bring into one workgroup.
 *
 * The original group chat holds twelve Bots in total; a workgroup's members are people on different
 * machines, so the ceiling is applied per member — the number answers "how many Bots may I put in
 * this room", which is the question the original limit was really about.
 */
const MEMBER_BOT_LIMIT = 12

function nowIso(now) {
  return now.toISOString()
}

function expiresAt(now) {
  return new Date(now.getTime() + INVITATION_TTL_SECONDS * 1000).toISOString()
}

function audit(db, {
  actorUserId, actorDeviceId, eventType, objectId, details, now,
}) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'room', ?, 'success', ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId,
      JSON.stringify(details ?? {}), now.toISOString())
}

function liveRoom(db, roomId) {
  const room = findRoom(db, roomId)
  if (room === undefined || room.kind !== 'workgroup') throw new RoomBotError('No such workgroup', 'NO_SUCH_ROOM')
  if (isDissolved(room)) throw new RoomBotError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
  return room
}

/** The one predicate every room-Bot authorization path uses. */
export function isBotInRoom(db, { roomId, ownerUserId, botId }) {
  return db.prepare(`SELECT 1 AS yes FROM room_bots
    WHERE room_id = ? AND owner_user_id = ? AND bot_id = ? AND removed_at IS NULL`).get(roomId, ownerUserId, botId) !== undefined
}

/**
 * A member's allowances in one room: at most one Main Bot, and the local group's twelve-Bot ceiling
 * counted per member.
 *
 * Both limits are per owner, not per room: "at most one chief" is what makes a leader meaningful,
 * and the twelve is the original group chat's ceiling applied to the Bots one person brings — two
 * colleagues each bringing twelve must not be told the room is full.
 *
 * @param {object} db
 * @param {{ roomId: string, ownerUserId: string, isChief: boolean, joining?: string }} options
 *   `joining` is the Bot about to join; omit it when only the current state is asked for.
 * @throws {RoomBotError} `CHIEF_BOT_LIMIT_REACHED` or `BOT_LIMIT_REACHED`.
 */
export function assertMemberBotQuota(db, { roomId, ownerUserId, isChief, joining }) {
  const active = db.prepare(`SELECT bot_id, is_chief FROM room_bots
    WHERE room_id = ? AND owner_user_id = ? AND removed_at IS NULL`).all(roomId, ownerUserId)
  const others = joining === undefined ? active : active.filter(row => row.bot_id !== joining)
  if (isChief && others.some(row => row.is_chief === 1)) {
    throw new RoomBotError('Each member may bring one Main Bot into a workgroup', 'CHIEF_BOT_LIMIT_REACHED')
  }
  if (others.length + 1 > MEMBER_BOT_LIMIT) {
    throw new RoomBotError(`Each member may bring at most ${MEMBER_BOT_LIMIT} Bots into a workgroup`, 'BOT_LIMIT_REACHED')
  }
}

export function listRoomBots(db, roomId, now = new Date()) {
  return db.prepare(`SELECT b.*, d.display_name AS directory_name, d.visibility, d.state, d.last_seen_at
    FROM room_bots b
    LEFT JOIN bot_directory d ON d.owner_user_id = b.owner_user_id AND d.bot_id = b.bot_id
    WHERE b.room_id = ? AND b.removed_at IS NULL
    ORDER BY b.added_at, b.owner_user_id, b.bot_id`).all(roomId).map(row => ({
    ownerUserId: row.owner_user_id,
    botId: row.bot_id,
    displayName: row.directory_name ?? row.display_name,
    presence: presenceOf(row, now),
    // The standing recorded when this Bot joined the room. Read from the membership row rather than
    // the directory so a Bot that stopped being its owner's Main Bot keeps an honest history here.
    isChief: row.is_chief === 1,
    ...(row.state === undefined || row.state === null ? {} : { state: row.state }),
    addedAt: row.added_at,
  }))
}

/**
 * Bots the caller may ask to join this room: their own (including private) plus every other
 * active member's Bot that `isVisibleTo` allows in this room context.
 *
 * A Bot already in the room is still returned with `inRoom: true`, because the settings UI has
 * to show both choices and the current state; filtering it out would make "already added" look
 * like "not offered". The wire shape is a whitelist so no directory column added later — model,
 * Session, path, tools — can be published by accident.
 */
export function listBotCandidates(db, { roomId, viewerUserId, now = new Date() }) {
  requireMember(db, { roomId, userId: viewerUserId })
  const rows = db.prepare(`
    SELECT d.owner_user_id, d.bot_id, d.display_name, d.visibility, d.state, d.last_seen_at,
      u.display_name AS owner_display_name,
      CASE WHEN rb.owner_user_id IS NULL THEN 0 ELSE 1 END AS in_room
    FROM bot_directory d
    JOIN users u ON u.id = d.owner_user_id
    JOIN room_members m ON m.room_id = ? AND m.user_id = d.owner_user_id AND m.removed_at IS NULL
    LEFT JOIN room_bots rb ON rb.room_id = ? AND rb.owner_user_id = d.owner_user_id
      AND rb.bot_id = d.bot_id AND rb.removed_at IS NULL
    WHERE d.owner_user_id = ? OR d.visibility <> 'private'
    ORDER BY u.display_name, d.display_name, d.owner_user_id, d.bot_id
  `).all(roomId, roomId, viewerUserId)
  return rows
    .filter(row => isVisibleTo(db, {
      ownerUserId: row.owner_user_id, botId: row.bot_id, viewerUserId, roomId,
    }))
    .map(row => ({
      ownerUserId: row.owner_user_id,
      ownerDisplayName: row.owner_display_name,
      botId: row.bot_id,
      displayName: row.display_name,
      presence: presenceOf(row, now),
      state: row.state,
      visibility: row.visibility,
      mine: row.owner_user_id === viewerUserId,
      inRoom: row.in_room === 1,
    }))
}

export function publicBotInvitation(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name ?? undefined,
    ownerUserId: row.owner_user_id,
    botId: row.bot_id,
    botDisplayName: row.display_name ?? row.bot_id,
    invitedByUserId: row.invited_by_user_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

function findInvitation(db, id) {
  return db.prepare(`SELECT i.*, r.name AS room_name, d.display_name
    FROM room_bot_invitations i
    JOIN rooms r ON r.id = i.room_id
    LEFT JOIN bot_directory d ON d.owner_user_id = i.owner_user_id AND d.bot_id = i.bot_id
    WHERE i.id = ?`).get(id)
}

export function listBotInvitationsFor(db, ownerUserId, now = new Date()) {
  return db.prepare(`SELECT i.*, r.name AS room_name, d.display_name
    FROM room_bot_invitations i
    JOIN rooms r ON r.id = i.room_id
    LEFT JOIN bot_directory d ON d.owner_user_id = i.owner_user_id AND d.bot_id = i.bot_id
    WHERE i.owner_user_id = ? AND i.status = 'pending' AND i.expires_at > ?
    ORDER BY i.created_at`).all(ownerUserId, nowIso(now)).map(publicBotInvitation)
}

export function addOwnBot(db, { roomId, actorUserId, actorDeviceId, botId, now = new Date() }) {
  liveRoom(db, roomId)
  requireMember(db, { roomId, userId: actorUserId })
  const entry = findEntry(db, { ownerUserId: actorUserId, botId })
  if (entry === undefined) throw new RoomBotError('That Bot is not published', 'NO_SUCH_BOT')
  const active = isBotInRoom(db, { roomId, ownerUserId: actorUserId, botId })
  if (active) return { ownerUserId: actorUserId, botId, displayName: entry.display_name, addedAt: entry.updated_at }
  assertMemberBotQuota(db, { roomId, ownerUserId: actorUserId, isChief: entry.is_chief === 1, joining: botId })
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO room_bots
      (room_id, owner_user_id, bot_id, display_name, added_by_user_id, added_at, removed_at, is_chief)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(room_id, owner_user_id, bot_id) DO UPDATE SET
        display_name = excluded.display_name, added_by_user_id = excluded.added_by_user_id,
        added_at = excluded.added_at, removed_at = NULL, is_chief = excluded.is_chief`)
      .run(roomId, actorUserId, botId, entry.display_name, actorUserId, stamp, entry.is_chief === 1 ? 1 : 0)
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.bot_added', objectId: roomId, details: { ownerUserId: actorUserId, botId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    throw error
  }
  return { ownerUserId: actorUserId, botId, displayName: entry.display_name, addedAt: stamp }
}

export function inviteBot(db, {
  roomId, actorUserId, actorDeviceId, ownerUserId, botId, now = new Date(),
}) {
  liveRoom(db, roomId)
  requireRoomAdmin(db, { roomId, userId: actorUserId })
  if (ownerUserId === actorUserId) throw new RoomBotError('Add your own Bot directly', 'OWN_BOT_DIRECT')
  requireMember(db, { roomId, userId: ownerUserId })
  const entry = findEntry(db, { ownerUserId, botId })
  if (entry === undefined || !isVisibleTo(db, { ownerUserId, botId, viewerUserId: actorUserId, roomId })) {
    throw new RoomBotError('That Bot is not available to you', 'NO_SUCH_BOT')
  }
  if (isBotInRoom(db, { roomId, ownerUserId, botId })) throw new RoomBotError('That Bot is already in the workgroup', 'ALREADY_IN_ROOM')
  // Asked before the invitation is created: an invitation into a room the owner cannot actually join
  // would sit there until it expired, and the refusal belongs at the moment somebody asks.
  assertMemberBotQuota(db, { roomId, ownerUserId, isChief: entry.is_chief === 1, joining: botId })
  const existing = db.prepare(`SELECT * FROM room_bot_invitations
    WHERE room_id = ? AND owner_user_id = ? AND bot_id = ? AND status = 'pending' AND expires_at > ?`)
    .get(roomId, ownerUserId, botId, nowIso(now))
  if (existing !== undefined) return publicBotInvitation(findInvitation(db, existing.id))
  const id = randomUUID()
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO room_bot_invitations
      (id, room_id, owner_user_id, bot_id, invited_by_user_id, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, roomId, ownerUserId, botId, actorUserId, expiresAt(now), stamp)
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.bot_invited', objectId: roomId, details: { ownerUserId, botId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    throw error
  }
  return publicBotInvitation(findInvitation(db, id))
}

export function acceptBotInvitation(db, { invitationId, ownerUserId, actorDeviceId, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined || invitation.owner_user_id !== ownerUserId) {
    throw new RoomBotError('No such Bot invitation', 'NO_SUCH_INVITATION')
  }
  if (invitation.status !== 'pending') throw new RoomBotError('This Bot invitation is no longer pending', 'INVITATION_NOT_PENDING')
  if (invitation.expires_at <= nowIso(now)) {
    db.prepare("UPDATE room_bot_invitations SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(now), invitationId)
    throw new RoomBotError('This Bot invitation has expired', 'INVITATION_EXPIRED')
  }
  const room = liveRoom(db, invitation.room_id)
  requireMember(db, { roomId: room.id, userId: ownerUserId })
  const entry = findEntry(db, { ownerUserId, botId: invitation.bot_id })
  if (entry === undefined) throw new RoomBotError('That Bot is no longer published', 'NO_SUCH_BOT')
  // Re-checked at acceptance, not only at invitation: the owner may have joined with more Bots since
  // the invitation was sent, and the moment of joining is the moment the room has to stay valid.
  assertMemberBotQuota(db, { roomId: room.id, ownerUserId, isChief: entry.is_chief === 1, joining: invitation.bot_id })
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO room_bots
      (room_id, owner_user_id, bot_id, display_name, added_by_user_id, added_at, removed_at, is_chief)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(room_id, owner_user_id, bot_id) DO UPDATE SET
        display_name = excluded.display_name, added_by_user_id = excluded.added_by_user_id,
        added_at = excluded.added_at, removed_at = NULL, is_chief = excluded.is_chief`)
      .run(room.id, ownerUserId, invitation.bot_id, entry.display_name, invitation.invited_by_user_id, stamp, entry.is_chief === 1 ? 1 : 0)
    db.prepare("UPDATE room_bot_invitations SET status = 'accepted', resolved_at = ? WHERE id = ?").run(stamp, invitationId)
    audit(db, { actorUserId: ownerUserId, actorDeviceId, eventType: 'room.bot_added', objectId: room.id, details: { ownerUserId, botId: invitation.bot_id }, now })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    throw error
  }
  return { roomId: room.id, ownerUserId, botId: invitation.bot_id }
}

function resolveInvitation(db, { invitationId, actorUserId, decision, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined) throw new RoomBotError('No such Bot invitation', 'NO_SUCH_INVITATION')
  const isOwner = actorUserId === invitation.owner_user_id
  const isAdmin = (() => {
    const membership = membershipOf(db, { roomId: invitation.room_id, userId: actorUserId })
    return membership?.role === 'owner' || membership?.role === 'admin'
  })()
  if (!isOwner && !isAdmin) throw new RoomBotError('No such Bot invitation', 'NO_SUCH_INVITATION')
  if (invitation.status !== 'pending') throw new RoomBotError('This Bot invitation is no longer pending', 'INVITATION_NOT_PENDING')
  db.prepare('UPDATE room_bot_invitations SET status = ?, resolved_at = ? WHERE id = ? AND status = ?')
    .run(decision, nowIso(now), invitationId, 'pending')
  return publicBotInvitation(findInvitation(db, invitationId))
}

export function declineBotInvitation(db, { invitationId, actorUserId, now = new Date() }) {
  const invitation = findInvitation(db, invitationId)
  if (invitation === undefined || invitation.owner_user_id !== actorUserId) throw new RoomBotError('No such Bot invitation', 'NO_SUCH_INVITATION')
  return resolveInvitation(db, { invitationId, actorUserId, decision: 'declined', now })
}

export function revokeBotInvitation(db, { invitationId, actorUserId, now = new Date() }) {
  return resolveInvitation(db, { invitationId, actorUserId, decision: 'revoked', now })
}

export function removeRoomBot(db, { roomId, actorUserId, actorDeviceId, ownerUserId, botId, now = new Date() }) {
  liveRoom(db, roomId)
  const membership = requireMember(db, { roomId, userId: actorUserId })
  const canManage = membership.role === 'owner' || membership.role === 'admin'
  if (!canManage && actorUserId !== ownerUserId) throw new RoomBotError('You cannot remove that Bot', 'NOT_ALLOWED')
  const active = db.prepare(`SELECT * FROM room_bots WHERE room_id = ? AND owner_user_id = ? AND bot_id = ? AND removed_at IS NULL`)
    .get(roomId, ownerUserId, botId)
  if (active === undefined) throw new RoomBotError('That Bot is not in the workgroup', 'NOT_IN_ROOM')
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE room_bots SET removed_at = ? WHERE room_id = ? AND owner_user_id = ? AND bot_id = ?').run(stamp, roomId, ownerUserId, botId)
    audit(db, { actorUserId, actorDeviceId, eventType: 'room.bot_removed', objectId: roomId, details: { ownerUserId, botId }, now })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    throw error
  }
  return { roomId, ownerUserId, botId, removedAt: stamp }
}

/** Removing or losing a member also ends every Bot that member had in the room. */
export function removeBotsOwnedBy(db, { roomId, ownerUserId, actorUserId, actorDeviceId, now = new Date() }) {
  const rows = db.prepare(`SELECT bot_id FROM room_bots
    WHERE room_id = ? AND owner_user_id = ? AND removed_at IS NULL`).all(roomId, ownerUserId)
  if (rows.length === 0) return []
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE room_bots SET removed_at = ?
      WHERE room_id = ? AND owner_user_id = ? AND removed_at IS NULL`).run(stamp, roomId, ownerUserId)
    audit(db, {
      actorUserId, actorDeviceId, eventType: 'room.bot_removed', objectId: roomId,
      details: { ownerUserId, reason: 'member_removed', botIds: rows.map(row => row.bot_id) }, now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original */ }
    throw error
  }
  return rows.map(row => ({ roomId, ownerUserId, botId: row.bot_id, removedAt: stamp }))
}
