// The workgroup roster: the list a sidebar row, a badge, and an invitation prompt are built from.
//
// A workgroup is not a local room, so it must not be injected into `roster.rooms`: that list is the
// local team's own state, and a Hub room in it would be treated as a local group by every path that
// reads it (sessions, hosting, deletion). This module keeps the second list separate and answers only
// the questions the workgroup surfaces ask: which rooms do I belong to, what is unread, what is
// waiting for my approval, and which invitations have not been answered.
//
// The Hub is the source of every room fact. What lives here is the per-device presentation state the
// Hub does not own — pin, hide, and the read watermark — kept in local storage under the workgroup's
// own key, exactly as the original group chat keeps its sidebar preferences locally.
//
// Pure row shaping (`workgroupRow`, `sortWorkgroupRows`) is separated from the polling source so the
// ordering and unread rules can be tested without a Hub, a socket, or a browser.

import { createSource } from './sources.js'

/** Where this device keeps workgroup sidebar preferences. */
export const WORKGROUP_PREFS_STORAGE_KEY = 'ds-bot:workgroup-prefs'

// The Hub answers lists either bare or under the collection's name, depending on the route. A
// roster that accepted only one shape would silently show "no invitations" for the other, so the
// unwrapping happens here, once, instead of at every read site.
const listOf = (value, ...keys) => {
  if (Array.isArray(value)) return value
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key]
  return []
}

/** The roster before the first Hub answer. */
export function emptyWorkgroupRoster() {
  return { phase: 'idle', rooms: [], invitations: [], botInvitations: [], error: undefined }
}

/**
 * Read this device's workgroup preferences.
 *
 * Storage is optional: a browser with it disabled, or a test without a DOM, reads as "no
 * preferences" rather than failing the sidebar. A malformed value is treated the same way, because a
 * corrupted pin must not be able to hide a room.
 *
 * @param {Storage} [storage]
 * @returns {Record<string, { pinned?: boolean, hidden?: boolean, lastReadSeq?: number }>}
 */
export function loadWorkgroupPrefs(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(WORKGROUP_PREFS_STORAGE_KEY) ?? 'null')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the preferences, ignoring a storage that refuses writes. */
export function saveWorkgroupPrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(WORKGROUP_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* storage unavailable: the preference lasts this window only */ }
}

/** Keep only the rooms that are workgroups; the Hub lists every room the caller belongs to. */
export function workgroupRoomsOf(rooms) {
  return (Array.isArray(rooms) ? rooms : []).filter(room => room?.kind === 'workgroup' && typeof room?.id === 'string')
}

const stampOf = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * One sidebar row: the Hub's summary plus this device's preferences.
 *
 * `unread` is a count of messages past the read watermark, derived from the room's last sequence.
 * Sequences start at 1 and are allocated per message, so the difference is the number of messages
 * the member has not seen; a Hub that has not reported the field yields 0 rather than a guess.
 *
 * @param {object} room a room summary from `GET /rooms`
 * @param {object} [prefs] this device's per-room preferences
 */
export function workgroupRow(room, prefs = {}) {
  const pref = prefs?.[room.id] ?? {}
  const lastSeq = Number.isInteger(room.lastMessageSeq) ? room.lastMessageSeq : 0
  const readSeq = Number.isInteger(pref.lastReadSeq) ? pref.lastReadSeq : 0
  return {
    ...room,
    kind: 'workgroup',
    pinned: pref.pinned === true,
    hidden: pref.hidden === true,
    unread: Math.max(0, lastSeq - readSeq),
    lastActivityAt: room.lastMessageAt ?? room.createdAt,
  }
}

/**
 * Sidebar order: pinned first, then the most recent activity, then name.
 *
 * The tie-breakers are stable so a poll that changes nothing cannot reorder the list under the
 * user's pointer. The original sidebar sorts the same way, which is what makes the two lists read
 * as one.
 */
export function sortWorkgroupRows(rows) {
  return [...rows].sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || stampOf(right.lastActivityAt) - stampOf(left.lastActivityAt)
    || String(left.name ?? '').localeCompare(String(right.name ?? ''))
    || String(left.id).localeCompare(String(right.id)))
}

/** The rows the sidebar draws: hidden rooms stay searchable but leave the list. */
export function visibleWorkgroupRows(rows) {
  return rows.filter(row => row.hidden !== true)
}

/**
 * The workgroup list, refreshed from the Hub and re-shaped by this device's preferences.
 *
 * Polling is a self-rescheduling timeout rather than an interval, so a slow Hub cannot accumulate
 * overlapping reads. A failed refresh keeps the rooms already shown and reports the reason: a
 * sidebar that emptied itself because one poll failed would look like the member lost their rooms.
 *
 * @param {{ workgroups?: object, pollMs?: number, prefs?: () => object, storage?: Storage }} options
 */
export function createWorkgroupRoster({ workgroups, pollMs = 15_000, prefs, storage } = {}) {
  // The preferences read from the same storage the roster writes to, so a caller can point both at a
  // test double without every read silently going to `localStorage`.
  let readPrefs = prefs ?? (() => loadWorkgroupPrefs(storage))
  const view = createSource(emptyWorkgroupRoster())
  let source = emptyWorkgroupRoster()
  let timer
  let inFlight
  let stopped = true

  const publish = (next) => {
    source = next
    view.set(next)
  }
  const shape = rooms => sortWorkgroupRows(workgroupRoomsOf(rooms).map(room => workgroupRow(room, readPrefs())))

  const refresh = async () => {
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      if (workgroups === undefined) {
        publish({ ...source, phase: 'failed', error: 'No workgroup adapter' })
        return source
      }
      // A Hub this device is not signed in to cannot answer, and asking would report a sign-in problem
      // as a Hub failure. The previous rows stay, marked blocked, until the connection returns.
      if (workgroups.available !== true) {
        publish({ ...source, phase: 'blocked' })
        return source
      }
      try {
        const [rooms, invitations, botInvitations] = await Promise.all([
          workgroups.rooms(),
          workgroups.invitations(),
          workgroups.botInvitations(),
        ])
        publish({
          phase: 'ready',
          rooms: shape(rooms),
          invitations: listOf(invitations, 'invitations'),
          botInvitations: listOf(botInvitations, 'invitations', 'botInvitations'),
        })
      } catch (error) {
        publish({ ...source, phase: 'failed', error: error?.message ?? String(error) })
      }
      return source
    })().finally(() => { inFlight = undefined })
    return inFlight
  }

  const schedule = () => {
    if (stopped || pollMs <= 0) return
    timer = setTimeout(() => { void refresh().finally(schedule) }, pollMs)
  }

  // Re-shaping is local: pinning a row or marking it read must not wait for the next Hub poll.
  const reshape = (nextPrefs) => {
    if (source.rooms.length === 0) return
    publish({ ...source, rooms: sortWorkgroupRows(source.rooms.map(row => workgroupRow(row, nextPrefs))) })
  }

  const writePref = (roomId, patch) => {
    const current = readPrefs()
    const next = { ...current, [roomId]: { ...current[roomId], ...patch } }
    saveWorkgroupPrefs(next, storage)
    readPrefs = () => next
    reshape(next)
    return next
  }

  const roster = {
    view,
    refresh,
    /** Apply this device's pin/hide preference. */
    setFlag: (roomId, patch) => { writePref(roomId, patch); return source },
    /** Record that the member has read the room up to `seq`. */
    markRead: (roomId, seq) => {
      const previous = readPrefs()[roomId]?.lastReadSeq ?? 0
      if (!Number.isInteger(seq) || seq <= previous) return source
      writePref(roomId, { lastReadSeq: seq })
      return source
    },
    /** Answer a human invitation, then re-read the list it changed. */
    answerInvitation: async (invitationId, decision) => {
      const answer = await workgroups.respondToInvitation(invitationId, decision)
      await refresh()
      return answer
    },
    /** Answer a Bot-owner invitation, then re-read the list it changed. */
    answerBotInvitation: async (invitationId, decision) => {
      const answer = await workgroups.respondToBotInvitation(invitationId, decision)
      await refresh()
      return answer
    },
    start() {
      stopped = false
      void refresh().finally(schedule)
      return roster
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
  return roster
}
