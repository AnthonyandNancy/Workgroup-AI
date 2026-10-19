// The remote Bot directory: what an owner publishes about their Bots, and what a colleague
// may see.
//
// Three rules shape this module, and all three exist because a directory is a discovery
// surface — the easiest place for a Hub to leak more than the product intends:
//
//  1. **Everything defaults to private.** A Bot that was never published is invisible to
//     everyone but its owner, and the Hub has no path that publishes it implicitly. A task
//     can name a private Bot only from its owner's own client, never from another user.
//  2. **Visibility is granted by the owner, per Bot.** `room` means members of a named room
//     may see it; `public` means any authenticated user on this Hub may. Neither is set by
//     someone else, and neither can be widened by the Bot itself.
//  3. **Presence is derived, not claimed.** A heartbeat updates `last_seen_at`; a client is
//     considered online only while its last heartbeat is fresh. A crashed client cannot
//     announce that it is gone, so believing the stored value would show a Bot as available
//     when nothing can answer for it.
//
// What the directory does NOT store, deliberately: model names, Session ids, capability
// lists, working directories, or anything about the owner's filesystem. A colleague needs to
// know a Bot exists and can be asked for work; everything else is the owner's business.

import { randomUUID } from 'node:crypto'
import { RoomError, membershipOf } from '../rooms/store.js'

export class DirectoryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DirectoryError'
    this.code = code
  }
}

export const VISIBILITIES = ['private', 'room', 'public']
/** A client is online while its heartbeat is this fresh. */
const PRESENCE_TTL_MS = 90_000
const BOT_ID_MAX = 128
const DISPLAY_NAME_MAX = 80

export function assertBotId(botId) {
  const value = String(botId ?? '').trim()
  if (value.length < 1 || value.length > BOT_ID_MAX) {
    throw new DirectoryError(`A botId must be 1-${BOT_ID_MAX} characters`, 'INVALID_BOT_ID')
  }
  return value
}

export function assertDisplayName(name) {
  const value = String(name ?? '').trim()
  if (value.length < 1 || value.length > DISPLAY_NAME_MAX) {
    throw new DirectoryError(`A Bot display name must be 1-${DISPLAY_NAME_MAX} characters`, 'INVALID_DISPLAY_NAME')
  }
  return value
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'bot', ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), now.toISOString())
}

/** Presence derived from the heartbeat, so a stale entry reads as offline. */
export function presenceOf(row, now = new Date()) {
  const seen = row?.last_seen_at
  if (typeof seen !== 'string') return 'offline'
  // A crashed client cannot announce its departure; the TTL is what makes "online" mean
  // "reachable a moment ago" rather than "was reachable at some point".
  return now.getTime() - Date.parse(seen) <= PRESENCE_TTL_MS ? 'online' : 'offline'
}

export function findEntry(db, { ownerUserId, botId }) {
  return db.prepare('SELECT * FROM bot_directory WHERE owner_user_id = ? AND bot_id = ?').get(ownerUserId, botId)
}

export function listOwnEntries(db, ownerUserId) {
  return db.prepare('SELECT * FROM bot_directory WHERE owner_user_id = ? ORDER BY display_name').all(ownerUserId)
}

/**
 * Publish or update one Bot's directory entry.
 *
 * Only the owner ever calls this with their own user id: the route takes the id from the
 * authenticated session, so a user cannot publish on another's behalf.
 */
export function publishEntry(db, {
  ownerUserId, ownerDeviceId, botId, displayName, visibility = 'private', isChief = false, now = new Date(),
}) {
  const id = assertBotId(botId)
  const name = assertDisplayName(displayName)
  if (!VISIBILITIES.includes(visibility)) {
    throw new DirectoryError(`Visibility must be one of ${VISIBILITIES.join(', ')}`, 'INVALID_VISIBILITY')
  }
  // A room's leader has to be its owner's Main Bot, and that fact is produced on the owner's
  // machine: `true` is the only value a client can send. Anything else is read as "not reported",
  // so an unrecognised payload cannot promote a Bot to chief.
  const chief = isChief === true ? 1 : 0
  const existing = findEntry(db, { ownerUserId, botId: id })
  const stamp = now.toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (existing === undefined) {
      // `last_seen_at` starts null on purpose. Publishing an entry records an intention to
      // share a Bot's existence; it says nothing about whether the owner's runtime is
      // running. Stamping "now" here would report every newly published Bot as online until
      // its first heartbeat aged out — the owner would appear reachable when nothing can
      // answer for them. Presence becomes `online` only when a heartbeat says so.
      db.prepare(`INSERT INTO bot_directory
        (owner_user_id, bot_id, display_name, visibility, state, updated_at, last_seen_at, published_at, is_chief)
        VALUES (?, ?, ?, ?, 'offline', ?, NULL, ?, ?)`)
        .run(ownerUserId, id, name, visibility, stamp, visibility === 'private' ? null : stamp, chief)
    } else {
      // `published_at` records when visibility last became broader than private; narrowing
      // back to private clears it so the field answers "what have I shared right now".
      const publishedAt = visibility === 'private'
        ? null
        : (existing.published_at ?? stamp)
      // A visibility change must not manufacture presence either.
      db.prepare(`UPDATE bot_directory
        SET display_name = ?, visibility = ?, updated_at = ?, published_at = ?, is_chief = ?
        WHERE owner_user_id = ? AND bot_id = ?`)
        .run(name, visibility, stamp, publishedAt, chief, ownerUserId, id)
    }
    audit(db, {
      actorUserId: ownerUserId, actorDeviceId: ownerDeviceId,
      eventType: existing === undefined ? 'bot.published' : 'bot.visibility_changed',
      objectId: id, outcome: 'success', details: { visibility }, now,
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
  return findEntry(db, { ownerUserId, botId: id })
}

/** Withdraw a Bot from the directory entirely. Its owner can always do this. */
export function withdrawEntry(db, { ownerUserId, ownerDeviceId, botId, now = new Date() }) {
  const entry = findEntry(db, { ownerUserId, botId: assertBotId(botId) })
  if (entry === undefined) throw new DirectoryError('No such directory entry', 'NO_SUCH_ENTRY')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM bot_directory WHERE owner_user_id = ? AND bot_id = ?').run(ownerUserId, entry.bot_id)
    audit(db, { actorUserId: ownerUserId, actorDeviceId: ownerDeviceId, eventType: 'bot.withdrawn', objectId: entry.bot_id, outcome: 'success', now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return entry
}

/**
 * Record a heartbeat for one Bot.
 *
 * The owner's client calls this; the Hub does not infer presence from a socket alone,
 * because a Bot is reachable only while its owner's runtime is running, which is a fact only
 * the client knows.
 */
export function heartbeat(db, { ownerUserId, botId, state, now = new Date() }) {
  const id = assertBotId(botId)
  const entry = findEntry(db, { ownerUserId, botId: id })
  if (entry === undefined) throw new DirectoryError('No such directory entry', 'NO_SUCH_ENTRY')
  const allowed = ['online', 'busy', 'offline']
  const nextState = state === undefined ? 'online' : String(state)
  if (!allowed.includes(nextState)) throw new DirectoryError(`State must be one of ${allowed.join(', ')}`, 'INVALID_STATE')
  db.prepare('UPDATE bot_directory SET last_seen_at = ?, state = ?, updated_at = ? WHERE owner_user_id = ? AND bot_id = ?')
    .run(now.toISOString(), nextState, now.toISOString(), ownerUserId, id)
  return findEntry(db, { ownerUserId, botId: id })
}

/**
 * Is this Bot visible to this viewer?
 *
 * `roomId` is supplied when the viewer is looking through a room context. A `room`-scoped
 * entry is visible only to a member of *a* room the owner shares; V1 has no per-room
 * publication, so the rule is "share a room with the owner". That is deliberately narrower
 * than "any member of any room", which would publish an owner's Bot to a room they never
 * joined.
 */
export function isVisibleTo(db, { ownerUserId, botId, viewerUserId, roomId }) {
  // The entry must exist before anything else is decided. An owner's own membership of the
  // directory is not implied by ownership: publishing is an explicit act, so a Bot the owner
  // never published must not resolve for anyone, including the owner themselves — otherwise
  // a task could name a Bot id that exists nowhere in the directory.
  const entry = findEntry(db, { ownerUserId, botId })
  if (entry === undefined) return false
  // An owner always sees their own entry, whatever its visibility.
  if (ownerUserId === viewerUserId) return true
  if (entry.visibility === 'public') return true
  if (entry.visibility === 'private') return false
  // `room` visibility: the viewer must be in a room the owner is also in.
  if (roomId !== undefined) {
    const viewer = membershipOf(db, { roomId, userId: viewerUserId })
    const owner = membershipOf(db, { roomId, userId: ownerUserId })
    if (viewer !== undefined && owner !== undefined) return true
  }
  return sharesAnyRoom(db, { leftUserId: ownerUserId, rightUserId: viewerUserId })
}

export function sharesAnyRoom(db, { leftUserId, rightUserId }) {
  const row = db.prepare(`
    SELECT 1 AS yes
    FROM room_members a
    JOIN room_members b ON b.room_id = a.room_id
    WHERE a.user_id = ? AND a.removed_at IS NULL
      AND b.user_id = ? AND b.removed_at IS NULL
    LIMIT 1
  `).get(leftUserId, rightUserId)
  return row !== undefined
}

/**
 * Browse the directory as `viewerUserId` — the discovery path.
 *
 * `ownerUserId` narrows to one person's published Bots. `query` matches the display name.
 * Only entries visible to the viewer are returned; filtering happens in the query rather
 * than in the route, so no route can accidentally return the unfiltered set.
 */
export function browseDirectory(db, { viewerUserId, ownerUserId, query, now = new Date() }) {
  // `visibility <> 'private'` used to run here, as a pre-filter. It had to go: it removed an
  // owner's own private entry from the *directory* before `isVisibleTo` — which explicitly allows
  // an owner to see their own entry "whatever its visibility" — ever ran. The owner could still
  // read the entry through `findEntry`, so the Bot existed and was theirs, yet it was absent from
  // the one list the UI browses, and no error said why.
  //
  // The filter is now `isVisibleTo` alone, which is the one function that decides visibility. Its
  // `private` branch still refuses everybody else, and it still requires the entry to exist.
  const rows = db.prepare(`
    SELECT d.*, u.user_handle AS owner_handle, u.display_name AS owner_display_name
    FROM bot_directory d
    JOIN users u ON u.id = d.owner_user_id
    WHERE (? IS NULL OR d.owner_user_id = ?)
      AND (? IS NULL OR d.display_name LIKE ?)
    ORDER BY u.display_name, d.display_name
  `).all(
    ownerUserId ?? null, ownerUserId ?? null,
    query === undefined ? null : `%${query}%`, query === undefined ? null : `%${query}%`,
  )
  return rows.filter(row => isVisibleTo(db, {
    ownerUserId: row.owner_user_id, botId: row.bot_id, viewerUserId,
  })).map(row => ({ ...row, presence: presenceOf(row, now) }))
}

/** The owner's own list, including private entries, with presence resolved. */
export function listOwnWithPresence(db, ownerUserId, now = new Date()) {
  return listOwnEntries(db, ownerUserId).map(row => ({ ...row, presence: presenceOf(row, now) }))
}

/**
 * The directory's wire shape.
 *
 * `presence` is what the Hub derived from the heartbeat; `state` is what the owner's client
 * last reported. Both are needed: a client showing availability uses `presence` (which
 * cannot lie about a crash), while an owner's own management view uses `state` to label what
 * the Bot is doing. Neither carries anything about the owner's machine.
 */
export function publicEntry(row, { includeOwner = false, now = new Date() } = {}) {
  return {
    botId: row.bot_id,
    displayName: row.display_name,
    visibility: row.visibility,
    presence: presenceOf(row, now),
    // Whether the owner reports this Bot as their Main Bot. A workgroup's leader must be one, so a
    // reader showing a Bot's standing needs the same fact the Hub checks, not a client's guess.
    isChief: row.is_chief === 1 || row.is_chief === true,
    ...(row.state === undefined ? {} : { state: row.state }),
    ...(includeOwner ? {
      ownerUserId: row.owner_user_id,
      ownerHandle: row.owner_handle,
      ownerDisplayName: row.owner_display_name,
    } : {}),
  }
}

export const directoryInternals = { PRESENCE_TTL_MS, BOT_ID_MAX, DISPLAY_NAME_MAX, RoomError }
