// What the pane says about its Hub connection.
//
// The Bridge reports transport states (`idle`, `connecting`, `open`, `reconnecting`, `closed`,
// `fatal`) and the Host reports whether a Hub is configured at all. Those are facts about the
// connection; they are not what the employee needs to read. This module is the one place that turns
// them into the three answers that call for three different actions, so the pane can render a state
// without deciding what the state means.
//
// Nothing here imports React or the DOM, so the mapping is testable on its own.
//
// | status       | meaning                                        | what the user can do          |
// |--------------|------------------------------------------------|-------------------------------|
// | `live`       | connected, events flowing                      | use the room                  |
// | `offline`    | configured, stream down, the Bridge retries    | wait; work locally meanwhile  |
// | `refused`    | the Hub refused this device; no retry          | sign in again                 |
// | `signed-out` | configured and reachable, this machine unsigned | sign in                       |
// | `absent`     | no Hub configured                              | ask an administrator          |
// | `unknown`    | the Host has not answered                      | nothing yet — it is not a fault |

/** The statuses a workgroup pane can present. */
export const HUB_STATUSES = ['live', 'offline', 'refused', 'signed-out', 'absent', 'unknown']

// What the pane says when the Hub is not usable: one entry per blocked status, each naming its own
// fix. A table rather than a chain of branches so that every status the mapping can return is
// visibly accounted for — a status missing here would render as an empty panel.
//
// The two statuses absent from this table are absent on purpose: `live` needs no explanation, and
// `unknown` is the state before the Host has answered, where a warning about a connection nobody
// has asked after would be noise.
const OFFLINE = {
  offline: {
    title: 'Workgroup Hub is not connected',
    body: 'This machine cannot reach the Hub right now, so this workgroup cannot be shown or posted to. It reconnects on its own; local chats and groups keep working.',
  },
  refused: {
    title: 'Workgroup Hub refused this device',
    body: 'The Hub no longer accepts this device’s sign-in, so this workgroup cannot be shown. Sign in again to reconnect it.',
  },
  'signed-out': {
    title: 'Not signed in to the Workgroup Hub',
    body: 'This machine is not signed in, so this workgroup cannot be shown or posted to. Sign in to your account to continue.',
  },
  absent: {
    title: 'Workgroups need the Workgroup Hub',
    body: 'This machine is not connected to a Hub, so this workgroup cannot be shown or posted to. Ask your administrator to configure one.',
  },
}

/**
 * The copy for a status, or `undefined` when the pane should show the room itself.
 *
 * @param status - one of {@link HUB_STATUSES}.
 * @returns `{ title, body }` for a blocked status; `undefined` for `live` and `unknown`.
 */
export function hubStatusCopy(status) {
  return OFFLINE[status]
}

/**
 * Map what the browser half knows about the Hub onto what the pane shows.
 *
 * Order matters: an answer of "no Hub is configured" only means something once the Host has
 * actually answered, and a signed-out device cannot be connected whatever the transport says.
 *
 * @param view - one `bridge.view` snapshot: `phase`, `configured`, `signedIn`, and `state`.
 * @returns one of {@link HUB_STATUSES}.
 */
export function hubStatusOf(view) {
  // No answer yet, or no Host to answer: whether a Hub exists is unknown, which is not the same
  // claim as "none is configured". Saying the latter would send an operator looking for a setting.
  if (view === undefined || view.phase === 'unknown' || view.phase === 'unreachable') return 'unknown'
  if (view.configured !== true) return 'absent'
  if (view.signedIn !== true) return 'signed-out'
  if (view.state === 'open') return 'live'
  // A fatal close is not retried, so it must not be dressed as a state that repairs itself.
  if (view.state === 'fatal') return 'refused'
  return 'offline'
}

/**
 * What the creation surface says when the Hub cannot create a room.
 *
 * Returns a dictionary key, not translated text, so the sidebar and the create form can share the
 * same per-status explanation without either owning the other's copy. `reconnecting` is included
 * because the sidebar distinguishes it from a stopped connection: one repairs itself, the other
 * waits for somebody.
 *
 * @param status - one of {@link HUB_STATUSES}, or the sidebar's `reconnecting` state.
 * @param view - the same bridge snapshot used to derive the status.
 * @returns a dictionary key, or `undefined` when the Hub is usable.
 */
export function hubCreateHint(status, view) {
  switch (status) {
    case 'absent': return 'Hub is not configured'
    case 'signed-out': return 'Configured, signed out'
    case 'reconnecting': return 'Hub is reconnecting. Wait for the connection before creating a workgroup.'
    case 'offline':
      return view?.state === 'reconnecting'
        ? 'Hub is reconnecting. Wait for the connection before creating a workgroup.'
        : 'Hub is offline. Reconnect to create a workgroup.'
    case 'refused': return 'Hub refused this device. Sign in again to create a workgroup.'
    case 'unknown':
      return view?.phase === 'unreachable'
        ? 'Could not check the Workgroup Hub.'
        : 'Checking the Workgroup Hub…'
    default: return undefined
  }
}
