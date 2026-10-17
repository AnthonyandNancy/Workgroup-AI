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

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { RoomAvatar } from './mark.js'
import { Card, Row, InlineText } from './bot-settings.js'
import { WorkgroupSettings } from './workgroup-settings.js'
import { FolderMenu } from './folder-menu.js'
import { replyParent, replyPreview } from './workgroup-reply.js'
import { presenceOf } from './workgroup-presence.js'
import { identityRows, identityText } from './workgroup-identity.js'
import { hostText, t } from './i18n.js'
import { composeMessage, filterCandidates, mentionCandidates, MENTION_TRIGGER } from './workgroup-mentions.js'
import { ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, approvalScope, taskStateLabel } from '@deepseek-ai/dsh-workgroup/client/approvals'

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
export function WorkgroupThread({ messages, selfUserId, empty, onReply, onDownload }) {
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
      (message.attachments ?? []).map(entry => h('button', {
        key: entry.artifactId, type: 'button', className: 'bt-soft bt-soft-sm',
        'data-wg-artifact': entry.artifactId, onClick: () => onDownload?.(entry),
      }, entry.fileName ?? entry.artifactId)),
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
 * The owner's approval form.
 *
 * Every field here is one the owner is granting, so none of them has a default that would let the
 * decision go out with less than the owner saw. The form refuses locally — before any request — when
 * the mode, Bot, folder, tools, lifetime, recipients, or version is missing. That refusal is a
 * courtesy, not the gate: the Hub checks ownership and version, and the executor re-checks the
 * scope on every call.
 *
 * The Bot list comes from the owner's own published directory (`loadOwnerBots`), never from the
 * room's mixed roster: a room shows a colleague's Bot because it is a member of the room, and that
 * says nothing about what this owner may dispatch to.
 */
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
        // A request that already names a Bot starts on it: the requester and the owner then see the
        // same choice, and the owner is not asked twice for the same fact.
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
    if (!Number.isInteger(task.version)) {
      return refuse(t('This task has no version to decide against. Reload it.'))
    }
    if (!ASSIGNMENT_MODES.includes(mode)) return refuse(t('Choose how this task should be assigned.'))
    if (mode === 'existing_bot' && !bots.some(entry => entry.botId === botId)) {
      return refuse(t('Choose one of your published Bots.'))
    }
    if (workDir === '') return refuse(t('Choose the folder this task may work in.'))
    const allowedTools = tools.split(',').map(text => text.trim()).filter(text => text !== '')
    if (allowedTools.length === 0) return refuse(t('Name at least one tool this task may use.'))
    const seconds = Number(expirySeconds)
    if (!Number.isInteger(seconds) || seconds <= 0) return refuse(t('Give the task a lifetime in whole seconds.'))
    if (recipients.length === 0) return refuse(t('Choose who may receive the result.'))
    let scope
    try {
      // One builder for the recorded scope, shared with the integration client: the form must not
      // invent a field the Hub would store but no executor reads.
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
        // An option that cannot be completed is offered disabled rather than hidden: the layout does
        // not jump while the Bot list loads, and a person who wants "existing Bot" learns why it is
        // not available yet instead of watching it appear.
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
 * named recipients. `keep` and `reject` publish nothing, so only `share` asks for recipients, and a
 * share with nobody named is refused here rather than sent as an unfinished question.
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

/**
 * The task strip: pending approvals and the state of every other task in the room.
 *
 * A task's decision belongs to its owner. Other members may see the public request state, but never
 * receive decision controls for another person's task: the Hub refuses them anyway, and a button
 * that only ever produces a refusal is a worse way to say so.
 *
 * The state line is the redacted projection the Hub already serves every member — the state name
 * and the request — so the requester can see approved, running, review, completed, shared, failed,
 * or cancelled without learning which Bot ran, where it ran, or what it was allowed to use.
 */
export function WorkgroupTasks({ tasks, selfUserId, members, actions, run, loadOwnerBots, onDecision, onReview, onCancel }) {
  const [openId, setOpenId] = useState(undefined)
  const all = tasks ?? []
  const pending = all.filter(task => task.state === 'PENDING_APPROVAL')
  const rest = all.filter(task => task.state !== 'PENDING_APPROVAL')
  const role = (members ?? []).find(member => member.userId === selfUserId)?.role
  // The Hub decides who may cancel; the strip offers the control to the people who can actually
  // succeed, so a member is never handed a button whose only answer is a refusal.
  const mayCancel = task => task.requesterUserId === selfUserId || task.ownerUserId === selfUserId || role === 'owner' || role === 'admin'
  // A terminal task has nothing to cancel, and one already stopping would just be refused.
  const cancellable = task => !['CANCELLING', 'CANCELLED', 'COMPLETED', 'SHARED', 'REJECTED', 'FAILED', 'EXPIRED'].includes(task.state)
  if (pending.length === 0 && rest.length === 0) return null
  return h('div', { className: 'bt-wg-tasks', 'data-wg-pending': String(pending.length) },
    pending.map((task) => {
      const mine = task.ownerUserId === selfUserId
      return h(Card, { key: task.id, title: t('Approval needed') },
        h(Row, { label: t('Requested by') }, task.requesterDisplayName ?? task.requesterUserId),
        h(Row, { label: t('What') }, task.description),
        task.targetBotId === undefined ? null : h(Row, { label: t('Requested Bot') }, task.targetBotId),
        mine
          ? openId === task.id
            ? h(ApprovalForm, {
              task,
              members,
              selfUserId,
              actions,
              run,
              loadOwnerBots,
              onDecision,
              onCancel: () => setOpenId(undefined),
            })
            : h('div', { className: 'bt-wg-task-actions' },
              h('button', { type: 'button', className: 'bt-wg-approve', 'data-wg-approve': task.id, onClick: () => setOpenId(task.id) }, t('Approve')),
              h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-reject': task.id, onClick: () => onDecision?.(task, 'reject') }, t('Reject')))
          : null)
    }),
    rest.map(task => h(Card, { key: task.id, title: t(taskStateLabel(task.state)) },
      h('div', { 'data-wg-task': task.id, 'data-wg-task-state': task.state },
        h(Row, { label: t('Requested by') }, task.requesterDisplayName ?? task.requesterUserId),
        h(Row, { label: t('What') }, task.description),
        // The Hub publishes only a category code for a failure, so the room can say what kind of
        // failure it was without the owner's message or tool output.
        task.lastReason === undefined
          ? null
          : h(Row, { label: t('Last failure') }, h('code', { 'data-wg-task-reason': task.lastReason }, task.lastReason))),
      task.ownerUserId === selfUserId && task.state === 'REVIEW_REQUIRED'
        ? h(ReviewControls, { task, members, selfUserId, onReview })
        : null,
      cancellable(task) && mayCancel(task)
        ? h('div', { className: 'bt-wg-task-actions' },
          h('button', { type: 'button', className: 'bt-wg-reject', 'data-wg-cancel': task.id, onClick: () => onCancel?.(task) }, t('Cancel task')))
        : null)))
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
  // The owner's judgement on a finished result: keep it, reject it, or share it with named
  // recipients. Supplied by the pane; absent means a review surface with no action, which is the
  // right default for a viewer who is not the owner.
  onReview,
  // Stop a task this viewer may cancel. The pane performs the Hub call; this view only decides where
  // the control belongs.
  onCancel,
  onSend,
  settingsOpen = false,
  onCloseSettings = () => {},
  // The owner's dissolve action, passed in from the pane so this view keeps no Hub knowledge of its
  // own. Absent means the settings form's end-the-group button does nothing, which is the right
  // default for a viewer who is not the owner.
  onDissolve,
  // Uploads one file and answers with the artifact it created. Supplied by the pane, which holds the
  // Hub client; absent means the attach control reports that attaching is unavailable rather than
  // silently doing nothing.
  onAttach,
  onDownload,
  onRoomAction,
  // The owner's own published Bot directory, read when an approval form opens. Supplied by the
  // pane, which holds the Hub adapter; absent means the form refuses rather than falling back to
  // the room's mixed Bot list.
  loadOwnerBots,
}) {
  const [draft, setDraft] = useState('')
  const pendingSend = useRef(undefined)
  const [sending, setSending] = useState(false)
  const [reply, setReply] = useState(undefined)
  // Who the message summons, and what has been typed after the trigger. Kept apart from `draft` because
  // the mentions must be what the sender picked, not what the text happens to contain: deriving them
  // from the text would make a rename break a mention and would read typed prose as a summons.
  const [picked, setPicked] = useState([])
  const [mentionQuery, setMentionQuery] = useState(undefined)
  const [attachments, setAttachments] = useState([])
  const [attachNote, setAttachNote] = useState(undefined)
  const mentioning = mentionQuery !== undefined

  /**
   * Track whether the sender is currently typing a mention, and what they have typed.
   *
   * The query is the run of characters between the last trigger and the caret, so typing "@bo" offers
   * Bob while ordinary prose containing "@" leaves the picker closed.
   */
  const trackMention = (value) => {
    const caret = value.length
    const trigger = value.lastIndexOf(MENTION_TRIGGER, caret - 1)
    if (trigger === -1) { setMentionQuery(undefined); return }
    const run = value.slice(trigger + 1, caret)
    // A space ends the mention: "@alice could you" is a completed mention, not a query for "alice could".
    if (/\s/.test(run)) { setMentionQuery(undefined); return }
    setMentionQuery(run)
  }

  /** Add one picked person to the message and close the picker. */
  const pickMention = (candidate) => {
    setPicked(list => (list.some(entry => entry.userId === candidate.userId && entry.botId === candidate.botId)
      ? list
      : [...list, candidate]))
    // The name is inserted so the reader sees whom the sender addressed. The mention itself was already
    // recorded by construction, which is the point: the two cannot disagree.
    const trigger = draft.lastIndexOf(MENTION_TRIGGER)
    setDraft(trigger === -1 ? `${draft}${candidate.label} ` : `${draft.slice(0, trigger)}${candidate.label} `)
    setMentionQuery(undefined)
  }

  /**
   * Read the chosen file, upload it, and remember it for the next send.
   *
   * The upload happens on selection rather than on send so a failure is reported while the employee is
   * still looking at the picker, and so a large file is not re-read on every keystroke.
   */
  const attachFile = async (file) => {
    if (file === undefined || file === null) return
    setAttachNote(undefined)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const uploaded = await onAttach?.({
        fileName: file.name,
        bytes,
        // The browser's own guess is what will be shown to the recipient; the Hub stores it with the ACL.
        contentType: file.type === '' ? undefined : file.type,
      })
      if (uploaded === undefined || uploaded === null) return
      setAttachments(list => [...list, { artifactId: uploaded.artifactId, fileName: uploaded.fileName ?? file.name }])
    } catch (error) {
      setAttachNote(error?.message ?? String(error))
    }
  }

  // The composer clears only after the Hub accepted the message: clearing on submit and then
  // failing loses what the employee typed.
  const send = async () => {
    if (sending || draft.trim() === '') return
    setSending(true)
    const extra = {
      mentions: composeMessage(draft, picked).mentions,
      attachments: attachments.map(entry => ({ artifactId: entry.artifactId })),
    }
    const key = JSON.stringify({ roomId: room?.id, text: draft.trim(), reply: reply?.id, ...extra })
    if (pendingSend.current?.key !== key) pendingSend.current = { key, id: globalThis.crypto.randomUUID() }
    try {
      const ok = await onSend?.(draft.trim(), reply, { ...extra, clientMessageId: pendingSend.current.id })
      if (ok !== false) {
        pendingSend.current = undefined
        setDraft(''); setReply(undefined); setPicked([]); setAttachments([]); setMentionQuery(undefined)
      }
    } catch (error) {
      setAttachNote(error?.message ?? String(error))
    } finally {
      setSending(false)
    }
  }
  useEffect(() => {
    pendingSend.current = undefined
    setDraft(''); setReply(undefined); setPicked([]); setAttachments([]); setMentionQuery(undefined)
  }, [room?.id])
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
      h(WorkgroupSettings, { room, members, selfUserId, onAction: onRoomAction, onDissolve, onClose: onCloseSettings }))
  }

  const unread = unreadCount(messages, watermark)
  return h('div', { className: 'bt-wg', 'data-wg': room?.id, 'data-wg-kind': room?.kind ?? '' },
    h('div', { className: 'bt-wg-head', 'data-wg-title': room?.name ?? '' },
      room ? h(RoomAvatar, { room: { ...room, members: (members ?? []).map(member => member.userId) }, roster: { byId: {}, bots: bots ?? [] }, size: 24 }) : null,
      h('span', { className: 'bt-wg-name' }, room?.name ?? ''),
      unread > 0 ? h('span', { className: 'bt-wg-unread', 'data-wg-unread': String(unread) }, String(unread)) : null,
      h('button', { type: 'button', className: 'bt-wg-gear', 'data-wg-settings': 'open', onClick: () => run?.(null) }, t('Group settings'))),
    h(WorkgroupThread, {
      messages,
      selfUserId,
      empty: empty ?? t('No messages yet'),
      onReply: message => setReply(replyPreview(message)),
      onDownload: async (entry) => {
        try { await onDownload?.(entry) } catch (error) { setAttachNote(error?.message ?? String(error)) }
      },
    }),
    h(WorkgroupTasks, { tasks, selfUserId, members, actions, run, loadOwnerBots, onDecision, onReview, onCancel }),
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
    // What is about to be sent, shown above the composer: the file the sender attached, and any reason
    // the attach failed. Without this the attach control would look like it did nothing.
    attachments.length > 0 || attachNote !== undefined
      ? h('div', { className: 'bt-wg-pending', 'data-wg-pending': 'attachments' },
        attachments.map(entry => h('span', { className: 'bt-wg-pending-item', key: entry.artifactId },
          h('span', { className: 'bt-wg-pending-name' }, entry.fileName),
          h('button', {
            type: 'button', className: 'bt-wg-pending-drop', 'data-wg-pending-drop': entry.artifactId,
            'aria-label': t('Remove {name}', { name: entry.fileName }),
            onClick: () => setAttachments(list => list.filter(item => item.artifactId !== entry.artifactId)),
          }, t('Remove')))),
        attachNote === undefined ? null : h('span', { className: 'bt-wg-pending-error bt-danger', 'data-wg-attach-error': 'true' }, attachNote))
      : null,
    h('div', { className: 'bt-wg-compose' },
      // The mention picker opens on the trigger and narrows as the sender keeps typing, the way the
      // team's own @ menu does. The names shown are for reading; what the message sends is ids.
      mentioning ? h('div', { className: 'bt-wg-mentions', 'data-wg-mentions': 'open', role: 'listbox', 'aria-label': t('Mention someone') },
        filterCandidates(mentionCandidates({ members, bots }), mentionQuery).slice(0, 8).map(candidate =>
          h('button', {
            type: 'button',
            className: 'bt-wg-mention',
            'data-wg-mention': candidate.botId === undefined ? candidate.userId : `${candidate.userId}:${candidate.botId}`,
            key: candidate.botId === undefined ? candidate.userId : `${candidate.userId}:${candidate.botId}`,
            role: 'option',
            'aria-selected': 'false',
            onClick: () => pickMention(candidate),
          },
          h('span', { className: 'bt-wg-mention-name' }, candidate.label),
          candidate.kind === 'bot'
            ? h('span', { className: 'bt-wg-mention-kind' }, t('Bot of {owner}', { owner: candidate.detail ?? '' }))
            : null)),
        filterCandidates(mentionCandidates({ members, bots }), mentionQuery).length === 0
          ? h('div', { className: 'bt-wg-mention-empty' }, t('Nobody in this workgroup matches.'))
          : null)
        : null,
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
        onInput: (event) => trackMention(event.target.value),
      }),
      // A file is chosen, read, and uploaded by the host, which is where the bytes and the Hub client
      // both live. The picker is a file input rather than a path field so the employee never has to type
      // a path, and so the browser's own file access rules decide what can be read.
      h('label', { className: 'bt-wg-attach', 'data-wg-attach': 'choose', title: t('Attach a file') },
        h('input', {
          type: 'file',
          className: 'bt-wg-attach-input',
          'aria-label': t('Attach a file'),
          onChange: event => { void attachFile(event.target.files?.[0]); event.target.value = '' },
        }),
        t('Attach')),
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
