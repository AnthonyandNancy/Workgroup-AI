// Choosing whom a message summons, and which file it carries.
//
// Two decisions live here rather than in `workgroup.js`, because both are rules about what may be
// mentioned and both are worth testing without a DOM:
//
//   * **a mention is built from ids.** The inserted text is the person's display name — that is what a
//     reader sees — but the mention sent to the Hub is `{ userId, botId }`. Deriving the id from the
//     text at send time would break on a rename and would treat any typed "@Writer" as a summons.
//   * **only people in the room can be mentioned**, and a Bot can only be mentioned through its owner.
//     A mention of somebody outside the room would render as a summons to a person who cannot read the
//     message; the Hub refuses it too, and this refuses it before a request is sent.

/** The character that opens the picker. Kept as a name so the test and the UI cannot disagree. */
export const MENTION_TRIGGER = '@'

/**
 * The people and Bots a message in this room may summon.
 *
 * Members first, then each member's Bots, so the common case (a colleague) is at the top. A Bot is
 * listed under its owner because mentioning it is how the owner is asked to run it: the mention names
 * both, and the Hub creates the task for the owner.
 *
 * @param {{ members?: object[], bots?: object[] }} room - the roster as the Hub reports it.
 * @returns {{ userId: string, botId?: string, label: string, kind: 'member'|'bot', detail?: string }[]}
 */
export function mentionCandidates({ members = [], bots = [] } = {}) {
  const people = members
    .filter(member => typeof member?.userId === 'string' && member.userId.length > 0)
    .map(member => ({
      userId: member.userId,
      label: member.displayName ?? member.userHandle ?? member.userId,
      kind: 'member',
      ...(member.userHandle === undefined ? {} : { detail: member.userHandle }),
    }))
  const byOwner = new Map(people.map(person => [person.userId, person]))
  const owned = bots
    // A Bot whose owner is not in the roster is dropped: its mention would name somebody who cannot
    // approve the task, so there is nothing useful to offer.
    .filter(bot => typeof bot?.id === 'string' && byOwner.has(bot.ownerUserId))
    .map(bot => ({
      userId: bot.ownerUserId,
      botId: bot.id,
      label: bot.displayName ?? bot.id,
      kind: 'bot',
      detail: byOwner.get(bot.ownerUserId).label,
    }))
  return [...people, ...owned]
}

/**
 * The candidates matching what has been typed after the trigger.
 *
 * An empty query lists everybody, which is what makes the trigger useful on its own: the person sees
 * who is available instead of having to remember a name.
 */
export function filterCandidates(candidates, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return candidates
  return candidates.filter(candidate =>
    candidate.label.toLowerCase().includes(needle)
    || (candidate.detail ?? '').toLowerCase().includes(needle)
    || (candidate.botId ?? '').toLowerCase().includes(needle))
}

/**
 * What a message needs in order to send what is in the box.
 *
 * The text keeps the names the sender typed — that is what a reader should see — and the mentions
 * carry the ids. Both are returned together because they must describe the same set: a name without a
 * mention is text, and a mention without a name is a summons the reader cannot see.
 *
 * @returns {{ text: string, mentions: { userId: string, botId?: string }[] }}
 */
export function composeMessage(text, picked = []) {
  return {
    text: String(text ?? ''),
    mentions: picked.map(entry => (entry.botId === undefined ? { userId: entry.userId } : { userId: entry.userId, botId: entry.botId })),
  }
}
