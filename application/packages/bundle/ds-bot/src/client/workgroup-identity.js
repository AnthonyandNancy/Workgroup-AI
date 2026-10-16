// "My account", as a workgroup needs it.
//
// The Hub sends an invitation by exact `userId` and offers no user search, so a colleague can only
// be invited if they can say who they are. The join flow is therefore: sign in, learn your own
// identifiers, tell them to the person who will invite you.
//
// The values are read from the Hub's own answer to `GET /auth/me` — the same record the invitation
// will be sent to — rather than from anything typed, so what is displayed is exactly what the Hub
// accepts as a target. Zero dependencies, so the rules can be checked without a DOM.
//
// A display name is deliberately *not* an invitation target: the Hub does not resolve invitations
// by name (only by exact id), and a name is not unique. It is shown in the account menu, where it
// is a label, but kept out of the copyable text, where it would look like something to invite.

/**
 * The identifier rows to show for the signed-in user.
 *
 * A field the Hub did not answer for is left out rather than rendered blank: an empty row reads as
 * "your id is nothing", and the reader cannot tell a missing answer from an empty value.
 *
 * @param identity - the Hub's account answer: `userId`, `userHandle`, `displayName`, `deviceId`.
 * @returns rows of `{ key, label, value }` in the order they are shown.
 */
export function identityRows(identity) {
  const fields = [
    ['userId', 'Your user ID'],
    ['userHandle', 'Your username'],
  ]
  return fields
    .filter(([key]) => typeof identity?.[key] === 'string' && identity[key] !== '')
    .map(([key, label]) => ({ key, label, value: identity[key] }))
}

/**
 * The identifiers as one copyable block, for pasting into a chat with the colleague who will
 * invite this user.
 *
 * @param identity - the Hub's account answer.
 * @returns one line per identifier, `label: value`; an empty string when the Hub has answered for
 *   neither identifier, so a copy button can be disabled rather than copying nothing.
 */
export function identityText(identity) {
  return identityRows(identity)
    .map(row => `${row.label}: ${row.value}`)
    .join('\n')
}
