// The workgroup pane: the workgroup a `wg:` Session stands for, mounted over the conversation.
//
// A workgroup lives on the Hub, so it has no local room, no local message log, and no Bot row in
// the team's roster — the local roster cannot name it. What it does have is a Session, created by
// the host when the room was created (`wg:<roomId>`, see `workgroup.js`). That Session is what the
// shell navigates to, and its id is therefore the one identity that is always available, on any
// machine, after any reload: no cached room list is consulted and nothing has to be remembered
// across restarts.
//
// This module is the router, and only the router. `WorkgroupView` renders what it is handed and
// does no fetching, so the reads live here: the pane opens a room through the Hub adapter the
// plugin already owns (`workgroupHub`) and passes the answer down. Mounting the pane only when the
// main Session is a workgroup Session is what keeps every other conversation untouched — a local
// chat and a local group chat are ordinary Sessions and render exactly as before.
//
// Rendered as a pane rather than as the conversation's own body because the two are owned by
// different plugins: `conversation.content` is a factory definition registered by `ui-conversation`,
// and a second definition throws. `shell.overlay` is the shell's own list for exactly this kind of
// full-surface view, and it is where the team's other panes (new chat, exchange, voice) already
// live.

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { usePaneLeft } from './overlay-hooks.js'
import { mainSessionId, mainWorkgroupSession, needsHomeFallback } from '../shared/workgroup-session.js'
import { roomIdOfSession, WorkgroupView } from './workgroup.js'
import { withReply } from './workgroup-reply.js'
import { hubStatusCopy, hubStatusOf } from './workgroup-status.js'
import { t } from './i18n.js'

/** How often the pane re-reads a room it is already showing, while the tab is visible. */
const POLL_MS = 4000

/** How many messages one "load earlier" fetch asks for. */
const EARLIER_PAGE = 50

// Re-exported rather than reimplemented: the sidebar's view of the main Session and this pane's
// must agree, or the pane would render over a conversation the shell thinks it left, and the
// unknown-Session fallback would pull a workgroup away. One module owns both rules.
export { mainSessionId, mainWorkgroupSession, needsHomeFallback }

/**
 * The pane itself: nothing at all unless the main Session is a workgroup.
 *
 * @param props - the registered inject face; both sources render reactively through `hooks`.
 */
export function WorkgroupPane({ useSessions, useWorkgroups, useHub, useWorkgroupRoom, actions }) {
  const sessionId = useSessions(mainWorkgroupSession)
  const workgroups = useWorkgroups(value => value)
  const hub = useHub(value => value)
  const roomSnapshot = useWorkgroupRoom?.(roomIdOfSession(sessionId) ?? '')
  if (sessionId === undefined) return null
  return h(WorkgroupSurface, {
    key: sessionId,
    sessionId,
    workgroups,
    hub,
    roomSnapshot,
    actions,
  })
}

/**
 * The workgroup of one Session, read from the Hub and rendered through `WorkgroupView`.
 *
 * Reads are keyed on the room, so switching rooms refetches and the previous room is never shown
 * under the new room's name.
 *
 * @param props - `sessionId` (`wg:<roomId>`), the Hub adapter, the Hub connection state, and the
 *   team actions.
 */
export function WorkgroupSurface({ sessionId, workgroups, hub, actions, roomSnapshot }) {
  const roomId = roomIdOfSession(sessionId)
  const paneLeft = usePaneLeft()
  const [loaded, setState] = useState({ phase: 'loading' })
  const state = roomSnapshot === undefined ? loaded : { ...loaded, ...roomSnapshot }
  const view = useRef(null)

  useEffect(() => {
    setState({ phase: 'loading' })
    if (workgroups === undefined || roomId === undefined) return () => {}
    let stopped = false
    let timer
    const load = async () => {
      clearTimeout(timer)
      try {
        // The room snapshot and its redacted task activity are read together: a task card without its
        // progress history would show a state with no account of how it got there, and the activity is
        // not a message, so it cannot arrive through the message page.
        const [answer, activity, scheduled] = await Promise.all([
          workgroups.openRoom(roomId),
          typeof workgroups.taskEvents === 'function'
            ? workgroups.taskEvents(roomId).catch(() => undefined)
            : undefined,
          typeof workgroups.workgroupSchedules === 'function'
            ? workgroups.workgroupSchedules().catch(() => undefined)
            : undefined,
        ])
        if (stopped) return
        setState({ phase: 'ready', ...answer, events: activity?.events ?? [], schedules: scheduled?.schedules ?? [] })
      } catch (error) {
        if (stopped) return
        // The reason is kept: "cannot reach the Hub" and "this room is gone" call for different
        // next steps, and a pane that showed one message for both would send the employee to the
        // wrong fix.
        setState({ phase: 'failed', message: error?.message ?? String(error) })
      }
      if (!stopped) timer = setTimeout(load, POLL_MS)
    }
    // The control the pane hands to `WorkgroupView`: it takes an operation and answers whether the
    // Hub accepted it. Panel view changes stay inside the copied conversation.
    view.current = async (value) => {
      if (value?.dissolve !== undefined) {
        try {
          await workgroups.dissolve(value.dissolve)
          // Reloaded rather than patched in place: the Hub is the authority on the room's state, and the
          // ended state must be what the pane shows from the next read on.
          await load()
          return true
        } catch (error) {
          setState(previous => ({ ...previous, message: error?.message ?? String(error) }))
          return false
        }
      }
      const requestedDecision = value?.decide
      if (requestedDecision !== undefined) {
        try {
          // The scope the owner confirmed travels as the fields the Host and the integration client
          // both name, so no layer renames or drops one of them on the way to the Hub. A rejection
          // carries only the version: it grants nothing, so there is nothing to scope.
          await workgroups.answerTask(requestedDecision.task.id, requestedDecision.decision, {
            ...(requestedDecision.task.version === undefined ? {} : { expectedVersion: requestedDecision.task.version }),
            ...(requestedDecision.scope ?? {}),
          })
          await load()
          return true
        } catch (error) {
          setState(previous => ({ ...previous, message: error?.message ?? String(error) }))
          return false
        }
      }
      const requestedReview = value?.review
      if (requestedReview !== undefined) {
        try {
          // A review is the owner's answer on a finished result. The version the card showed travels
          // with it, so a result that moved on (already kept or shared on another device) is refused
          // rather than decided twice; only `share` carries recipients.
          await workgroups.reviewTask(requestedReview.task.id, requestedReview.decision, {
            ...(requestedReview.task.version === undefined ? {} : { expectedVersion: requestedReview.task.version }),
            ...(requestedReview.payload ?? {}),
          })
          await load()
          return true
        } catch (error) {
          setState(previous => ({ ...previous, message: error?.message ?? String(error) }))
          return false
        }
      }
      const requestedCancel = value?.cancel
      if (requestedCancel !== undefined) {
        try {
          await workgroups.cancelTask(requestedCancel.id)
          await load()
          return true
        } catch (error) {
          setState(previous => ({ ...previous, message: error?.message ?? String(error) }))
          return false
        }
      }
      const message = value?.send
      if (message === undefined) return true
      try {
        // The reply travels as the id of the message being answered, which is what the Hub stores;
        // the quoted text the sender saw is never sent as if it were their own words. Mentions travel
        // as ids for the same reason: a name in the text is for reading, the id is what the Hub acts on.
        const sent = await workgroups.sendMessage(roomId, message, {
          ...(value.clientMessageId === undefined ? {} : { clientMessageId: value.clientMessageId }),
          ...(value.replyToMessageId === undefined ? {} : { replyToMessageId: value.replyToMessageId }),
          ...(Array.isArray(value.mentions) && value.mentions.length > 0 ? { mentions: value.mentions } : {}),
          ...(Array.isArray(value.attachments) && value.attachments.length > 0 ? { attachments: value.attachments } : {}),
        })
        // A Bot mention answers with the tasks it proposed. Merging them here is what makes the card
        // appear with the message instead of one poll later; the Hub stays the authority, and the
        // read below replaces these rows with its own answer.
        const proposed = Array.isArray(sent?.proposedTasks) ? sent.proposedTasks : []
        if (proposed.length > 0) {
          setState(previous => {
            const known = new Map((previous.tasks ?? []).map(task => [task.id, task]))
            for (const task of proposed) known.set(task.id, task)
            return { ...previous, tasks: [...known.values()] }
          })
        }
        await load()
        return true
      } catch (error) {
        setState(previous => ({ ...previous, message: error?.message ?? String(error) }))
        return false
      }
    }
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [roomId, workgroups])

  const run = value => view.current?.(value)
  const onSend = (text, reply, extra = {}) => view.current?.(withReply({ send: text, ...extra }, reply))
  // The file is uploaded before the message is sent, and only its id is attached: the message is then a
  // record of a file that already exists, so a failed send leaves an unreferenced artifact rather than a
  // message pointing at bytes that were never stored.
  const onAttach = async (file) => {
    const uploaded = await workgroups.uploadArtifact(roomId, { ...file, recipients: [] })
    return { artifactId: uploaded.artifact.id, fileName: uploaded.artifact.fileName }
  }
  // Older messages are fetched by the pane, which owns the Hub reads: the conversation owns where the
  // cursor is, and the pane owns what a read means.
  const loadEarlier = async (beforeSeq) => {
    const page = await workgroups.messagesBefore(roomId, beforeSeq, EARLIER_PAGE)
    if (!Array.isArray(page?.messages) || page.messages.length === 0) return { hasMore: false }
    setState((previous) => {
      const known = new Set((previous.messages ?? []).map(message => message.id ?? `seq:${message.roomSeq}`))
      // Prepended in Hub order and de-duplicated by message: a page that overlaps what is on screen
      // must not show a line twice.
      const older = page.messages.filter(message => !known.has(message.id ?? `seq:${message.roomSeq}`))
      return { ...previous, messages: [...older, ...(previous.messages ?? [])] }
    })
    return { hasMore: page.hasMore === true }
  }
  const onReact = async (messageId, emoji) => {
    const answer = await workgroups.addReaction(roomId, messageId, emoji)
    applyReactions(messageId, answer?.reactions)
  }
  const onUnreact = async (messageId, emoji) => {
    const answer = await workgroups.removeReaction(roomId, messageId, emoji)
    applyReactions(messageId, answer?.reactions)
  }
  /** Write one message's reaction set into the state, without disturbing the rest of the page. */
  const applyReactions = (messageId, reactions) => {
    setState((previous) => ({
      ...previous,
      messages: (previous.messages ?? []).map(message => (message.id === messageId
        ? { ...message, reactions: Array.isArray(reactions) ? reactions : [] }
        : message)),
    }))
  }
  const onRoomAction = async (operation, payload) => {
    let result
    switch (operation) {
      case 'renameRoom': result = await workgroups.renameRoom(roomId, payload); break
      case 'updateNotice': result = await workgroups.updateNotice(roomId, payload.notice); break
      case 'addBot': result = await workgroups.addBot(roomId, payload.botId); break
      case 'setBotVisibility': result = await workgroups.setBotVisibility(payload.botId, payload.visibility); break
      case 'inviteBot': result = await workgroups.inviteBot(roomId, payload); break
      case 'removeBot': result = await workgroups.removeBot(roomId, payload.ownerUserId, payload.botId); break
      case 'invite': result = await workgroups.invite(roomId, payload); break
      case 'setRole': result = await workgroups.setRole(roomId, payload.userId, payload.role); break
      case 'removeMember': result = await workgroups.removeMember(roomId, payload.userId); break
      case 'revokeInvitation': result = await workgroups.revokeInvitation(payload.invitationId); break
      case 'leaveRoom': result = await workgroups.leaveRoom(roomId); break
      default: throw new Error(t('Unknown workgroup action'))
    }
    if (operation !== 'leaveRoom') {
      const answer = await workgroups.openRoom(roomId)
      setState({ phase: 'ready', ...answer })
    }
    return result
  }
  const onDownload = async (entry) => {
    const file = await workgroups.downloadArtifact(entry.artifactId)
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.contentType }))
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = entry.fileName ?? entry.artifactId
      link.click()
    } finally { URL.revokeObjectURL(url) }
  }
  // An image attachment is fetched through the same authorized route as any other file; the object URL
  // is short-lived and revoked by the caller when it unmounts.
  const onImage = async (entry) => {
    const file = await workgroups.downloadArtifact(entry.artifactId)
    return URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.contentType }))
  }
  // Memory needs four writes and a search, not just the list the room read provides. A Host that
  // predates them has no `memoryCreate`, and advertising the panel anyway would give the reader a
  // form whose every submission throws. The adapter exists only when the writes do.
  const memory = typeof workgroups.memory === 'function' && typeof workgroups.memoryCreate === 'function'
    ? {
      list: () => workgroups.memory(roomId).then(answer => answer?.memories ?? []),
      search: query => workgroups.memorySearch(roomId, query).then(answer => answer?.memories ?? []),
      create: payload => workgroups.memoryCreate(roomId, payload),
      revise: (memoryId, payload) => workgroups.memoryRevise(memoryId, payload),
      remove: memoryId => workgroups.memoryDelete(memoryId),
    }
    : undefined
  const onDecision = (task, decision, scope) => view.current?.({
    decide: { task, decision, ...(scope === undefined ? {} : { scope }) },
  })
  const onReview = (task, decision, payload) => view.current?.({ review: { task, decision, payload } })
  const onCancel = task => view.current?.({ cancel: task })
  // The owner's own published Bots, for the approval form's target list. Room-visible Bots are a
  // different fact — a colleague's Bot is in the room because it is a member, not because this
  // owner may dispatch to it — so the form never reads the room roster for this.
  const loadOwnerBots = useMemo(
    () => (typeof workgroups?.directory === 'function'
      ? () => workgroups.directory({ ownerUserId: workgroups.identity?.userId })
      : undefined),
    [workgroups],
  )
  // `unknown` is not a fault to report: it is the state before the Host has answered, and the pane
  // shows the room it already has rather than a warning about a connection nobody has asked after.
  const status = hubStatusOf(hub)
  const copy = hubStatusCopy(status)

  return h('div', {
    className: 'bt-pane bt-wg-pane',
    style: { left: paneLeft },
    'data-wg-room': roomId ?? '',
    'data-wg-hub': status,
    // The pane replaces the conversation, so it carries the region marker the shell uses for the
    // conversation area; a screenshot check and a reader both need to know what is on screen.
    'data-conversation-region': 'workgroup',
  },
  state.message === undefined ? null : h('div', { role: 'alert', className: 'bt-danger' }, state.message),
  copy !== undefined
    // A `wg:` Session outlives the Hub that issued it, so "no Hub" is a state this pane must render
    // rather than a blank conversation: the room stays in the sidebar when work moves off network.
    // Each blocked status gets its own sentence because each has its own fix; telling someone whose
    // Hub is merely reconnecting to go configure one sends them after a setting that is already right.
    ? h('div', { className: 'bt-wg bt-wg-offline', 'data-wg-hub-state': status },
      h('div', { className: 'bt-wg-head' }, h('span', { className: 'bt-wg-name' }, t(copy.title))),
      h('div', { className: 'bt-wg-empty' }, t(copy.body)))
    : h(WorkgroupView, {
      room: state.room,
      members: state.members,
      bots: state.bots,
      messages: state.messages,
      tasks: state.tasks,
      events: state.events,
      schedules: state.schedules,
      onSchedule: typeof workgroups.scheduleWorkgroupMessage === 'function'
        ? payload => workgroups.scheduleWorkgroupMessage(roomId, payload)
        : undefined,
      onCancelSchedule: typeof workgroups.cancelWorkgroupSchedule === 'function'
        ? id => workgroups.cancelWorkgroupSchedule(id)
        : undefined,
      prefs: workgroups.workgroupPrefs?.(roomId),
      onFlag: patch => workgroups.setWorkgroupFlag?.(roomId, patch),
      memory,
      hubState: status,
      loadBotCandidates: typeof workgroups.botCandidates === 'function'
        ? () => workgroups.botCandidates(roomId)
        : undefined,
      selfUserId: workgroups.identity?.userId,
      identity: workgroups.identity,
      actions,
      run,
      loadOwnerBots,
      onSend,
      onAttach,
      onDownload,
      onImage,
      onRoomAction,
      onReact,
      onUnreact,
      onLoadEarlier: loadEarlier,
      onDecision,
      onReview,
      onCancel,
      // The owner's dissolve reaches the Hub through the same control the rest of this pane uses, so it
      // shares one error path and one reload. It does not touch the local room store: a workgroup is a
      // Hub room, and that store has never heard of it.
      onDissolve: value => view.current({ dissolve: value }),
      empty: state.phase === 'failed' ? state.message : undefined,
    }))
}
