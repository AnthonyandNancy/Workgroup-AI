// Who is at their desk, as the Hub sees it.
//
// Presence is a property of the *connection*, not of the person and not of the device: the Hub
// reports a member online while any of their devices is connected, and offline once none is. So the
// only correct client behaviour is to render the boolean the Hub sends and to apply the events that
// change it — never to infer freshness from a timestamp, and never to keep a member online because
// they were a moment ago.
//
// Zero dependencies, so the rules can be read and checked without a DOM.

/** The two states a member can be in, as the member list shows them. */
export const PRESENCE_STATES = ['online', 'offline']

/**
 * Whether one member is connected.
 *
 * A member row without the flag is offline: the Hub omits it when it has nothing to say, and
 * assuming online would leave departed colleagues in the list.
 *
 * @param member - a member row from the Hub, possibly carrying `online`.
 * @returns `'online'` or `'offline'`.
 */
export function presenceOf(member) {
  return member?.online === true ? 'online' : 'offline'
}

/**
 * Apply one `presence.changed` event to the member list.
 *
 * @param members - the current member rows.
 * @param event - `{ userId, online }`, as the Bridge delivers it.
 * @returns a new array when the named member is present, otherwise the input unchanged; the rows
 *   that were not named keep their identity so only the changed row re-renders.
 */
export function applyPresence(members, event) {
  const list = members ?? []
  const index = list.findIndex(member => member.userId === event?.userId)
  // An event for someone this room does not list is dropped rather than appended: a member removed
  // a moment ago must not reappear because a broadcast about them was still in flight.
  if (index < 0) return list
  const next = [...list]
  next[index] = { ...list[index], online: event.online === true }
  return next
}
