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

import { createElement as h, useState } from 'react'
import { ChevronLeftIcon, GearIcon } from '../icons.js'
import { RoomAvatar } from '../mark.js'
import { t } from '../i18n.js'
import { replyPreview } from '../workgroup-reply.js'
import { unreadCount } from './model.js'
import { WorkgroupThread } from './thread.js'
import { WorkgroupComposer } from './composer.js'
import { TaskCard, WorkgroupTasks } from './activity.js'
import { WorkgroupDetails } from './details.js'
import { WorkgroupSettingsForm } from './settings.js'
import { WORKGROUP_UI_CSS } from './styles.js'

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
  watermark,
  empty,
  actions,
  run,
  onDecision,
  onReview,
  onCancel,
  onSend,
  settingsOpen = false,
  onCloseSettings = () => {},
  onDissolve,
  onAttach,
  onDownload,
  onImage,
  schedules,
  onSchedule,
  onCancelSchedule,
  onRoomAction,
  loadOwnerBots,
  loadBotCandidates,
  prefs,
  onFlag,
  memory,
  hubState,
}) {
  const [reply, setReply] = useState(undefined)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [error, setError] = useState(undefined)
  // The approval form's own dialog lives inside the settings surface for a member whose membership
  // is limited; this view never reaches past what the pane handed it.
  if (settingsOpen) {
    return h('div', { className: 'bt-wg bt-wg-settings', 'data-wg': room?.id, 'data-wg-kind': room?.kind ?? '' },
      h('div', { className: 'bt-subhead' },
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), onClick: onCloseSettings }, h(ChevronLeftIcon)),
        h('span', { className: 'bt-subhead-title' }, t('Group settings'))),
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
          onClose: onCloseSettings,
          loadOwnerBots,
          loadBotCandidates,
        })))
  }
  const unread = unreadCount(messages, watermark)
  return h('div', {
    className: 'bt-wg',
    'data-wg': room?.id,
    'data-wg-kind': room?.kind ?? '',
    'data-wg-hub': hubState,
  },
  h('div', { className: 'bt-wg-head', 'data-wg-title': room?.name ?? '' },
    h('button', {
      type: 'button', className: 'bt-pill bt-wg-pill', 'data-wg-details': detailsOpen ? 'open' : 'closed',
      'aria-expanded': detailsOpen, title: t('Group details'), onClick: () => setDetailsOpen(value => !value),
    },
    room ? h(RoomAvatar, { room: { ...room, members: (members ?? []).map(member => member.userId) }, roster: { byId: {}, bots: [] }, size: 24 }) : null,
    h('span', { className: 'bt-pill-name' }, room?.name ?? ''),
    unread > 0 ? h('span', { className: 'bt-wg-unread', 'data-wg-unread': String(unread) }, String(unread)) : null,
    h('span', { className: `bt-wg-hub-dot bt-wg-hub-dot-${hubState ?? 'unknown'}`, 'aria-hidden': true })),
    h('button', {
      type: 'button', className: 'bt-icon-btn bt-wg-gear', 'data-wg-settings': 'open',
      'aria-label': t('Group settings'), title: t('Group settings'), onClick: () => run?.(null),
    }, h(GearIcon))),
  room?.notice === undefined || room.notice === ''
    ? null
    : h('div', { className: 'bt-wg-notice-bar', 'data-wg-notice': 'true' }, room.notice),
  h('div', { className: 'bt-wg-body', 'data-wg-details-shown': detailsOpen || undefined },
    h('div', { className: 'bt-wg-main' },
      h(WorkgroupThread, {
        messages,
        tasks,
        selfUserId,
        empty,
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
      })),
    detailsOpen
      ? h('aside', { className: 'bt-wg-drawer', 'aria-label': t('Group details') },
        h('div', { className: 'bt-subhead' },
          h('span', { className: 'bt-subhead-title' }, t('Group details')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setDetailsOpen(false) }, t('Close'))),
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
          onOpenSettings: () => { setDetailsOpen(false); onCloseSettings?.('open') },
          onClose: () => setDetailsOpen(false),
          memory,
          hubState,
        }))
      : null))
}

export { WorkgroupThread, WorkgroupTasks, WorkgroupDetails, WorkgroupSettingsForm, WorkgroupComposer }
export { WORKGROUP_UI_CSS }
