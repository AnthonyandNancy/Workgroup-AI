// The workgroup conversation: the copied group-chat surface, assembled for a Hub room.
//
// The original group chat is a shell conversation plus five registrations (header, cells, composer
// extensions, details, settings). A workgroup lives in an overlay instead, so this module assembles
// the same surface from the copies in this folder: the header pill, the message/activity timeline,
// the composer, the details drawer, and the settings view. Nothing here fetches; the pane supplies
// the room snapshot and the adapters, which is what keeps a rendering component unable to start
// work or read a token.
//
// The one difference a reader will notice is intentional and required: a workgroup Bot's output is
// task activity, not a chat message. The timeline therefore interleaves messages with task cards,
// using the original card language rather than inventing a Bot line.

import { createElement as h, Fragment, useEffect, useState } from 'react'
import { CheckIcon, ChevronLeftIcon, CloseIcon, GearIcon, ShareIcon } from '../icons.js'
import { useLinger } from '../motion.js'
import { t } from '../i18n.js'
import { replyPreview } from '../workgroup-reply.js'
import { WorkgroupAvatar, WorkgroupThread } from './thread.js'
import { WorkgroupComposer } from './composer.js'
import { TaskCard, WorkgroupTasks } from './activity.js'
import { WorkgroupDetails } from './details.js'
import { WorkgroupSettingsForm } from './settings.js'
import { WORKGROUP_UI_CSS } from './styles.js'

// The original header's tail arrow. Copied rather than imported from `header.js`, because the
// original component owns the shell's Session state and this overlay must not reach into it.
const GoArrow = () => h('svg', {
  width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

const PANEL_MIN = 320
const PANEL_MAX = 520
const MIN_CHAT = 420

const panelRange = () => {
  const high = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - MIN_CHAT))
  return [PANEL_MIN, high]
}

const clampPanel = (value, [low, high]) => Math.round(Math.max(low, Math.min(value, high)))

/**
 * The group's face in its details: the same workgroup avatar the header and the sidebar row draw.
 *
 * Four seats and a `+N` are `WorkgroupAvatar`'s own rule now, so the pile and the pill cannot drift
 * apart into two different pictures of one room.
 */
function MemberPile({ members, bots, local }) {
  if ((members ?? []).length === 0 && (bots ?? []).length === 0) return null
  return h('span', { className: 'bt-pile', 'aria-hidden': true },
    h('span', { className: 'bt-pile-face' }, h(WorkgroupAvatar, { members, bots, local, size: 44 })))
}

/** The group's name in the details drawer, editable in place like the original group. */
/**
 * Whether this viewer may summon the whole room.
 *
 * The Hub enforces the same rule; this only decides whether the picker offers the entry. A member who
 * is neither the owner, an admin, nor the leader's owner would have an `@all` rejected, so offering it
 * would be a control that never works.
 */
function canSummonEveryone(room, identity) {
  const me = identity?.userId
  if (me === undefined || room === undefined) return false
  const role = room.myRole
  if (role === 'owner' || role === 'admin') return true
  return room.adminBotOwnerUserId === me
}

function PanelName({ room, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const current = room?.name ?? ''
  if (room === undefined) return null
  const begin = () => { setDraft(current); setEditing(true) }
  const save = async () => {
    if (!editing) return
    setEditing(false)
    const next = draft.trim()
    if (next === '' || next === current) return
    await onRename?.(next)
  }
  const cancel = () => { setEditing(false); setDraft('') }
  return editing
    ? h('input', {
      className: 'bt-drawer-name-input', autoFocus: true, value: draft,
      'aria-label': t('Group name'),
      onChange: event => setDraft(event.target.value),
      onBlur: () => { void save() },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.stopPropagation(); cancel() }
      },
    })
    : h('button', {
      type: 'button', className: 'bt-drawer-name',
      'aria-label': t('Rename {name}', { name: current }), title: t('Rename'),
      onClick: begin,
    }, current)
}

/** One activity card inside the timeline; it owns only whether its approval form is open. */
function InlineActivity({ task, events, members, selfUserId, actions, run, loadOwnerBots, onDecision, onReview, onCancel }) {
  const [open, setOpen] = useState(false)
  return h(TaskCard, {
    task,
    events,
    members,
    selfUserId,
    actions,
    run,
    loadOwnerBots,
    onDecision,
    onReview,
    onCancel,
    open,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
  })
}

/**
 * The whole workgroup surface.
 *
 * Every callback is optional: a missing one renders a control that is absent, not a control that
 * silently does nothing. That is the same rule the Hub follows for permissions — the difference is
 * that this layer decides what a person is shown, never what they are allowed to do.
 */
export function WorkgroupConversation({
  room,
  members,
  bots,
  messages,
  tasks,
  events,
  selfUserId,
  identity,
  empty,
  actions,
  run,
  onDecision,
  onReview,
  onCancel,
  onSend,
  onDissolve,
  onAttach,
  onDownload,
  onImage,
  schedules,
  onSchedule,
  onCancelSchedule,
  onRoomAction,
  onReact,
  onUnreact,
  onLoadEarlier,
  loadOwnerBots,
  loadBotCandidates,
  localRoster: local,
  prefs,
  onFlag,
  memory,
  hubState,
}) {
  const [reply, setReply] = useState(undefined)
  const [panel, setPanel] = useState(null)
  const [error, setError] = useState(undefined)
  const [copied, setCopied] = useState(false)
  const [shownPanel, panelLeaving] = useLinger(panel, 300)
  const [panelWidth, setPanelWidth] = useState(PANEL_MIN)
  const [resizing, setResizing] = useState(false)
  // The history cursor starts from the oldest message the pane was opened with. `hasMore` comes from
  // that same read, so the first paint already knows whether an earlier page exists.
  const [earlier, setEarlier] = useState({ hasMore: false, loading: false, failed: false })
  const oldestSeq = (messages ?? []).reduce((lowest, message) => (
    Number.isInteger(message.roomSeq) && (lowest === undefined || message.roomSeq < lowest) ? message.roomSeq : lowest
  ), undefined)
  useEffect(() => {
    const onResize = () => setPanelWidth(width => clampPanel(width, panelRange()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const startResize = (event) => {
    if (event.button !== 0 || panel === null) return
    event.preventDefault()
    const grip = event.currentTarget
    grip.setPointerCapture?.(event.pointerId)
    const from = { x: event.clientX, width: panelWidth }
    const range = panelRange()
    setResizing(true)
    const onMove = (move) => {
      setPanelWidth(clampPanel(from.width + from.x - move.clientX, range))
    }
    const end = () => {
      grip.removeEventListener('pointermove', onMove)
      grip.removeEventListener('pointerup', end)
      grip.removeEventListener('pointercancel', end)
      setResizing(false)
    }
    grip.addEventListener('pointermove', onMove)
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
  }
  const renameRoom = async (name) => {
    if (typeof onRoomAction !== 'function') return
    try {
      await onRoomAction('renameRoom', { name })
      setError(undefined)
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  const share = () => {
    const transcript = (messages ?? []).map((message) => {
      // A Bot's line is attributed to the Bot in the copied transcript, matching the bubble beside it.
      const who = message.senderBotId !== undefined
        ? (message.senderBotDisplayName ?? message.senderBotId)
        : (message.senderDisplayName ?? message.senderUserId ?? '')
      const files = (message.attachments ?? [])
        .map(entry => entry.fileName ?? entry.artifactId)
        .join(', ')
      return `**${who}:** ${message.body ?? ''}${files === '' ? '' : ` (${files})`}`
    }).join('\n\n')
    const written = navigator.clipboard?.writeText?.(transcript)
    if (written?.then === undefined) return
    void written.then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(failure => setError(failure?.message ?? String(failure)))
  }
  return h('div', {
    className: 'bt-wg',
    'data-wg': room?.id,
    'data-wg-kind': room?.kind ?? '',
    'data-wg-hub': hubState,
  },
  h('div', {
    className: 'bt-wg-surface',
    'data-resizing': resizing || undefined,
    style: { marginRight: panel === null ? 0 : `${panelWidth}px` },
  },
  h('div', { className: 'bt-head', 'data-wg-title': room?.name ?? '' },
    h('button', {
      type: 'button', className: 'bt-pill bt-wg-pill',
      'data-wg-details': panel === null ? 'closed' : 'open',
      'aria-expanded': panel !== null,
      'aria-label': t('View conversation details'), title: t('Group details'),
      onClick: () => setPanel(value => (value === null ? 'details' : null)),
    },
    room ? h(WorkgroupAvatar, { members, bots, local, size: 24 }) : null,
    h('span', { className: 'bt-pill-name' }, room?.name ?? ''),
    h('span', { className: `bt-wg-hub-dot bt-wg-hub-dot-${hubState ?? 'unknown'}`, 'aria-hidden': true }),
    h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow)))),
  h('div', { className: 'bt-wg-body', 'data-wg-details-shown': panel !== null || undefined },
    h('div', { className: 'bt-wg-main' },
      h(WorkgroupThread, {
        messages,
        tasks,
        selfUserId,
        leaderBotId: room?.adminBotId,
        empty,
        earlier,
        onLoadEarlier: async () => {
          if (typeof onLoadEarlier !== 'function' || oldestSeq === undefined || earlier.loading) return
          setEarlier({ hasMore: true, loading: true, failed: false })
          try {
            const page = await onLoadEarlier(oldestSeq)
            setEarlier({ hasMore: page?.hasMore === true, loading: false, failed: false })
          } catch (failure) {
            // The messages already on screen stay: a failed earlier page is a missing page, not a
            // reason to empty the conversation.
            setEarlier({ hasMore: true, loading: false, failed: true })
            setError(failure?.message ?? String(failure))
          }
        },
        onReact,
        onUnreact,
        onReply: message => setReply(replyPreview(message)),
        onDownload: async (entry) => {
          try { await onDownload?.(entry) } catch (failure) { setError(failure?.message ?? String(failure)) }
        },
        onImage,
        renderActivity: task => h(InlineActivity, {
          key: `task:${task.id}`,
          task,
          events: (events ?? []).filter(event => event.taskId === task.id),
          members,
          selfUserId,
          actions,
          run,
          loadOwnerBots,
          onDecision,
          onReview,
          onCancel,
        }),
      }),
      error === undefined ? null : h('div', { role: 'alert', className: 'bt-danger bt-wg-inline-error' }, error),
      h(WorkgroupComposer, {
        room,
        // The Hub decides this too; the picker only mirrors it so a member is not offered an `@all`
        // the send would refuse.
        canSummonEveryone: canSummonEveryone(room, identity),
        members,
        bots,
        reply,
        onClearReply: () => setReply(undefined),
        onSend,
        onAttach,
        schedules,
        onSchedule,
        onCancelSchedule,
        disabled: hubState !== undefined && hubState !== 'live' && hubState !== 'unknown',
      })))),
  shownPanel === null
    ? null
    : h('aside', {
      className: 'bt-panel bt-wg-panel',
      'aria-label': t('Group details'),
      'aria-hidden': panelLeaving || undefined,
      'data-leaving': panelLeaving || undefined,
      'data-dragging': resizing || undefined,
      style: { '--bt-panel-w': `${panelWidth}px` },
    },
    panelLeaving ? null : h('div', {
      className: 'bt-panel-grip',
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': t('Resize panel'),
      'data-wg-panel-grip': 'true',
      onPointerDown: startResize,
    }),
    h('div', { className: 'bt-panel-view' },
      shownPanel === 'settings'
        ? h(Fragment, null,
          h('div', { className: 'bt-subhead' },
            h('button', {
              type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to details'),
              'data-wg-settings-back': 'true', onClick: () => setPanel('details'),
            }, h(ChevronLeftIcon)),
            h('span', { className: 'bt-subhead-title' }, t('Group settings')),
            h('button', {
              type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close details'),
              'data-wg-settings-close': 'true', onClick: () => setPanel(null),
            }, h(CloseIcon))),
          h('div', { className: 'bt-drawer-body bt-set-body' },
            h(WorkgroupSettingsForm, {
              room: room ?? { name: '', members: [] },
              members,
              bots,
              selfUserId,
              identity,
              prefs,
              onFlag,
              onAction: onRoomAction,
              onDissolve,
              onClose: () => setPanel(null),
              loadOwnerBots,
              loadBotCandidates,
            })))
        : h(Fragment, null,
          h('div', { className: 'bt-drawer-top' },
            h('button', {
              type: 'button', className: 'bt-round', 'aria-label': t('Group settings'),
              title: t('Group settings'), 'data-wg-settings': 'open',
              onClick: () => setPanel('settings'),
            }, h(GearIcon)),
            h('button', {
              type: 'button', className: 'bt-round', 'data-wg-share': 'true',
              'aria-label': copied ? t('Copied conversation') : t('Share conversation'),
              title: copied ? t('Copied') : t('Copy conversation as Markdown'),
              onClick: share,
            }, copied ? h(CheckIcon) : h(ShareIcon)),
            h('button', {
              type: 'button', className: 'bt-round', 'aria-label': t('Close details'),
              'data-wg-details-close': 'true', onClick: () => setPanel(null),
            }, h(CloseIcon))),
          h('div', { className: 'bt-drawer-id' },
            h(MemberPile, { members, bots, local }),
            h(PanelName, { room, onRename: renameRoom }),
            h('span', { className: 'bt-drawer-role' },
              t('Workgroup · {count} members', { count: (members ?? []).length + (bots ?? []).length }))),
          h(WorkgroupDetails, {
            room,
            members,
            bots,
            tasks,
            events,
            selfUserId,
            actions,
            run,
            loadOwnerBots,
            onDecision,
            onReview,
            onCancel,
            onOpenSettings: () => setPanel('settings'),
            memory,
            hubState,
          })))))
}

export { WorkgroupThread, WorkgroupTasks, WorkgroupDetails, WorkgroupSettingsForm, WorkgroupComposer }
export { WORKGROUP_UI_CSS }
