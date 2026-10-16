// Entering a workgroup, in the one order that works.
//
// The pane renders a workgroup from its Session, and the shell refuses to display a Session it
// has never heard of: `sessions.retain` throws `unknown session` for an id that is in neither the
// live registry nor the catalog. `wg:<roomId>` is always such an id — the room lives on the Hub,
// so nothing on this machine has created the Session that stands for it. Navigating first would
// therefore throw inside navigation, leaving the user with an error and no room.
//
// So the Session is created before the navigation, and the creation is named by id: `wg:<roomId>`
// is the identity the pane recognizes, so a Host that minted a different id would put the user in
// a Session no pane renders. The Host reuses a Session that already exists under that id, which is
// why entering the same room twice is not a second Session.
import { workgroupSessionId } from '../shared/workgroup-session.js'

/**
 * Make a workgroup's Session addressable and show it.
 *
 * A failed creation is reported rather than navigated past: the navigation would raise the same
 * refusal again, and an unreported failure leaves the user on a menu that appears to do nothing.
 * @param options - the room to enter, the client's `sessions` service, and the navigation and
 *   reporting callbacks; `watch` and `closeOverlay` are optional.
 * @returns the Session id that was opened, or `undefined` when the creation failed.
 */
export async function enterWorkgroup({ roomId, sessions, openSession, closeOverlay, watch, report }) {
  const sessionId = workgroupSessionId(roomId)
  const known = sessions.list?.getSnapshot?.()?.byId?.[sessionId] !== undefined
  if (!known) {
    try {
      await sessions.create({ sessionId })
    } catch (error) {
      report?.(error)
      return undefined
    }
  }
  openSession(sessionId)
  closeOverlay?.()
  // Watched from now on, so messages arrive without the user reopening anything. A watch that
  // fails is not a reason to withhold the room the user already entered.
  await watch?.(roomId).catch?.(() => {})
  return sessionId
}
