// Workgroup task activity: the cards the copied conversation shows between messages.
//
// A workgroup Bot is remote. It does not post free text into the room; its work appears as task
// activity — a pending request its owner must approve, then progress, review, and a shared result.
// The card's language is the original group chat's: the same card surface, avatar marks, type scale,
// and row rhythm, so the two surfaces read as one product.
//
// The authorization shape is unchanged and lives here exactly as it did in the workgroup's own view:
//
//  * only the task's owner receives decision controls, and only the owner's own published Bots are
//    offered as the executor;
//  * a member sees the redacted public state the Hub already serves;
//  * cancellation is offered only to the people the Hub would accept it from.
//
// The Hub re-checks all of it. These rules decide what a person is shown, not what the Hub allows.

import { createElement as h, useEffect, useState } from 'react'
import { Row } from '../bot-settings.js'
import { FolderMenu } from '../folder-menu.js'
import { BotMark } from '../mark.js'
import { hostText, t } from '../i18n.js'
import { memberSummary } from './model.js'
import { ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, approvalScope, taskStateLabel } from '@deepseek-ai/dsh-workgroup/client/approvals'

// What a task event is called in the activity card. The Hub's public event payload carries no
// private scope, so a label is all this projection needs.
const EVENT_WORDS = {
  'task.created': 'Requested',
  'task.approved': 'Approved',
  'task.rejected': 'Rejected',
  'task.cancelled': 'Cancelled',
  'task.expired': 'Expired',
  'task.progress': 'Progress',
  'task.shared': 'Result shared',
  'task.failed': 'Failed',
}

const TERMINAL = ['CANCELLING', 'CANCELLED', 'COMPLETED', 'SHARED', 'REJECTED', 'FAILED', 'EXPIRED']

function ApprovalForm({ task, members, selfUserId, actions, run, loadOwnerBots, onDecision, onCancel }) {
  const [bots, setBots] = useState([])
  const [botsNote, setBotsNote] = useState(undefined)
  const [mode, setMode] = useState('')
  const [botId, setBotId] = useState('')
  const [workDir, setWorkDir] = useState('')
  const [tools, setTools] = useState('')
  const [expirySeconds, setExpirySeconds] = useState('')
  const [recipients, setRecipients] = useState([])
  const [note, setNote] = useState(undefined)

  // The directory read happens when the form opens, not when the view mounts: an owner who never
  // approves anything never asks the Hub for their Bot list.
  useEffect(() => {
    let live = true
    if (typeof loadOwnerBots !== 'function') {
      setBotsNote(t('Your published Bots are unavailable, so this approval cannot name one.'))
      return () => { live = false }
    }
    Promise.resolve(loadOwnerBots())
      .then((listed) => {
        if (!live) return
        const own = (Array.isArray(listed) ? listed : [])
          .filter(entry => entry?.botId !== undefined && (entry.ownerUserId === undefined || entry.ownerUserId === selfUserId))
        setBots(own)
        if (task.targetBotId !== undefined && own.some(entry => entry.botId === task.targetBotId)) {
          setMode('existing_bot')
          setBotId(task.targetBotId)
        }
      })
      .catch((error) => { if (live) setBotsNote(hostText(error?.message ?? String(error))) })
    return () => { live = false }
  }, [task.targetBotId, selfUserId, loadOwnerBots])

  const recipientOptions = (members ?? []).filter(member => member.userId !== selfUserId)
  const folderReady = typeof actions?.folders === 'function'
  const submit = () => {
    setNote(undefined)
    const refuse = (message) => { setNote(message); return false }
    if (!Number.isInteger(task.version)) return refuse(t('This task has no version to decide against. Reload it.'))
    if (!ASSIGNMENT_MODES.includes(mode)) return refuse(t('Choose how this task should be assigned.'))
    if (mode === 'existing_bot' && !bots.some(entry => entry.botId === botId)) return refuse(t('Choose one of your published Bots.'))
    if (workDir === '') return refuse(t('Choose the folder this task may work in.'))
    const allowedTools = tools.split(',').map(text => text.trim()).filter(text => text !== '')
    if (allowedTools.length === 0) return refuse(t('Name at least one tool this task may use.'))
    const seconds = Number(expirySeconds)
    if (!Number.isInteger(seconds) || seconds <= 0) return refuse(t('Give the task a lifetime in whole seconds.'))
    if (recipients.length === 0) return refuse(t('Choose who may receive the result.'))
    let scope
    try {
      scope = approvalScope({
        mode,
        botId,
        workDir,
        tools: allowedTools,
        recipients,
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
      })
    } catch (error) {
      return refuse(hostText(error?.message ?? String(error)))
    }
    onDecision(task, 'approve', {
      expectedVersion: task.version,
      mode,
      ...(scope.assignedBotId === undefined ? {} : { botId: scope.assignedBotId }),
      workDir: scope.workDir,
      tools: scope.tools,
      recipients: scope.recipients,
      expiresAt: scope.expiresAt,
    })
    return true
  }

  return h('div', { className: 'bt-wg-approval', 'data-wg-approval-form': task.id },
    h(Row, { label: t('Assignment mode') },
      h('select', {
        'data-wg-assignment-mode': task.id,
        'aria-label': t('Assignment mode'),
        value: mode,
        onChange: event => setMode(event.target.value),
      },
      h('option', { value: '' }, t('Choose…')),
      ASSIGNMENT_MODES.map(choice => h('option', {
        key: choice,
        value: choice,
        disabled: choice === 'existing_bot' && bots.length === 0,
      }, t(ASSIGNMENT_MODE_LABELS[choice]))))),
    mode === 'existing_bot'
      ? h(Row, { label: t('Bot') },
        h('select', {
          'data-wg-assigned-bot': task.id,
          'aria-label': t('Bot'),
          value: botId,
          onChange: event => setBotId(event.target.value),
        },
        h('option', { value: '' }, t('Choose…')),
        bots.map(entry => h('option', { key: entry.botId, value: entry.botId }, entry.displayName ?? entry.botId))))
      : null,
    botsNote === undefined ? null : h('div', { className: 'bt-wg-approval-note' }, botsNote),
    h(Row, { label: t('Working folder') },
      h('div', { 'data-wg-workdir': task.id },
        folderReady
          ? h(FolderMenu, { value: workDir, actions, run, onPick: setWorkDir })
          : h('span', { className: 'bt-wg-approval-note' }, t('Folder choices are unavailable on this machine.')))),
    h(Row, { label: t('Allowed tools') },
      h('input', {
        'data-wg-tools': task.id,
        'aria-label': t('Allowed tools'),
        placeholder: t('Allowed tools, for example read, summarize'),
        value: tools,
        onChange: event => setTools(event.target.value),
      })),
    h(Row, { label: t('Lifetime (seconds)') },
      h('input', {
        'data-wg-expiry': task.id,
        'aria-label': t('Lifetime (seconds)'),
        inputMode: 'numeric',
        placeholder: '3600',
        value: expirySeconds,
        onChange: event => setExpirySeconds(event.target.value),
      })),
    h(Row, { label: t('Recipients') },
      h('div', { className: 'bt-wg-approval-recipients' },
        recipientOptions.map(member => h('label', { key: member.userId, className: 'bt-wg-approval-recipient' },
          h('input', {
            type: 'checkbox',
            'data-wg-recipient': member.userId,
            checked: recipients.includes(member.userId),
            onChange: event => setRecipients((list) => {
              const next = list.filter(entry => entry !== member.userId)
              return event.target.checked ? [...next, member.userId] : next
            }),
          }),
          h('span', {}, memberSummary(member)))))),
    note === undefined ? null : h('div', { className: 'bt-wg-approval-error bt-danger', role: 'alert', 'data-wg-approval-error': task.id }, note),
    h('div', { className: 'bt-wg-task-actions' },
      h('button', { type: 'button', className: 'bt-wg-approve', 'data-wg-approval-submit': task.id, onClick: submit }, t('Approve')),
      h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-approval-cancel': task.id, onClick: onCancel }, t('Cancel'))))
}

/**
 * The owner's review of a finished result.
 *
 * A result is not published by being produced: the owner keeps it, rejects it, or shares it with
 * named recipients. `keep` and `reject` publish nothing, so only `share` asks for recipients.
 */
function ReviewControls({ task, members, selfUserId, onReview }) {
  const [recipients, setRecipients] = useState([])
  const [note, setNote] = useState(undefined)
  const options = (members ?? []).filter(member => member.userId !== selfUserId)
  const review = (decision) => {
    setNote(undefined)
    if (!Number.isInteger(task.version)) {
      setNote(t('This task has no version to decide against. Reload it.'))
      return
    }
    if (decision === 'share' && recipients.length === 0) {
      setNote(t('Choose who may receive the result.'))
      return
    }
    onReview?.(task, decision, {
      expectedVersion: task.version,
      ...(decision === 'share' ? { recipients } : {}),
    })
  }
  return h('div', { className: 'bt-wg-review', 'data-wg-review': task.id },
    h('div', { className: 'bt-wg-task-actions' },
      h('button', { type: 'button', className: 'bt-soft', 'data-wg-review-keep': task.id, onClick: () => review('keep') }, t('Keep result')),
      h('button', { type: 'button', className: 'bt-soft', 'data-wg-review-reject': task.id, onClick: () => review('reject') }, t('Reject result')),
      h('button', { type: 'button', className: 'bt-soft', 'data-wg-review-share': task.id, onClick: () => review('share') }, t('Share result'))),
    h(Row, { label: t('Recipients') },
      h('div', { className: 'bt-wg-approval-recipients' },
        options.map(member => h('label', { key: member.userId, className: 'bt-wg-approval-recipient' },
          h('input', {
            type: 'checkbox',
            'data-wg-review-recipient': member.userId,
            checked: recipients.includes(member.userId),
            onChange: event => setRecipients((list) => {
              const next = list.filter(entry => entry !== member.userId)
              return event.target.checked ? [...next, member.userId] : next
            }),
          }),
          h('span', {}, memberSummary(member)))))),
    note === undefined ? null : h('div', { className: 'bt-wg-approval-error bt-danger', role: 'alert', 'data-wg-review-error': task.id }, note))
}

/** The owner's Bot mark, or a neutral card mark for a task whose Bot is not named. */
function TaskMark({ task }) {
  return h('span', { className: 'bt-activity-mark', 'aria-hidden': true },
    h(BotMark, { look: { shape: 'circle', color: task.state === 'PENDING_APPROVAL' ? 'orange' : 'blue' }, size: 22 }))
}

/**
 * One task's card.
 *
 * `now`-based filtering is not used: the Hub reports a task's state, and a card is a rendering of
 * that state, not a second state machine.
 */
export function TaskCard({ task, events, members, selfUserId, actions, run, loadOwnerBots, onDecision, onReview, onCancel, open, onOpen, onClose }) {
  const pending = task.state === 'PENDING_APPROVAL'
  const mine = task.ownerUserId === selfUserId
  const role = (members ?? []).find(member => member.userId === selfUserId)?.role
  const mayCancel = task.requesterUserId === selfUserId || task.ownerUserId === selfUserId || role === 'owner' || role === 'admin'
  const cancellable = !TERMINAL.includes(task.state)
  return h('section', {
    className: 'bt-activity',
    'data-wg-task': task.id,
    'data-wg-task-state': task.state,
    'data-wg-pending': pending ? 'true' : undefined,
  },
  h('header', { className: 'bt-activity-head' },
    h(TaskMark, { task }),
    h('span', { className: 'bt-activity-title' }, t(taskStateLabel(task.state))),
    h('span', { className: 'bt-activity-who' }, task.requesterDisplayName ?? task.requesterUserId ?? '')),
  h('div', { className: 'bt-activity-body' },
    h(Row, { label: t('Requested by') }, task.requesterDisplayName ?? task.requesterUserId),
    h(Row, { label: t('What') }, task.description),
    task.targetBotId === undefined ? null : h(Row, { label: t('Requested Bot') }, task.targetBotId),
    task.lastReason === undefined
      ? null
      : h(Row, { label: t('Last failure') }, h('code', { 'data-wg-task-reason': task.lastReason }, task.lastReason))),
  (events ?? []).length === 0
    ? null
    : h('div', { className: 'bt-activity-events', 'data-wg-task-events': task.id },
      (events ?? []).map(event => h('div', { key: event.id, className: 'bt-activity-event', 'data-wg-task-event': event.eventType },
        h('span', { className: 'bt-wg-member-dot', 'aria-hidden': true }),
        h('span', { className: 'bt-activity-event-what' }, t(EVENT_WORDS[event.eventType] ?? event.eventType)),
        h('span', { className: 'bt-activity-event-at' }, String(event.createdAt ?? '').slice(11, 16))))),
  pending && mine
    ? open
      ? h(ApprovalForm, { task, members, selfUserId, actions, run, loadOwnerBots, onDecision, onCancel: onClose })
      : h('div', { className: 'bt-wg-task-actions' },
        h('button', { type: 'button', className: 'bt-wg-approve', 'data-wg-approve': task.id, onClick: onOpen }, t('Approve')),
        h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-reject': task.id, onClick: () => onDecision?.(task, 'reject') }, t('Reject')))
    : null,
  task.ownerUserId === selfUserId && task.state === 'REVIEW_REQUIRED'
    ? h(ReviewControls, { task, members, selfUserId, onReview })
    : null,
  cancellable && mayCancel
    ? h('div', { className: 'bt-wg-task-actions' },
      h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-cancel': task.id, onClick: () => onCancel?.(task) }, t('Cancel task')))
    : null)
}

/**
 * The task strip: every task in the room, newest activity first.
 *
 * Kept as a named export because the conversation and the details drawer both show it, and a second
 * projection of the same tasks would be a second place to forget the owner-only rule.
 */
export function WorkgroupTasks({ tasks, events, selfUserId, members, actions, run, loadOwnerBots, onDecision, onReview, onCancel }) {
  const [openId, setOpenId] = useState(undefined)
  const all = [...(tasks ?? [])].sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))
  if (all.length === 0) return null
  return h('div', { className: 'bt-wg-tasks', 'data-wg-pending': String(all.filter(task => task.state === 'PENDING_APPROVAL').length) },
    all.map(task => h(TaskCard, {
      key: task.id,
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
      open: openId === task.id,
      onOpen: () => setOpenId(task.id),
      onClose: () => setOpenId(undefined),
    })))
}

/** The cards the conversation shows inline, one per task, in the same order as the strip. */
export function activityOf(tasks) {
  return (tasks ?? []).map(task => ({
    kind: 'activity',
    id: `task:${task.id}`,
    at: task.createdAt ?? task.updatedAt,
    task,
  }))
}
