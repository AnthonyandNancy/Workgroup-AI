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
export function WorkgroupThread({ messages, selfUserId, empty }) {
  const ordered = useMemo(
    () => [...(messages ?? [])].sort((left, right) => (left.roomSeq ?? 0) - (right.roomSeq ?? 0)),
    [messages],
  )
  if (ordered.length === 0) {
    return h('div', { className: 'bt-wg-empty', 'data-wg-thread': 'empty' }, empty ?? t('No messages yet'))
  }
  return h('div', { className: 'bt-wg-thread', 'data-wg-thread': 'list' },
    ordered.map(message => h('div', {
      key: message.id ?? `${message.roomSeq}`,
      className: `bt-wg-message${message.senderUserId === selfUserId ? ' bt-wg-message-own' : ''}`,
      'data-wg-seq': String(message.roomSeq ?? ''),
      // The sequence is exposed for the same reason it exists: a test (or a support engineer) can
      // see exactly which messages a client holds, without parsing prose.
    },
    h('div', { className: 'bt-wg-message-who' }, message.senderDisplayName ?? message.senderUserId ?? ''),
    h('div', { className: 'bt-wg-message-body' }, message.body ?? ''),
    // A failed delivery is shown, not hidden: a client that quietly drops mentions leaves the
    // employee believing a colleague was told.
    message.failed ? h('div', { className: 'bt-wg-message-failed' }, t('Not delivered')) : null)))
}

/**
 * The workgroup's member list.
 *
 * Humans first: a workgroup's point is that a colleague is on the other end, and putting Bots at
 * the top would bury them. Bots keep their owner's name attached, because a Bot acts for someone
 * and the list must not suggest otherwise.
 */
export function WorkgroupMembers({ members, bots, onOpenBot }) {
  const humans = (members ?? []).map(member => h('div', { key: member.userId, className: 'bt-wg-member', 'data-wg-member': member.userId },
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
 */
export function WorkgroupView({
  room,
  members,
  bots,
  messages,
  tasks,
  selfUserId,
  watermark,
  actions,
  run,
  onOpenBot,
  onDecision,
  onSend,
  settingsOpen = false,
  onCloseSettings = () => {},
}) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // The composer clears only after the Hub accepted the message: clearing on submit and then
  // failing loses what the employee typed.
  const send = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    const ok = await onSend?.(draft.trim())
    setSending(false)
    if (ok !== false) setDraft('')
  }
  useEffect(() => { setDraft('') }, [room?.id])

  if (settingsOpen) {
    return h('div', { className: 'bt-wg bt-wg-settings', 'data-wg': room?.id },
      h(GroupSettingsForm, {
        room: { ...room, members: (members ?? []).map(member => member.userId) },
        roster: { byId: {}, bots: bots ?? [] },
        actions,
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
      h('button', { type: 'button', className: 'bt-wg-settings', 'data-wg-settings': 'open', onClick: () => run?.(null) }, t('Group settings'))),
    h(WorkgroupThread, { messages, selfUserId, empty: t('No messages yet') }),
    h(WorkgroupTasks, { tasks, onDecision }),
    h(WorkgroupMembers, { members, bots, onOpenBot }),
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

/** The Hub room id inside a session id produced by `workgroupSessionId`, or `undefined`. */
export function roomIdOfSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('wg:') ? sessionId.slice(3) : undefined
}

/**
 * Whether a session id names a workgroup.
 *
 * Used by the surface code to decide which pane a session renders, so it is a pure function of the
 * id: a workgroup opened on one machine and re-opened after a restart is the same session.
 */
export function isWorkgroupSession(sessionId) {
  return roomIdOfSession(sessionId) !== undefined
}
