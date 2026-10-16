// Workgroup view: a Hub-backed workgroup shown inside the team interface.
//
// A workgroup is **not** a DS Bot group. A DS Bot group is local: its members are this team's own
// Bots, its log lives in `state.json`, and it works with no server. A workgroup is a Hub room whose
// members are real `userId`s on other machines, whose messages arrive over the Bridge, and whose
// tasks need a human approval before anything runs. The two are different business entities and
// this module never mixes them (see `server/docs/DOMAIN_AND_EVENTS.md`).
//
// What is deliberately *reused*: the original room chrome. `GroupSettingsForm`, the room avatar, the
// member list, and the composer come from the team's own components, unchanged, so a workgroup looks
// like what the employee already knows. What is *not* reused: anything that would imply a workgroup
// is local — the local message log, the local roster, and the local room actions are all absent,
// because the Hub owns those.
//
// This module renders; it does not fetch. Everything it shows arrives through the props, which are
// the Bridge's events and the Hub client's reads. That keeps the "no code path from an inbound frame
// to an execution" property: this file cannot start a Bot, and the one file that can (`bot-adapter`)
// is only reachable after the local policy check.

import { createElement as h, useEffect, useMemo, useState } from 'react'
import { RoomAvatar } from './mark.js'
import { Card, Row, InlineText } from './bot-settings.js'
import { GroupSettingsForm } from './group-settings.js'
import { replyParent, replyPreview } from './workgroup-reply.js'
import { presenceOf } from './workgroup-presence.js'
import { identityRows, identityText } from './workgroup-identity.js'
import { t } from './i18n.js'

/** The two kinds a room may be, as the Hub names them. */
export const WORKGROUP_KIND = 'workgroup'
export const ORDINARY_KIND = 'ordinary'

/**
 * Whether a roster entry is a workgroup.
 *
 * The Hub is the authority: it marks the room. A client that guessed from the name or the member
 * count would show the workgroup affordances on a local group the moment names collided.
 */
export function isWorkgroup(room) {
  return room?.kind === WORKGROUP_KIND
}

/** A member's display line: their name, and how they joined. */
export function memberSummary(member) {
  const name = member.displayName ?? member.userHandle ?? member.userId
  return member.role === 'owner' ? `${name} (${t('Owner')})` : name
}

/** How many messages have arrived that the viewer has not seen, per the caller's own watermark. */
export function unreadCount(messages, watermark) {
  if (!Array.isArray(messages)) return 0
  return messages.filter(message => typeof message.roomSeq === 'number' && message.roomSeq > (watermark ?? 0)).length
}

/**
 * The workgroup's message list.
 *
 * Rendered from the messages the Bridge delivered, in `roomSeq` order. The ordering is applied here
 * rather than trusted from the caller because a catch-up page and a live event can arrive out of
 * order, and a chat that shows messages out of order is worse than one that shows them late.
 */
export function WorkgroupThread({ messages, selfUserId, empty, onReply }) {
  const ordered = useMemo(
    () => [...(messages ?? [])].sort((left, right) => (left.roomSeq ?? 0) - (right.roomSeq ?? 0)),
    [messages],
  )
  if (ordered.length === 0) {
    return h('div', { className: 'bt-wg-empty', 'data-wg-thread': 'empty' }, empty ?? t('No messages yet'))
  }
  return h('div', { className: 'bt-wg-thread', 'data-wg-thread': 'list' },
    ordered.map((message) => {
      const quoted = replyParent(message, ordered)
      return h('div', {
        key: message.id ?? `${message.roomSeq}`,
        className: `bt-wg-message${message.senderUserId === selfUserId ? ' bt-wg-message-own' : ''}`,
        'data-wg-seq': String(message.roomSeq ?? ''),
        // The sequence is exposed for the same reason it exists: a test (or a support engineer) can
        // see exactly which messages a client holds, without parsing prose.
      },
      // The quoted parent is resolved from this reader's own copy of the room, so a reply whose
      // parent was deleted still shows as a reply rather than as an unrelated message.
      quoted === undefined ? null : h('div', { className: 'bt-wg-quote', 'data-wg-quote': quoted.id },
        h('span', { className: 'bt-wg-quote-who' }, quoted.who === undefined ? t('An earlier message') : quoted.who),
        quoted.body === undefined ? null : h('span', { className: 'bt-wg-quote-body' }, quoted.body)),
      h('div', { className: 'bt-wg-message-who' }, message.senderDisplayName ?? message.senderUserId ?? ''),
      h('div', { className: 'bt-wg-message-body' }, message.body ?? ''),
      // A failed delivery is shown, not hidden: a client that quietly drops mentions leaves the
      // employee believing a colleague was told.
      message.failed ? h('div', { className: 'bt-wg-message-failed' }, t('Not delivered')) : null,
      // Quoting is offered per message rather than as a composer mode, so the person points at what
      // they are answering. Only a message the Hub gave an id to can be linked, and the button is
      // therefore absent for the rest rather than present and ineffective.
      onReply !== undefined && message.id !== undefined
        ? h('button', {
          type: 'button', className: 'bt-wg-reply', 'data-wg-reply': message.id,
          'aria-label': t('Quote this message'), onClick: () => onReply(message),
        }, t('Quote'))
        : null)
    }))
}

/**
 * The workgroup's member list.
 *
 * Humans first: a workgroup's point is that a colleague is on the other end, and putting Bots at
 * the top would bury them. Bots keep their owner's name attached, because a Bot acts for someone
 * and the list must not suggest otherwise.
 *
 * Only a human carries the presence dot. A Bot's own `state` is a different fact — whether it is
 * running work right now — and marking a Bot as "offline" beside a colleague's dot would read as
 * "this Bot's owner is away", which is not what either value means.
 */
export function WorkgroupMembers({ members, bots, onOpenBot }) {
  const humans = (members ?? []).map(member => h('div', {
    key: member.userId,
    className: `bt-wg-member bt-wg-member-${presenceOf(member)}`,
    'data-wg-member': member.userId,
    // The state is exposed for the same reason the id is: a reader (or a test) can tell a
    // connected colleague from an absent one without measuring a dot.
    'data-wg-presence': presenceOf(member),
  },
  h('span', { className: 'bt-wg-member-dot', 'aria-hidden': 'true' }),
  h('span', { className: 'bt-wg-member-name' }, memberSummary(member))))
  const machines = (bots ?? []).map(bot => h('div', {
    key: `${bot.ownerUserId}:${bot.botId}`,
    className: 'bt-wg-member bt-wg-member-bot',
    'data-wg-bot': bot.botId,
  },
  h('button', { type: 'button', className: 'bt-wg-member-name', onClick: () => onOpenBot?.(bot) },
    bot.displayName ?? bot.botId),
  // The owner is shown because a Bot in a workgroup is a delegate, and "whose Bot is this" is the
  // question a reader asks first.
  h('span', { className: 'bt-wg-member-owner' }, t('for {name}', { name: bot.ownerDisplayName ?? bot.ownerUserId }))))
  return h('div', { className: 'bt-wg-members', 'data-wg-members': String((members ?? []).length) }, ...humans, ...machines)
}

/**
 * The task strip: what is waiting on *this* person.
 *
 * Only approvals addressed to the viewer appear, because an approval is a personal authorization.
 * A workgroup where anybody could approve anybody's task would defeat the whole gate.
 */
export function WorkgroupTasks({ tasks, onDecision }) {
  const pending = (tasks ?? []).filter(task => task.state === 'PENDING_APPROVAL')
  if (pending.length === 0) return null
  return h('div', { className: 'bt-wg-tasks', 'data-wg-pending': String(pending.length) },
    pending.map(task => h(Card, { key: task.id, title: t('Approval needed') },
      h(Row, { label: t('Requested by'), value: task.requesterDisplayName ?? task.requesterUserId }),
      h(Row, { label: t('What'), value: task.description }),
      h('div', { className: 'bt-wg-task-actions' },
        h('button', { type: 'button', className: 'bt-wg-approve', 'data-wg-approve': task.id, onClick: () => onDecision?.(task.id, 'approve') }, t('Approve')),
        h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-reject': task.id, onClick: () => onDecision?.(task.id, 'reject') }, t('Reject'))))))
}

/**
 * The whole workgroup pane.
 *
 * The settings view is the team's own `GroupSettingsForm`, which is what makes the workgroup's
 * management screen look and behave like a group's. Its actions are supplied by the caller and go
 * to the Hub; the component does not know the difference, which is the point of reusing it.
 *
 * `empty` replaces the thread's own placeholder, so a caller that could not read the room explains
 * why in the place the messages would be instead of showing an empty conversation.
 */
export function WorkgroupView({
  room,
  members,
  bots,
  messages,
  tasks,
  selfUserId,
  // The signed-in user as the Hub describes them. Needed for the settings view, which is where a
  // colleague looks up the id an invitation has to name.
  identity,
  watermark,
  empty,
  actions,
  run,
  onOpenBot,
  onDecision,
  onSend,
  settingsOpen = false,
  onCloseSettings = () => {},
  // The owner's dissolve action, passed in from the pane so this view keeps no Hub knowledge of its
  // own. Absent means the settings form's end-the-group button does nothing, which is the right
  // default for a viewer who is not the owner.
  onDissolve,
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState(undefined)
  // The composer clears only after the Hub accepted the message: clearing on submit and then
  // failing loses what the employee typed.
  const send = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    const ok = await onSend?.(draft.trim(), reply)
    setSending(false)
    if (ok !== false) { setDraft(''); setReply(undefined) }
  }
  useEffect(() => { setDraft(''); setReply(undefined) }, [room?.id])
  // A reply is only as good as the message it names, so a target that the room list no longer
  // holds is dropped rather than sent as a link the reader cannot follow.
  useEffect(() => {
    if (reply === undefined) return
    if (!(messages ?? []).some(message => message.id === reply.id)) setReply(undefined)
  }, [messages, reply])

  if (settingsOpen) {
    const rows = identityRows(identity)
    return h('div', { className: 'bt-wg bt-wg-settings', 'data-wg': room?.id },
      // An invitation is sent by exact id and the Hub has no user search, so this is where a new
      // colleague finds out what to tell the person who will invite them. Shown only when the Hub
      // has answered for an identifier: a blank block would read as "you have no id".
      rows.length === 0 ? null : h('div', { className: 'bt-wg-identity', 'data-wg-identity': 'self' },
        h('div', { className: 'bt-wg-identity-note' }, t('Tell this to the colleague who will invite you.')),
        rows.map(row => h('div', { key: row.key, className: 'bt-wg-identity-row', 'data-wg-identity-field': row.key },
          h('span', { className: 'bt-wg-identity-label' }, t(row.label)),
          h('code', { className: 'bt-wg-identity-value' }, row.value))),
        h('button', {
          type: 'button', className: 'bt-wg-identity-copy', 'data-wg-identity-copy': 'self',
          onClick: () => { void navigator.clipboard?.writeText(identityText(identity)) },
        }, t('Copy my ID'))),
      h(GroupSettingsForm, {
        room: { ...room, members: (members ?? []).map(member => member.userId) },
        roster: { byId: {}, bots: bots ?? [] },
        // The form was written for local group chats, where "delete" is a local bookkeeping act. A
        // workgroup is a Hub room the local store has never heard of, so the form's destructive action
        // is redirected to the Hub's dissolve endpoint. Leaving and removing members are not redirected:
        // only the owner ends the workgroup, and only dissolution ends it for everyone.
        actions: {
          ...actions,
          deleteRoom: (roomId) => onDissolve?.(roomId),
        },
        run: async (value) => { const done = await run?.(value); onCloseSettings(); return done },
        onDeleted: onCloseSettings,
      }))
  }

  const unread = unreadCount(messages, watermark)
  return h('div', { className: 'bt-wg', 'data-wg': room?.id, 'data-wg-kind': room?.kind ?? '' },
    h('div', { className: 'bt-wg-head', 'data-wg-title': room?.name ?? '' },
      room ? h(RoomAvatar, { room, roster: { byId: {}, bots: bots ?? [] }, size: 24 }) : null,
      h('span', { className: 'bt-wg-name' }, room?.name ?? ''),
      unread > 0 ? h('span', { className: 'bt-wg-unread', 'data-wg-unread': String(unread) }, String(unread)) : null,
      h('button', { type: 'button', className: 'bt-wg-gear', 'data-wg-settings': 'open', onClick: () => run?.(null) }, t('Group settings'))),
    h(WorkgroupThread, {
      messages,
      selfUserId,
      empty: empty ?? t('No messages yet'),
      onReply: message => setReply(replyPreview(message)),
    }),
    h(WorkgroupTasks, { tasks, onDecision }),
    h(WorkgroupMembers, { members, bots, onOpenBot }),
    // What is being answered stays visible while typing, and can be dropped: a reply the sender
    // forgot they had selected would attach to the wrong message.
    reply === undefined ? null : h('div', { className: 'bt-wg-replying', 'data-wg-replying': reply.id },
      h('div', { className: 'bt-wg-replying-text' },
        h('div', { className: 'bt-wg-replying-who' }, t('Replying to {name}', { name: reply.who })),
        h('div', { className: 'bt-wg-replying-body' }, reply.body)),
      h('button', {
        type: 'button', className: 'bt-wg-replying-drop', 'data-wg-reply-drop': 'clear',
        'aria-label': t('Stop replying'), onClick: () => setReply(undefined),
      }, t('Cancel'))),
    h('div', { className: 'bt-wg-compose' },
      h('textarea', {
        className: 'bt-wg-input',
        'data-wg-input': 'message',
        'aria-label': t('Message'),
        value: draft,
        rows: 1,
        onChange: event => setDraft(event.target.value),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
        },
      }),
      h('button', {
        type: 'button', className: 'bt-wg-send', 'data-wg-send': 'submit',
        disabled: sending || draft.trim() === '', onClick: () => { void send() },
      }, t('Send'))))
}

/** One line for a workgroup in a list, so the two kinds are distinguishable at a glance. */
export function workgroupSubtitle(room, memberCount) {
  const kind = isWorkgroup(room) ? t('Workgroup') : t('Group chat')
  return `${kind} · ${t('{count} members', { count: memberCount ?? room?.memberCount ?? 0 })}`
}

export { InlineText }

/**
 * A workgroup's name at creation time.
 *
 * The team's own naming (`New group chat`) is a local thing a user names themselves; a workgroup is
 * created from a menu entry with no name field, so it needs a default. It is derived from the date
 * rather than random so a list of workgroups is readable in the sidebar, and the employee renames it
 * afterwards through the same settings form a group uses.
 *
 * @param {Date} [now]
 */
export function newWorkgroupName(now = new Date()) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `Workgroup ${stamp}`
}

// Re-exported rather than redefined: the Host creates the `wg:` Session and the browser half
// recognizes it, so the one identity rule has to be the same string on both sides. Splitting it
// would let a rename on one half leave the other unable to find the Session it just created.
export { workgroupSessionId, roomIdOfSession, isWorkgroupSession } from '../shared/workgroup-session.js'
