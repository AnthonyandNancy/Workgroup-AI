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

import { createElement as h, useEffect, useRef, useState } from 'react'
import { usePaneLeft } from './overlay-hooks.js'
import { mainSessionId, mainWorkgroupSession, needsHomeFallback } from '../shared/workgroup-session.js'
import { roomIdOfSession, WorkgroupView } from './workgroup.js'
import { withReply } from './workgroup-reply.js'
import { hubStatusCopy, hubStatusOf } from './workgroup-status.js'
import { t } from './i18n.js'

/** How often the pane re-reads a room it is already showing, while the tab is visible. */
const POLL_MS = 4000

// Re-exported rather than reimplemented: the sidebar's view of the main Session and this pane's
// must agree, or the pane would render over a conversation the shell thinks it left, and the
// unknown-Session fallback would pull a workgroup away. One module owns both rules.
export { mainSessionId, mainWorkgroupSession, needsHomeFallback }

/**
 * The pane itself: nothing at all unless the main Session is a workgroup.
 *
 * @param props - the registered inject face; both sources render reactively through `hooks`.
 */
export function WorkgroupPane({ useSessions, useWorkgroups, useHub, actions }) {
  const sessionId = useSessions(mainWorkgroupSession)
  if (sessionId === undefined) return null
  return h(WorkgroupSurface, {
    sessionId,
    workgroups: useWorkgroups(value => value),
    hub: useHub?.(value => value),
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
export function WorkgroupSurface({ sessionId, workgroups, hub, actions }) {
  const roomId = roomIdOfSession(sessionId)
  const paneLeft = usePaneLeft()
  const [state, setState] = useState({ phase: 'loading' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const view = useRef(null)

  useEffect(() => {
    setSettingsOpen(false)
    setState({ phase: 'loading' })
    if (workgroups === undefined || roomId === undefined) return () => {}
    let stopped = false
    let timer
    const load = async () => {
      try {
        const answer = await workgroups.openRoom(roomId)
        if (stopped) return
        setState({ phase: 'ready', ...answer })
      } catch (error) {
        if (stopped) return
        // The reason is kept: "cannot reach the Hub" and "this room is gone" call for different
        // next steps, and a pane that showed one message for both would send the employee to the
        // wrong fix.
        setState({ phase: 'failed', message: error?.message ?? String(error) })
      }
      if (!stopped) timer = setTimeout(load, POLL_MS)
    }
    // The control the pane hands to `WorkgroupView`: it takes a value and answers whether the Hub
    // accepted it. Settings open as a view change, which is the same call the team's own group
    // settings make.
    view.current = async (value) => {
      if (value === null) { setSettingsOpen(true); return true }
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
      const message = value?.send
      if (message === undefined) return true
      try {
        // The reply travels as the id of the message being answered, which is what the Hub stores;
        // the quoted text the sender saw is never sent as if it were their own words. Mentions travel
        // as ids for the same reason: a name in the text is for reading, the id is what the Hub acts on.
        await workgroups.sendMessage(roomId, message, {
          ...(value.replyToMessageId === undefined ? {} : { replyToMessageId: value.replyToMessageId }),
          ...(Array.isArray(value.mentions) && value.mentions.length > 0 ? { mentions: value.mentions } : {}),
          ...(Array.isArray(value.attachments) && value.attachments.length > 0 ? { attachments: value.attachments } : {}),
        })
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
  const onDecision = (taskId, decision) => { void workgroups?.answerTask?.(taskId, decision).then(() => run(null)) }
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
      selfUserId: workgroups.identity?.userId,
      identity: workgroups.identity,
      actions,
      run,
      onSend,
      onAttach,
      onDecision,
      settingsOpen,
      onCloseSettings: () => setSettingsOpen(false),
      // The owner's dissolve reaches the Hub through the same control the rest of this pane uses, so it
      // shares one error path and one reload. It does not touch the local room store: a workgroup is a
      // Hub room, and that store has never heard of it.
      onDissolve: value => view.current({ dissolve: value }),
      empty: state.phase === 'failed' ? state.message : undefined,
    }))
}
