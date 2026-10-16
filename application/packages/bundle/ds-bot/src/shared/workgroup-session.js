// Workgroup Session identity: which session id names a workgroup, and which pane the shell shows.
//
// A workgroup is opened under a Session whose id is `wg:<roomId>`. That id is the whole identity:
// it is what the shell navigates to, what a reload restores, and what a second machine derives
// from the same room. Nothing here reads a room list or a Hub, so recognition cannot go stale and
// a workgroup stays recognizable while the Hub is unreachable.
//
// The module is deliberately free of imports. Both halves of the decision below are needed where
// the heavy rendering modules cannot be reached — the host's roster sync and the client's keyless
// harness — and a predicate that pulled in React or the Hub client would be unusable there.

/**
 * The session id a workgroup is opened under.
 *
 * A Hub room id is the session identity, exactly as a local room's id is. The prefix keeps the two
 * namespaces from colliding when a Hub is added to an install that already has local groups: two
 * different things must not be able to arrive at the same session id.
 *
 * @param {string} roomId
 */
export function workgroupSessionId(roomId) {
  return `wg:${roomId}`
}

/**
 * The Hub room id inside a session id produced by `workgroupSessionId`.
 *
 * @param {unknown} sessionId
 * @returns the room id, or `undefined` when the id does not name a workgroup.
 */
export function roomIdOfSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('wg:') ? sessionId.slice(3) : undefined
}

/**
 * Whether a session id names a workgroup.
 *
 * A workgroup opened on one machine, and re-opened after a restart, is the same session, so this
 * is a pure function of the id.
 *
 * @param {unknown} sessionId
 */
export function isWorkgroupSession(sessionId) {
  return roomIdOfSession(sessionId) !== undefined
}

/**
 * The Session the shell's main view is showing, as the shell itself reads it.
 *
 * The retained reference is the shell's own record of what is on screen, so it is correct after a
 * reload, where no click ran and nothing was passed down.
 *
 * @param {{ byId?: Record<string, { id?: string, retainedBy?: { mainView?: number } }> }} sessions
 * @returns the main Session id, or `undefined` when none is retained.
 */
export function mainSessionId(sessions) {
  return Object.values(sessions?.byId ?? {})
    .find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
}

/**
 * The workgroup Session the main view is showing, if it is showing one.
 *
 * @param {Parameters<typeof mainSessionId>[0]} sessions
 * @returns the workgroup Session id, or `undefined` for any other Session.
 */
export function mainWorkgroupSession(sessions) {
  const main = mainSessionId(sessions)
  return isWorkgroupSession(main) ? main : undefined
}

/**
 * Whether the shell's unknown-Session fallback should pull the view back to the Main Bot.
 *
 * The fallback exists because a Session left over from another surface would wear this team's skin
 * without belonging to it. A workgroup Session is never in the team's roster — it belongs to the
 * Hub — so it must be excepted explicitly, or opening a workgroup would be undone by the next
 * roster sync and the workgroup would be unreachable.
 *
 * @param {{ byId: Record<string, unknown>, roomsById: Record<string, unknown> }} roster
 * @param {string | undefined} sessionId
 */
export function needsHomeFallback(roster, sessionId) {
  if (sessionId === undefined || isWorkgroupSession(sessionId)) return false
  return roster.byId[sessionId] === undefined && roster.roomsById[sessionId] === undefined
}
