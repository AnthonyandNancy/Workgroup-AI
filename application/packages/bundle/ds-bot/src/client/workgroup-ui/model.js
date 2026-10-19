// Workgroup view model: the small pure rules the copied interface shares.
//
// These used to live beside the workgroup's own view. They are separate now because the copied
// interface has several modules (thread, activity, settings, details) that must agree on the same
// answers — what a member is called, which room is a workgroup, what a room is called at creation —
// and a second definition of any of them would drift.
//
import { t } from '../i18n.js'

// The Hub is the authority for every fact here. Nothing in this module guesses from a name, a
// member count, or local roster state.

/** The two kinds a room may be, as the Hub names them. */
export const WORKGROUP_KIND = 'workgroup'
export const ORDINARY_KIND = 'ordinary'

/** Whether a room is a workgroup; the Hub marks it, the client does not infer it. */
export function isWorkgroup(room) {
  return room?.kind === WORKGROUP_KIND
}

/** A member's display line: their name, and their role when it is not the default. */
export function memberSummary(member) {
  const name = member?.displayName ?? member?.userHandle ?? member?.userId ?? ''
  if (member?.role === 'owner') return `${name} (${t('Owner')})`
  if (member?.role === 'admin') return `${name} (${t('Admin')})`
  return name
}

/** How many messages arrived past the viewer's watermark. */
export function unreadCount(messages, watermark) {
  if (!Array.isArray(messages)) return 0
  return messages.filter(message => typeof message.roomSeq === 'number' && message.roomSeq > (watermark ?? 0)).length
}

/** One line for a workgroup in a list, so the two kinds are distinguishable at a glance. */
export function workgroupSubtitle(room, memberCount) {
  const kind = isWorkgroup(room) ? t('Workgroup') : t('Group chat')
  return `${kind} · ${t('{count} members', { count: memberCount ?? room?.memberCount ?? 0 })}`
}

/**
 * A workgroup's fallback name.
 *
 * The creation form asks for a name, so this is only used when a caller creates a room without one
 * (an older Host, a test). It is derived from the date rather than random so a list stays readable.
 *
 * @param {Date} [now]
 */
export function newWorkgroupName(now = new Date()) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `Workgroup ${stamp}`
}

/**
 * The roster entries a workgroup avatar seats its Bots from.
 *
 * The Hub publishes a Bot's name and presence, not its character: `RoomBot` carries no avatar,
 * shape or colour. A Bot this machine owns is therefore taken from the local roster so it looks
 * exactly as it does in the original group chat, while anyone else's Bot gets the stable look
 * `lookOf({ id })` derives from its `botId` — the same on every render and every reload.
 *
 * Only `avatar`, `id` and `color` are copied from a local entry, because `lookOf` reads exactly
 * those, and copying the rest would republish a private roster record into a shared room.
 *
 * @param {{ ownerUserId: string, botId: string, displayName?: string }[]} bots the room's Bots
 * @param {{ byId?: Record<string, object> }} [local] this machine's own roster
 * @returns {{ roster: { byId: Record<string, object>, bots: object[] } }} entries keyed `wg:<owner>:<bot>`
 */
export function seatBots(bots, local) {
  const entries = (bots ?? []).map((bot) => {
    const known = local?.byId?.[bot.botId]
    const key = `wg:${bot.ownerUserId}:${bot.botId}`
    const seat = known === undefined
      ? { id: bot.botId, name: bot.displayName ?? bot.botId }
      : {
        id: known.id ?? bot.botId,
        name: known.name ?? bot.displayName ?? bot.botId,
        ...(known.avatar === undefined ? {} : { avatar: known.avatar }),
        ...(known.color === undefined ? {} : { color: known.color }),
      }
    return [key, seat]
  })
  return {
    roster: { byId: Object.fromEntries(entries), bots: entries.map(([, seat]) => seat) },
  }
}

/**
 * The faces a workgroup avatar shows: people first, then the room's Bots, capped at `max`.
 *
 * Kept as data rather than markup so the sidebar row, the header pill, and the details pile slice
 * the same list the same way, and so the rule is testable without a DOM.
 *
 * @param {{ userId: string, displayName?: string }[]} members the Hub's human members
 * @param {{ ownerUserId: string, botId: string, displayName?: string }[]} bots the room's Bots
 * @param {number} [max] how many seats fit, four in the original group avatar
 * @returns {{ faces: object[], more: number }} the seats to draw, and how many did not fit
 */
export function avatarFaces(members, bots, max = 4) {
  const people = (members ?? []).map(member => ({
    kind: 'person', userId: member.userId, name: member.displayName ?? member.userId,
  }))
  const machines = (bots ?? []).map(bot => ({
    kind: 'bot', ownerUserId: bot.ownerUserId, botId: bot.botId, name: bot.displayName ?? bot.botId,
  }))
  const all = [...people, ...machines]
  const faces = all.length > max ? all.slice(0, max - 1) : all
  return { faces, more: all.length - faces.length }
}
