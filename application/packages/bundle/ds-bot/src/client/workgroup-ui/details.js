// Workgroup details: the copied group preview, with the workgroup's own facts where the local
// group shows its execution settings.
//
// The original details pane answers: what is this group, who is in it, what is each member doing,
// how much has it used, and what does it remember. A workgroup answers the same questions from Hub
// data: members are people and Bots with owners, "what is it doing" is the task activity its owner
// approved, usage is the task count it produced, and its memory is the Hub's group memory.
//
// Stopping a member's work is the one action that must not be copied literally: a local group can
// end a Bot's process on this machine, while a workgroup cannot reach another person's machine. The
// control therefore cancels a task — the Hub's own stopping point — and grants are revoked by that
// same Hub route.
//
// The pane fetches nothing. Memory reads and writes arrive as an adapter, so a component that cannot
// see a token or a Hub client cannot be the place a permission is decided.

import { createElement as h, useEffect, useMemo, useState } from 'react'
import { BotMark } from '../mark.js'
import { dateLocale, t } from '../i18n.js'
import { isTaskActive, WorkgroupTasks } from './activity.js'
import { HumanFace } from './thread.js'
import { memberSummary } from './model.js'
import { presenceOf } from '../workgroup-presence.js'

const HUB_STATE_WORDS = { live: 'Online', offline: 'Offline', refused: 'Refused', 'signed-out': 'Signed out', absent: 'No Hub configured', unknown: 'Unknown' }

const when = value => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : ''
}

/** A folded long text, like the original group's About block. */
function About({ text, title, onMissing, missingLabel }) {
  const [open, setOpen] = useState(false)
  if (text === undefined || text === '') {
    return onMissing === undefined ? null : h('button', { type: 'button', className: 'bt-more', onClick: onMissing }, missingLabel)
  }
  const long = text.split('\n').length > 5 || text.length > 240
  return h('div', null,
    h('div', { className: 'bt-section-title' }, title),
    h('div', { className: 'bt-about', 'data-open': open || undefined, 'data-wg-notice': title }, text),
    long ? h('button', { type: 'button', className: 'bt-more', onClick: () => setOpen(value => !value) }, open ? t('Show less') : t('Show more')) : null)
}

function MemberRows({ members, bots, tasks, onCancel }) {
  const people = (members ?? []).map((member) => {
    const text = h('span', { className: 'bt-member-text' },
      h('span', { className: 'bt-member-line' },
        h('span', { className: 'bt-member-name' }, memberSummary(member)),
        h('span', {
          className: `bt-wg-member-dot bt-wg-member-dot-${member.online === true ? 'online' : 'offline'}`,
          'aria-hidden': true,
        })),
      h('span', { className: 'bt-member-sub' }, member.online === true ? t('Online') : t('Offline')))
    return h('div', {
      role: 'listitem',
      className: 'bt-member',
      key: member.userId,
      'data-wg-member': member.userId,
      'data-wg-presence': presenceOf(member),
    },
    h('div', { className: 'bt-member-row' },
      h('span', { className: 'bt-member-open' },
        h(HumanFace, { name: member.displayName ?? member.userId, size: 32 }),
        text)))
  })
  const machines = (bots ?? []).map((bot) => {
    const active = (tasks ?? []).find(task =>
      isTaskActive(task)
      && task.targetBotId === bot.botId
      && task.ownerUserId === bot.ownerUserId)
    const name = bot.displayName ?? bot.botId
    const text = h('span', { className: 'bt-member-text' },
      h('span', { className: 'bt-member-line' },
        h('span', { className: 'bt-member-name' }, name),
        h('span', { className: 'bt-tag' }, t('Bot'))),
      h('span', { className: 'bt-member-sub' },
        `${t('Owner: {name}', { name: bot.ownerDisplayName ?? bot.ownerUserId })}${active === undefined ? '' : ` · ${t('Working')}`}`))
    return h('div', { role: 'listitem', className: 'bt-member', key: `${bot.ownerUserId}:${bot.botId}` },
      h('div', { className: 'bt-member-row' },
        h('span', { className: 'bt-member-open' },
          h(BotMark, { look: { shape: 'circle', color: 'blue' }, size: 32 }),
          text),
        active === undefined
          ? null
          : h('button', {
            type: 'button', className: 'bt-member-stop', 'data-wg-stop-bot': bot.botId,
            'aria-label': `${t('Stop')} · ${name}`, onClick: () => onCancel?.(active),
          }, t('Stop'))))
  })
  return h('div', { className: 'bt-members', role: 'list' }, people, machines)
}

function TaskUsage({ tasks }) {
  const counts = useMemo(() => {
    const total = (tasks ?? []).length
    const open = (tasks ?? []).filter(isTaskActive).length
    const shared = (tasks ?? []).filter(task => task.state === 'SHARED').length
    return { total, open, shared }
  }, [tasks])
  if (counts.total === 0) return null
  return h('div', { key: 'usage' },
    h('div', { className: 'bt-section-title', 'data-wg-usage': 'true' }, t('Usage')),
    h('div', { className: 'bt-kv' }, h('span', null, t('{count} tasks', { count: counts.total })), h('span', null, t('{count} open', { count: counts.open }))),
    h('div', { className: 'bt-kv' }, h('span', null, t('Shared results')), h('span', null, String(counts.shared))))
}

/**
 * The group memory panel.
 *
 * Reads and writes go through `memory`, supplied by the pane: `list`, `search`, `create`, `revise`,
 * and `remove`. A missing adapter means the feature is unavailable on this Host, which is stated
 * rather than shown as an empty list — an empty list would claim the group remembers nothing.
 */
function MemoryPanel({ memory }) {
  const [entries, setEntries] = useState(undefined)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const load = async (search) => {
    if (memory === undefined) return
    setBusy(true); setError(undefined)
    try {
      const answered = search !== undefined && search.trim() !== ''
        ? await memory.search(search.trim())
        : await memory.list()
      setEntries(Array.isArray(answered) ? answered : [])
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally { setBusy(false) }
  }
  useEffect(() => { void load(undefined) }, [memory])
  const add = async () => {
    if (memory === undefined || draft.trim() === '') return
    setBusy(true); setError(undefined)
    try {
      await memory.create({ body: draft.trim(), scope: 'room' })
      setDraft('')
      await load(query)
    } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  const revise = async (entry) => {
    if (memory === undefined || draft.trim() === '' || draft.trim() === entry.body) { setEditing(undefined); return }
    setBusy(true); setError(undefined)
    try {
      await memory.revise(entry.id, { body: draft.trim(), expectedRevision: entry.revision })
      setEditing(undefined); setDraft('')
      await load(query)
    } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  const remove = async (entry) => {
    if (memory === undefined) return
    setBusy(true); setError(undefined)
    try {
      await memory.remove(entry.id)
      await load(query)
    } catch (failure) { setError(failure?.message ?? String(failure)) } finally { setBusy(false) }
  }
  if (memory === undefined) {
    return h('div', { className: 'bt-section-title' }, t('Group memory'),
      h('div', { className: 'bt-muted', 'data-wg-memory': 'unavailable' }, t('Group memory is unavailable on this Host.')))
  }
  return h('div', { 'data-wg-memory': 'panel' },
    h('div', { className: 'bt-section-title' }, t('Group memory')),
    h('div', { className: 'bt-set-row bt-bs-row' },
      h('input', {
        className: 'bt-bs-input', 'aria-label': t('Search group memory'), value: query,
        placeholder: t('Search group memory'),
        onChange: event => { setQuery(event.target.value); void load(event.target.value) },
      })),
    entries === undefined
      ? h('div', { className: 'bt-muted' }, t('Loading…'))
      : entries.length === 0
        ? h('div', { className: 'bt-muted', 'data-wg-memory-empty': 'true' }, t('The group has not remembered anything yet.'))
        : h('div', { className: 'bt-wg-memory-list' }, entries.map(entry => h('div', { className: 'bt-wg-memory', key: entry.id, 'data-wg-memory-entry': entry.id },
          h('div', { className: 'bt-wg-memory-body' }, entry.body),
          h('div', { className: 'bt-wg-memory-meta' },
            h('span', null, entry.authorUserId ?? ''),
            h('span', null, when(entry.updatedAt)),
            h('span', null, t('revision {n}', { n: entry.revision })),
            entry.scope === undefined ? null : h('span', null, t(entry.scope))),
          h('div', { className: 'bt-wg-task-actions' },
            h('button', {
              type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
              'data-wg-memory-revise': entry.id,
              onClick: () => { setEditing(entry.id); setDraft(entry.body) },
            }, t('Correct')),
            h('button', {
              type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
              'data-wg-memory-remove': entry.id, onClick: () => remove(entry),
            }, t('Delete')))))),
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('textarea', {
        className: 'bt-bs-input bt-bs-area', 'aria-label': editing === undefined ? t('New group memory') : t('Corrected group memory'),
        rows: 3, value: draft, placeholder: t('Something the group should remember…'),
        onChange: event => setDraft(event.target.value),
      }),
      h('div', { className: 'bt-wg-task-actions' },
        editing === undefined
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'data-wg-memory-add': 'true', disabled: busy || draft.trim() === '', onClick: add }, t('Remember'))
          : h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm', 'data-wg-memory-save': editing,
            disabled: busy || draft.trim() === '',
            onClick: () => revise(entries?.find(entry => entry.id === editing)),
          }, t('Save correction')),
        editing === undefined ? null : h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          onClick: () => { setEditing(undefined); setDraft('') },
        }, t('Cancel')))),
    error === undefined ? null : h('div', { role: 'alert', className: 'bt-danger', 'data-wg-memory-error': 'true' }, error))
}

/**
 * The details body.
 *
 * The approval cards are the same components the conversation uses; the details pane is where a
 * member looks for them when the conversation has scrolled on.
 */
export function WorkgroupDetails({
  room,
  members,
  bots,
  tasks,
  selfUserId,
  actions,
  run,
  loadOwnerBots,
  onDecision,
  onReview,
  onCancel,
  onOpenSettings,
  memory,
  hubState,
}) {
  return h('div', { className: 'bt-drawer-body', 'data-wg-details': room?.id },
    About({
      text: room?.notice ?? '',
      title: t('Notice'),
      onMissing: onOpenSettings,
      missingLabel: t('Add a notice in group settings'),
    }),
    h('div', { className: 'bt-section-title' }, t('Members · {count}', { count: (members ?? []).length + (bots ?? []).length })),
    h(MemberRows, { members, bots, tasks, onCancel }),
    h('div', null,
      h('div', { className: 'bt-section-title' }, t('Who answers')),
      h('div', { className: 'bt-muted', 'data-wg-who-answers': 'true' },
        t('No automatic answers. @ a Bot creates a task its owner approves.'))),
    h('div', null,
      h('div', { className: 'bt-section-title' }, t('Permissions')),
      h('div', { className: 'bt-muted', 'data-wg-permissions': 'true' },
        t('Each task runs only with the folder, tools, and lifetime its owner approves.'))),
    h('div', { className: 'bt-section-title' }, t('Workgroup')),
    h('div', { className: 'bt-kv' }, h('span', null, t('Hub')), h('span', { 'data-wg-hub-state': hubState ?? 'unknown' }, t(HUB_STATE_WORDS[hubState] ?? HUB_STATE_WORDS.unknown))),
    room?.dissolvedAt === undefined ? null : h('div', { className: 'bt-kv', 'data-wg-dissolved': room.dissolvedAt }, h('span', null, t('Dissolved')), h('span', null, when(room.dissolvedAt))),
    TaskUsage({ tasks }),
    h('div', { key: 'tasks' }, h('div', { className: 'bt-section-title' }, t('Task activity')),
      h(WorkgroupTasks, { tasks, selfUserId, members, actions, run, loadOwnerBots, onDecision, onReview, onCancel })),
    MemoryPanel({ memory }))
}
