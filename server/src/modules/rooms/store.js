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
const ROOM_NOTICE_MAX = 2000
const ROOM_WORK_DIR_MAX = 1024
const ROOM_SUMMARY_PREVIEW_MAX = 80
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

/** The notice is shared instructions, not a message: it has the local-group limit. */
export function assertRoomNotice(notice) {
  const value = String(notice ?? '').trim()
  if (value.length > ROOM_NOTICE_MAX) {
    throw new RoomError(`A room notice may be at most ${ROOM_NOTICE_MAX} characters`, 'INVALID_ROOM_NOTICE')
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

function audit(db, { actorUserId, actorDeviceId, actorOperatorId, eventType, objectType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, actor_operator_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      actorUserId ?? null,
      actorDeviceId ?? null,
      actorOperatorId ?? null,
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

/** Every mutating room route asks this before changing a row. */
export function requireLiveRoom(db, { roomId, userId }) {
  const membership = requireMember(db, { roomId, userId })
  const room = findRoom(db, roomId)
  if (room === undefined) throw new RoomError('No such room', 'NO_SUCH_ROOM')
  if (isDissolved(room)) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
  return { room, membership }
}

/**
 * The columns every room read needs, with the one derived fact publicRoom depends on.
 *
 * `leader_active` answers "is the Bot named as leader still a leading member of this room": the row
 * must still be an active `room_bots` entry *and* still be its owner's Main Bot. Computing it in the
 * read is what keeps "the leader is gone" from being re-derived by each caller, which is how a
 * client and the server end up disagreeing about who answers.
 */
const ROOM_SELECT = `r.*,
  CASE WHEN r.admin_bot_id IS NOT NULL AND rb.room_id IS NOT NULL THEN 1 ELSE 0 END AS leader_active`
const ROOM_LEADER_JOIN = `LEFT JOIN room_bots rb
  ON rb.room_id = r.id
  AND rb.owner_user_id = r.admin_bot_owner_user_id
  AND rb.bot_id = r.admin_bot_id
  AND rb.removed_at IS NULL
  AND rb.is_chief = 1`

export function findRoom(db, roomId) {
  return db.prepare(`SELECT ${ROOM_SELECT} FROM rooms r ${ROOM_LEADER_JOIN} WHERE r.id = ?`).get(roomId)
}

export function listRoomsFor(db, userId) {
  return db.prepare(`
    SELECT ${ROOM_SELECT}, m.role AS member_role, m.joined_at AS member_joined_at
    FROM rooms r
    ${ROOM_LEADER_JOIN}
    JOIN room_members m ON m.room_id = r.id
    WHERE m.user_id = ? AND m.removed_at IS NULL
    ORDER BY r.created_at
  `).all(userId)
}

/**
 * The caller's rooms with the sidebar summary, in one query.
 *
 * The summary is deliberately batched: a list of twenty rooms must not become twenty extra
 * reads per field group. Each correlated subquery is indexed by a room id, while the caller's
 * own pending approvals are counted separately from every other member's.
 */
export function listRoomSummariesFor(db, userId) {
  return db.prepare(`
    SELECT ${ROOM_SELECT}, m.role AS member_role, m.joined_at AS member_joined_at,
      (SELECT COUNT(*) FROM room_members rm
        WHERE rm.room_id = r.id AND rm.removed_at IS NULL) AS member_count,
      (SELECT COUNT(*) FROM room_bots count_rb
        WHERE count_rb.room_id = r.id AND count_rb.removed_at IS NULL) AS bot_count,
      lm.created_at AS last_message_at,
      lm.body AS last_message_body,
      COALESCE(lm.room_seq, 0) AS last_message_seq,
      (SELECT COUNT(*) FROM tasks t
        WHERE t.room_id = r.id AND t.owner_user_id = ? AND t.state = 'PENDING_APPROVAL') AS pending_approval_count
    FROM rooms r
    ${ROOM_LEADER_JOIN}
    JOIN room_members m ON m.room_id = r.id
    LEFT JOIN messages lm ON lm.room_id = r.id
      AND lm.room_seq = (SELECT MAX(room_seq) FROM messages WHERE room_id = r.id)
    WHERE m.user_id = ? AND m.removed_at IS NULL
    ORDER BY r.created_at
  `).all(userId, userId)
}

/** A message preview is one line: controls and newlines collapse to spaces, then it is cut. */
function summarizeMessageBody(body) {
  if (typeof body !== 'string') return ''
  return body.replace(/\s+/g, ' ').trim().slice(0, ROOM_SUMMARY_PREVIEW_MAX)
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
 * The Bot that leads a new workgroup, or throw.
 *
 * The same two rules the original group chat has, applied to a Hub room: at least two Bots, and a
 * leader among them that is its owner's Main Bot (`roster.createRoom`'s `checkMembers` and
 * `members.find(rt.isMain)`). The standing is read from what the owner's machine reported, which is
 * what makes "the leader is the group owner's administrator" a checked fact rather than a claim.
 *
 * The leader is *generated* when the caller names none, exactly as a local group picks its first
 * Main Bot: the UI has no "choose the administrator" step, so requiring one here would make every
 * workgroup a 400. `adminBotId` stays supported — and stays validated — for callers that do know
 * which Bot should lead, such as a later hand-over or a script.
 *
 * @param {{ joiningBots: object[], adminBotId?: string }} options
 * @returns the directory row of the leading Bot
 * @throws {RoomError} `INVALID_BOT_COUNT` below two Bots, `NOT_A_CHIEF_BOT` when the named leader is
 *   absent or not a Main Bot, or when no Main Bot is joining at all.
 */
function resolveLeader({ joiningBots, adminBotId }) {
  if (joiningBots.length < 2) {
    throw new RoomError('A workgroup needs at least two Bots: the owner\'s Main Bot and one more', 'INVALID_BOT_COUNT')
  }
  const named = typeof adminBotId === 'string' ? adminBotId.trim() : ''
  if (named === '') {
    const chief = joiningBots.find(entry => entry.is_chief === 1)
    if (chief === undefined) {
      throw new RoomError('A workgroup needs your Main Bot in it: publish one, then add it to this workgroup', 'NOT_A_CHIEF_BOT')
    }
    return chief
  }
  const leader = joiningBots.find(entry => entry.bot_id === named)
  if (leader === undefined || leader.is_chief !== 1) {
    throw new RoomError('The workgroup administrator must be your own Main Bot and must join the room', 'NOT_A_CHIEF_BOT')
  }
  return leader
}

/**
 * Create a room with the creator as owner.
 *
 * Room and owner membership are written in one transaction: a room whose creator is not a
 * member would be unreachable by anyone, including the person who just made it.
 *
 * `kind` is recorded here rather than inferred later from members or name. The audit entry
 * carries it too, so "was this room ever a workgroup" is answerable from the trail alone.
 */
export function createRoom(db, { name, ownerUserId, ownerDeviceId, kind, botIds = [], adminBotId, actorOperatorId, now = new Date() }) {
  const roomName = assertRoomName(name)
  const roomKind = assertRoomKind(kind)
  // The creator's own Bots may join at creation. Validated before the transaction starts: a room
  // that was created and then failed to get its Bots would be a half-made workgroup the caller did
  // not ask for, and the Hub must not leave one behind on a bad request.
  const wantedBots = Array.isArray(botIds)
    ? [...new Set(botIds.map(value => String(value ?? '').trim()).filter(value => value !== ''))]
    : []
  const joiningBots = wantedBots.map((botId) => {
    const entry = db.prepare('SELECT bot_id, display_name, is_chief FROM bot_directory WHERE owner_user_id = ? AND bot_id = ?')
      .get(ownerUserId, botId)
    if (entry === undefined) throw new RoomError('That Bot is not published', 'NO_SUCH_BOT')
    return entry
  })
  // A workgroup's own rules, asked only of workgroups: an ordinary room has no Bot members and no
  // leader, and applying these to it would refuse every ordinary room the Hub admin creates.
  // A workgroup made by a person carries that person's Bots and needs a leader among them. A room an
  // operator creates from the Hub admin has no Bot members at all — it is a place colleagues are
  // added to — so asking it for a leader would refuse a room the operator is entitled to make. The
  // distinguishing fact is who is creating it, not the kind.
  const leader = roomKind === 'workgroup' && actorOperatorId === undefined
    ? resolveLeader({ joiningBots, adminBotId })
    : undefined
  const id = randomUUID()
  const createdAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO rooms
      (id, name, owner_user_id, next_seq, created_at, kind, reply_mode, admin_bot_owner_user_id, admin_bot_id)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(id, roomName, ownerUserId, createdAt, roomKind,
        leader === undefined ? 'everyone' : 'admin',
        leader === undefined ? null : ownerUserId,
        leader === undefined ? null : leader.bot_id)
    db.prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, ownerUserId, 'owner', createdAt)
    for (const entry of joiningBots) {
      db.prepare(`INSERT INTO room_bots
        (room_id, owner_user_id, bot_id, display_name, added_by_user_id, added_at, removed_at, is_chief)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(id, ownerUserId, entry.bot_id, entry.display_name, ownerUserId, createdAt, entry.is_chief === 1 ? 1 : 0)
    }
    audit(db, {
      actorUserId: actorOperatorId === undefined ? ownerUserId : null,
      actorDeviceId: ownerDeviceId,
      actorOperatorId,
      eventType: 'room.created',
      objectType: 'room',
      objectId: id,
      outcome: 'success',
      details: {
        name: roomName,
        kind: roomKind,
        ...(joiningBots.length === 0 ? {} : { botIds: joiningBots.map(entry => entry.bot_id) }),
        ...(leader === undefined ? {} : { adminBotId: leader.bot_id }),
        ...(actorOperatorId === undefined ? {} : { operator: true }),
      },
      now,
    })
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

export function renameRoom(db, { roomId, name, actorUserId, actorDeviceId, actorOperatorId, now = new Date() }) {
  const room = findRoom(db, roomId)
  if (room === undefined) throw new RoomError('No such room', 'NO_SUCH_ROOM')
  if (isDissolved(room)) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
  const roomName = assertRoomName(name)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(roomName, roomId)
    if (result.changes === 0) throw new RoomError('No such room', 'NO_SUCH_ROOM')
    audit(db, {
      actorUserId: actorOperatorId === undefined ? actorUserId : null,
      actorDeviceId,
      actorOperatorId,
      eventType: 'room.renamed',
      objectType: 'room',
      objectId: roomId,
      outcome: 'success',
      details: { name: roomName, ...(actorOperatorId === undefined ? {} : { operator: true }) },
      now,
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
  return findRoom(db, roomId)
}

/**
 * Who may change which of a workgroup's settings.
 *
 * Two different authorities, and keeping them apart is what makes the rule checkable:
 *
 *   * **governance** — the name, the notice, how answers are routed, the working folder, and who
 *     leads. The owner and whoever owns the leading Bot may set these, because the original group
 *     chat lets its administrator Bot change the group it leads.
 *   * **execution policy** — the permission preset. The owner alone sets this: it decides what every
 *     member's Bot may do on their own machines, so a Bot that could widen it would be giving itself
 *     authority its owner never granted.
 *
 * A plain member gets `NOT_ALLOWED`; a non-member never reaches here (`requireMember` answers first).
 *
 * @throws {RoomError} `NOT_ALLOWED` when the caller's standing does not cover the field.
 */
function assertSettingsAuthority(db, { room, actorUserId, changes }) {
  const membership = requireMember(db, { roomId: room.id, userId: actorUserId })
  const ownsLeader = room.admin_bot_owner_user_id === actorUserId && membership !== undefined
  const governanceOnly = changes.permission === undefined
  if (governanceOnly) {
    if (membership.role === 'owner' || ownsLeader) return
    throw new RoomError('Only the workgroup owner or its administrator\'s owner can change this', 'NOT_ALLOWED')
  }
  // A request that includes the permission preset is the owner's alone, whatever else it carries:
  // splitting one request across two authorities would let a governor widen the preset by attaching
  // it to a rename.
  const ownerOnly = changes.name === undefined && changes.notice === undefined
    && changes.replyMode === undefined && changes.workDir === undefined && changes.adminBot === undefined
  if (ownerOnly && membership.role === 'owner') return
  throw new RoomError('Only the workgroup owner can set its permissions', 'NOT_ALLOWED')
}

/** Update a room's profile and its workgroup governance fields. */
export function updateRoom(db, {
  roomId, name, notice, replyMode, workDir, permission, adminBot, actorUserId, actorDeviceId, now = new Date(),
}) {
  const room = findRoom(db, roomId)
  if (room === undefined) throw new RoomError('No such room', 'NO_SUCH_ROOM')
  if (isDissolved(room)) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
  assertSettingsAuthority(db, {
    room,
    actorUserId,
    changes: { name, notice, replyMode, workDir, permission, adminBot },
  })
  const roomName = name === undefined ? room.name : assertRoomName(name)
  const roomNotice = notice === undefined ? (room.notice ?? '') : assertRoomNotice(notice)
  const nextReplyMode = replyMode === undefined ? (room.reply_mode ?? 'everyone') : assertReplyMode(replyMode)
  const nextWorkDir = workDir === undefined ? (room.work_dir ?? null) : assertWorkDir(db, workDir)
  const nextPermission = permission === undefined ? (room.permission ?? null) : assertPermission(permission)
  const nextLeader = adminBot === undefined
    ? { ownerUserId: room.admin_bot_owner_user_id ?? null, botId: room.admin_bot_id ?? null }
    : resolveNewLeader(db, { room, adminBot })
  const changes = []
  if (name !== undefined && roomName !== room.name) changes.push({ name: roomName })
  if (notice !== undefined && roomNotice !== (room.notice ?? '')) changes.push({ notice: roomNotice })
  if (replyMode !== undefined && nextReplyMode !== (room.reply_mode ?? 'everyone')) changes.push({ replyMode: nextReplyMode })
  if (workDir !== undefined && nextWorkDir !== (room.work_dir ?? null)) changes.push({ workDir: nextWorkDir })
  if (permission !== undefined && nextPermission !== (room.permission ?? null)) changes.push({ permission: nextPermission })
  if (adminBot !== undefined) changes.push({ adminBot: nextLeader })
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE rooms SET name = ?, notice = ?, reply_mode = ?, work_dir = ?, permission = ?,
      admin_bot_owner_user_id = ?, admin_bot_id = ? WHERE id = ?`)
      .run(roomName, roomNotice, nextReplyMode, nextWorkDir, nextPermission,
        nextLeader.ownerUserId, nextLeader.botId, roomId)
    audit(db, {
      actorUserId,
      actorDeviceId,
      eventType: 'room.updated',
      objectType: 'room',
      objectId: roomId,
      outcome: 'success',
      details: {
        ...(name === undefined ? {} : { name: roomName }),
        ...(notice === undefined ? {} : { notice: roomNotice }),
        ...(replyMode === undefined ? {} : { replyMode: nextReplyMode }),
        ...(workDir === undefined ? {} : { workDir: nextWorkDir }),
        ...(permission === undefined ? {} : { permission: nextPermission }),
        ...(adminBot === undefined ? {} : { adminBot: nextLeader.botId }),
      },
      now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
    throw error
  }
  return { room: findRoom(db, roomId), changes }
}

/** How a room routes an unmentioned message. */
export function assertReplyMode(value) {
  if (value !== 'admin' && value !== 'everyone') {
    throw new RoomError('A reply mode must be admin or everyone', 'INVALID_REPLY_MODE')
  }
  return value
}

/**
 * The group working folder, as given.
 *
 * Kept as a string with no filesystem check, because the Hub does not run on the machines the folder
 * names: whether a path is usable is answered by each member's Host when it gets there, and a Hub that
 * refused a path it cannot see would reject a folder that is perfectly valid on the owner's machine.
 */
function assertWorkDir(db, value) {
  if (value === null || value === '') return null
  const path = String(value).trim()
  if (path.length === 0) return null
  if (path.length > ROOM_WORK_DIR_MAX) {
    throw new RoomError(`A working folder may be at most ${ROOM_WORK_DIR_MAX} characters`, 'INVALID_WORK_DIR')
  }
  return path
}

/** The group permission preset name, as given; each Host resolves it against its own catalog. */
function assertPermission(value) {
  if (value === null || value === '') return null
  const name = String(value).trim()
  if (name.length === 0) return null
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new RoomError('A permission preset name is lowercase letters, digits and dashes', 'INVALID_PERMISSION')
  }
  return name
}

/**
 * The leader a transfer names, or throw.
 *
 * `null` hands the room back to "everyone answers"; a named Bot must already be an active member of
 * this room *and* still be its owner's Main Bot. Both halves are checked here rather than trusted from
 * the client, so a transfer cannot install a Bot the owner never reported as a chief and cannot name a
 * Bot that is not in the room at all.
 */
function resolveNewLeader(db, { room, adminBot }) {
  if (adminBot === null) return { ownerUserId: null, botId: null }
  const ownerUserId = typeof adminBot?.ownerUserId === 'string' ? adminBot.ownerUserId.trim() : ''
  const botId = typeof adminBot?.botId === 'string' ? adminBot.botId.trim() : ''
  if (ownerUserId === '' || botId === '') {
    throw new RoomError('A new administrator needs its owner and its Bot id', 'INVALID_ADMIN_BOT')
  }
  const active = db.prepare(`SELECT is_chief FROM room_bots
    WHERE room_id = ? AND owner_user_id = ? AND bot_id = ? AND removed_at IS NULL`).get(room.id, ownerUserId, botId)
  if (active === undefined) throw new RoomError('That Bot is not in this workgroup', 'NOT_A_CHIEF_BOT')
  if (active.is_chief !== 1) throw new RoomError('The workgroup administrator must be that member\'s Main Bot', 'NOT_A_CHIEF_BOT')
  return { ownerUserId, botId }
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
  if (isDissolved(findRoom(db, roomId))) throw new InvitationError('This workgroup has been dissolved', 'ROOM_DISSOLVED')

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
  if (isDissolved(room)) throw new InvitationError('This workgroup has been dissolved', 'ROOM_DISSOLVED')

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
export function removeMember(db, { roomId, userId, actorUserId, actorDeviceId, actorOperatorId, now = new Date() }) {
  if (isDissolved(findRoom(db, roomId))) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
  const membership = membershipOf(db, { roomId, userId })
  if (membership === undefined) throw new RoomError('That user is not a member', 'NOT_A_MEMBER')
  if (membership.role === 'owner') throw new RoomError('The room owner cannot be removed', 'CANNOT_REMOVE_OWNER')
  if (actorOperatorId === undefined && userId === actorUserId) throw new RoomError('Use leave to remove yourself', 'CANNOT_REMOVE_SELF')

  const removedAt = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE room_members SET removed_at = ? WHERE room_id = ? AND user_id = ? AND removed_at IS NULL')
      .run(removedAt, roomId, userId)
    db.prepare("UPDATE invitations SET status = 'revoked' WHERE room_id = ? AND target_user_id = ? AND status = 'pending'")
      .run(roomId, userId)
    audit(db, {
      actorUserId: actorOperatorId === undefined ? actorUserId : null,
      actorDeviceId,
      actorOperatorId,
      eventType: 'room.member_removed',
      objectType: 'room',
      objectId: roomId,
      outcome: 'success',
      details: { removedUserId: userId, ...(actorOperatorId === undefined ? {} : { operator: true }) },
      now,
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
  return { roomId, userId, removedAt }
}

/** Leave a room. The owner must transfer ownership first... which V1 does not offer. */
export function leaveRoom(db, { roomId, userId, deviceId, now = new Date() }) {
  if (isDissolved(findRoom(db, roomId))) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
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
  if (isDissolved(findRoom(db, roomId))) throw new RoomError('This workgroup has been dissolved', 'ROOM_DISSOLVED')
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

/**
 * Public shape of a room row for a response, including the caller's own role and its kind.
 *
 * `replyMode` is what the room was set to; `effectiveReplyMode` is what actually happens. They
 * differ in exactly one case — a room set to "admin leads" whose leader is no longer an active Main
 * Bot of the room — and reading the effective value here is what stops every client from
 * re-deriving that fallback differently.
 */
export function publicRoom(room) {
  const hasLeader = room.leader_active === 1 || room.leader_active === true
  const replyMode = room.reply_mode === 'admin' ? 'admin' : 'everyone'
  return {
    id: room.id,
    name: room.name,
    kind: room.kind ?? DEFAULT_ROOM_KIND,
    ownerUserId: room.owner_user_id,
    notice: room.notice ?? '',
    createdAt: room.created_at,
    replyMode,
    effectiveReplyMode: hasLeader ? replyMode : 'everyone',
    // Omitted while the workgroup is live, so every existing caller sees exactly what it saw before
    // this column existed. A client that wants the state asks for the field, and a client that does
    // not know about it is not handed a null it has to interpret.
    ...(room.dissolved_at === null || room.dissolved_at === undefined ? {} : { dissolvedAt: room.dissolved_at }),
    ...(room.member_role === undefined ? {} : { myRole: room.member_role }),
    // Each governance field is omitted when it has no value, like `dissolvedAt` above: a reader that
    // does not know the field is not handed a null it must interpret.
    ...(hasLeader ? { adminBotOwnerUserId: room.admin_bot_owner_user_id, adminBotId: room.admin_bot_id } : {}),
    ...(room.work_dir === null || room.work_dir === undefined ? {} : { workDir: room.work_dir }),
    ...(room.permission === null || room.permission === undefined ? {} : { permission: room.permission }),
  }
}

/**
 * The room list row: the existing room shape plus the sidebar's summary fields.
 *
 * These fields are flat rather than nested under one `summary` key because the roster reads them
 * directly (`lastMessageSeq` drives unread, `lastMessageAt` drives ordering). Empty rooms still
 * carry every field: no message is `null` time, empty preview and sequence 0, never an omitted key.
 */
export function publicRoomSummary(room) {
  return {
    ...publicRoom(room),
    memberCount: room.member_count ?? 0,
    botCount: room.bot_count ?? 0,
    lastMessageAt: room.last_message_at ?? null,
    lastMessagePreview: summarizeMessageBody(room.last_message_body),
    lastMessageSeq: room.last_message_seq ?? 0,
    pendingApprovalCount: room.pending_approval_count ?? 0,
  }
}

/**
 * Whether a workgroup has ended.
 *
 * A dissolved room is readable — that is how a member learns what happened — but it is not a place
 * work happens any more. Callers check this rather than the timestamp, so the rule lives in one
 * place.
 *
 * @returns `true` when the room ended.
 */
export function isDissolved(room) {
  return room !== undefined && room !== null && room.dissolved_at !== null && room.dissolved_at !== undefined
}

/**
 * End a workgroup: refuse further work, withdraw what was pending, keep everything that happened.
 *
 * Why a state and not a `DELETE`: `room_members` and `messages` cascade from `rooms`, so deleting the
 * row would erase the conversation. The requirement is that history and audit survive, so the room is
 * marked ended and every other row is left exactly as it was.
 *
 * The three side effects are each load-bearing:
 *
 *   * **Pending invitations are withdrawn.** An invitation into a workgroup that has ended would let
 *     somebody join a collaboration that no longer exists; the invitee would see a room that refuses
 *     everything they try.
 *   * **Unfinished tasks are cancelled.** An approval that outlives its room could still be minted into
 *     a grant, which would start real local work for a room nobody can watch any more. Terminal tasks
 *     are left alone: their outcome is history, and rewriting it would be a lie.
 *   * **The actor is recorded separately from the time**, so "who ended this" survives even if that
 *     person later leaves.
 *
 * Only the owner may dissolve. An admin may remove a member; ending the room is the owner's alone,
 * because it takes the room away from everyone in it.
 *
 * @throws {RoomError} `NOT_A_MEMBER` for a non-member (the route answers 404, so a guessed id is not
 *   confirmed), `ROOM_OWNER_REQUIRED` for a member who is not the owner, `ROOM_DISSOLVED` when it has
 *   already ended.
 */
export function dissolveRoom(db, { roomId, actorUserId, actorDeviceId, actorOperatorId, now = new Date() }) {
  if (actorOperatorId === undefined) {
    const membership = membershipOf(db, { roomId, userId: actorUserId })
    if (membership === undefined) throw new RoomError('No such room, or you are not a member', 'NOT_A_MEMBER')
    if (membership.role !== 'owner') {
      throw new RoomError('Only the workgroup owner can dissolve it. Ask the owner, or leave the workgroup.', 'ROOM_OWNER_REQUIRED')
    }
  } else {
    const room = findRoom(db, roomId)
    if (room === undefined || room.kind !== 'workgroup') throw new RoomError('No such room', 'NO_SUCH_ROOM')
  }
  const stamp = nowIso(now)
  const pendingTasks = []
  db.exec('BEGIN IMMEDIATE')
  try {
    // Re-read under the write lock: two dissolutions racing must produce one dissolution, and the
    // loser has to be told rather than silently succeed.
    const current = db.prepare('SELECT dissolved_at FROM rooms WHERE id = ?').get(roomId)
    if (current === undefined) throw new RoomError('No such room, or you are not a member', 'NOT_A_MEMBER')
    if (isDissolved(current)) throw new RoomError('This workgroup has already been dissolved', 'ROOM_DISSOLVED')

    const dissolvedBy = actorOperatorId === undefined ? actorUserId : null
    db.prepare('UPDATE rooms SET dissolved_at = ?, dissolved_by = ? WHERE id = ?').run(stamp, dissolvedBy, roomId)
    db.prepare("UPDATE invitations SET status = 'revoked' WHERE room_id = ? AND status = 'pending'").run(roomId)

    // Collected first so the caller can tell the room which tasks stopped, then cancelled with the
    // store's own transition so the state machine and its events stay the single source of truth.
    const unfinished = db.prepare(`SELECT id, state, version FROM tasks
      WHERE room_id = ? AND state NOT IN ('COMPLETED','SHARED','REJECTED','EXPIRED','CANCELLED','FAILED')`).all(roomId)
    for (const task of unfinished) pendingTasks.push(task)

    audit(db, {
      actorUserId: actorOperatorId === undefined ? actorUserId : null,
      actorDeviceId,
      actorOperatorId,
      eventType: 'room.dissolved',
      objectType: 'room',
      objectId: roomId,
      outcome: 'success',
      details: { pendingTasks: pendingTasks.length, ...(actorOperatorId === undefined ? {} : { operator: true }) },
      now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return { roomId, dissolvedAt: stamp, pendingTaskIds: pendingTasks.map(task => task.id) }
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
