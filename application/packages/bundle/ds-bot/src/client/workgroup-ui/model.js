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
