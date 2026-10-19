// The workgroup sidebar: the original team sidebar, copied so the workgroup rows can join the one
// list the shell allows `sidebar.workspaces` to have.
//
// The original `TeamSidebar` has no row slot, so a workgroup cannot be appended without owning the
// container. Everything above the workgroup additions is a copy of `sidebar.js`: the local Main Bot,
// Bots, local rooms, Agents, Agent Sessions, search/new/update controls, pin order, unread marks,
// selection, and rail/wide layouts must keep behaving exactly as they do there. Only non-business
// primitives (`BrandMark`, `BrandName`, `UpdateButton`) are imported from the original; the row
// components are copied rather than imported so this file can evolve independently.
//
// Workgroups are read from `useWorkgroupRoster`, never injected into `roster.rooms`: the local roster
// is the team's own state, and a Hub room placed there would be treated as a local group by every
// session/hosting/deletion path that reads it.
//
// The sidebar also owns the inbound invitation area and the create entry, because both belong where
// the member sees their workgroups. Invitation decisions call the injected actions only; the owner of
// the action updates the roster, and this file never reports an answer it did not receive.

import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { isMainOf } from './sources.js'
import { currentPart, previewOf, relativeShort } from './text.js'
import { PlusIcon, SearchIcon, PinMarkIcon, CloudDownloadIcon } from './icons.js'
import { botState, BotAvatar, RoomAvatar } from './mark.js'
import { WorkgroupAvatar } from './workgroup-ui/thread.js'
import { reducedMotion } from './activity-row.js'
import { Shimmer, workPhrase } from './cells.js'
import { springEasing } from './motion.js'
import { hostText, t } from './i18n.js'
import { showsDshRow } from './dsh-offer.js'
import { isWorkgroupSession, workgroupSessionId } from '../shared/workgroup-session.js'
import { BrandMark, BrandName } from './sidebar.js'
import { hubCreateHint, hubStatusOf } from './workgroup-status.js'
import { emptyWorkgroupRoster, sortWorkgroupRows, visibleWorkgroupRows } from './workgroup-roster.js'

// -------------------------------------------------------------------------
// The original sidebar's local behaviour, copied verbatim.

// Manual "Mark as Unread" lasts until the conversation is opened again.
function useMarkedUnread(id, active, marked, actions) {
  useEffect(() => {
    if (active && marked) actions.clearUnread(id)
  }, [active, marked])
}

const PinMark = () => h('span', { className: 'bt-pin', 'aria-hidden': true }, h(PinMarkIcon))

// Whether an approval waits for the user: for a Bot, in any of its Sessions; for a group,
// from any of its members there.
const useApproval = (useWork, match) => (useWork ? useWork(work => (work.approvals ?? []).some(match)) : false)

// Work running in group Sessions, as "botId|tool" keys so a row redraws only when it
// changes: the groups one Bot works in, or the members at work in one group.
// Picked as text, so a row redraws only when what it shows changes.
const useGroupWork = (useWork, pick) => (useWork ? useWork(work => JSON.stringify(pick(work.rooms ?? {}))) : '[]')
const workKeys = text => JSON.parse(text)
const doingOf = ({ tool, said, note, target, switching }) => ({ tool, said, note, target, switching })
const workLine = (lead, doing, more) => h(Shimmer, null, `${lead} · ${workPhrase(doing)}…${more > 0 ? ` +${more}` : ''}`)

function BotRow({ bot, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useActivity, useWork, wide, marked }) {
  const id = bot.id
  const part = currentPart(bot)
  const preview = useSessions(list => previewOf(list, part, roster.exchangeTurns[part]))
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const active = useSessionRetainInfo(part, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(part)?.completionUnread === true || map.get(part)?.pendingInteraction !== undefined) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const main = isMainOf(roster, id)
  const tile = roster.mainBotId === id
  const approval = useApproval(useWork, entry => entry.botId === id)
  const alert = roster.questions?.[part] !== undefined || approval
  const doing = useActivity(map => map[id])
  // Work in a group runs in a Session of its own, so the Bot's chat stays idle meanwhile.
  const groups = workKeys(useGroupWork(useWork, rooms => Object.entries(rooms).flatMap(([roomId, entries]) => entries.filter(entry => entry.botId === id).map(entry => ({ id: roomId, ...doingOf(entry) })))))
  const away = !running && groups.length > 0
  const state = botState(running || away, doing, alert)
  const awayLine = away ? workLine(roster.roomsById[groups[0].id]?.name ?? t('a group chat'), groups[0], groups.length - 1) : null
  if (bot.hidden && !active && !main) return null
  const onContextMenu = (event) => {
    event.preventDefault()
    actions.openMenu({ kind: 'bot', id, x: event.clientX, y: event.clientY })
  }
  const pinned = bot.pinned === true && !tile
  const label = [bot.name, main ? t('Main Bot') : '', pinned ? t('Pinned') : '', running || away ? t('Working') : '', approval ? t('Waiting for your approval') : alert ? t('Waiting for your answer') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  if (tile && wide) {
    return h('div', { className: 'bt-tile-wrap' }, h('button', {
      type: 'button', className: 'bt-tile', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-bot-id': id, title: preview || bot.name, onClick: () => actions.openSession(id), onContextMenu,
    },
    h(BotAvatar, { bot, size: 60, state, main: true }),
    h('span', { className: 'bt-tile-name' }, bot.name),
    bot.role ? h('span', { className: 'bt-chip' }, bot.role) : null))
  }
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-bot-id': id, title: wide ? undefined : bot.name, onClick: () => actions.openSession(id), onContextMenu,
  },
  h(BotAvatar, { bot, size: 36, state, main }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, bot.name), pinned ? h(PinMark) : null),
    awayLine ? h('span', { className: 'bt-row-preview' }, awayLine) : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null)
}

function RoomRow({ room, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useWork, wide, marked }) {
  const id = room.id
  const fallback = useSessions(list => previewOf(list, id))
  const preview = room.preview?.replace(/\s+/g, ' ').trim() || fallback
  const active = useSessionRetainInfo(id, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(id)?.completionUnread === true) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const approval = useApproval(useWork, entry => entry.roomId === id)
  const members = workKeys(useGroupWork(useWork, rooms => (rooms[id] ?? []).map(entry => ({ id: entry.botId, ...doingOf(entry) }))))
  const first = roster.byId[members[0]?.id]
  const workingLine = first ? workLine(first.name, members[0], members.length - 1) : null
  if (room.hidden && !active) return null
  const pinned = room.pinned === true
  const label = [room.name, pinned ? t('Pinned') : '', members.length > 0 ? t('Working') : '', approval ? t('Waiting for your approval') : ''].filter(Boolean).join(', ')
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-room-id': id, onClick: () => actions.openSession(id),
    onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'room', id, x: event.clientX, y: event.clientY }) },
  },
  h(RoomAvatar, { room, roster, size: 36 }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, room.name), pinned ? h(PinMark) : null),
    workingLine ? h('span', { className: 'bt-row-preview' }, workingLine) : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && approval && !active ? h('span', { className: 'bt-unread bt-unread-wait', 'aria-hidden': true })
    : wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null)
}

// One expanded DSH Agent Session row: title, relative stamp, rename field, and a
// context menu for rename/archive.
function AgentSessionRow({ session, agent, actions, renaming, index }) {
  const input = useRef(null)
  useLayoutEffect(() => {
    if (!renaming) return
    input.current?.focus()
    input.current?.select()
  }, [renaming])
  if (renaming) {
    const commit = (keep) => {
      const value = input.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === session.title) { actions.endAgentRename(); return }
      // The editor closes only after the rename landed; a failure keeps it open.
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, session.id, value)
          actions.endAgentRename()
        } catch (error) {
          actions.reportError(error, 'agent-rename')
        }
      })()
    }
    return h('div', { className: 'bt-agent-sub-row bt-agent-edit', style: { '--i': index } },
      h('input', {
        ref: input, defaultValue: session.title, 'aria-label': t('Rename'),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') commit(true)
          else if (event.key === 'Escape') commit(false)
        },
        onBlur: () => commit(true),
      }))
  }
  return h('button', {
    type: 'button', className: 'bt-agent-sub-row', 'aria-current': session.active ? 'page' : undefined, style: { '--i': index },
    onClick: () => actions.openAgentSession(session.id),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      actions.openMenu({ kind: 'agent-session', id: session.id, agentId: agent.id, x: event.clientX, y: event.clientY })
    },
  },
  h('span', { className: 'bt-agent-sub-title' }, session.title),
  h('span', { className: 'bt-agent-sub-time' }, session.at > 0 ? relativeShort(session.at) : ''))
}

// The DSH Agent row: a plain dsh Session list lives in the Bot workspace, so it
// sits among the Bots with the harness's own whale mark.
function AgentRow({ agent, actions, useSessions, useSessionStatus, useUi, wide, marked }) {
  const info = useSessions(list => JSON.stringify(agent.sessions.map((id) => {
    const row = list.byId[id]
    return {
      id,
      // A blank Session's title is the workspace folder name; show the label instead.
      title: row?.blank === true ? '' : (row?.displayTitle ?? row?.title ?? ''),
      at: row?.updatedAt ?? 0,
      running: row?.running === true,
      active: (row?.retainedBy?.mainView ?? 0) > 0,
    }
  }).sort((a, b) => b.at - a.at)))
  const statusInfo = useSessionStatus(map => JSON.stringify(agent.sessions.map(id => ({
    id, running: map.get(id)?.running === true, unread: map.get(id)?.completionUnread === true,
  }))))
  const statuses = Object.fromEntries(JSON.parse(statusInfo).map(entry => [entry.id, entry]))
  const sessions = JSON.parse(info).map(session => ({
    ...session,
    running: statuses[session.id]?.running ?? session.running,
    unread: statuses[session.id]?.unread ?? false,
    title: session.title === '' ? t('New session') : session.title,
  }))
  const renaming = useUi(value => value.renameAgent)
  const active = sessions.some(session => session.active)
  const running = sessions.some(session => session.running)
  const unread = sessions.some(session => session.unread) || (marked && !active)
  useMarkedUnread(agent.id, active, marked, actions)
  const preview = sessions[0]?.title ?? t('New session')
  const label = ['DSH Agent', running ? t('Working') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  const open = active && wide
  return h('div', { className: 'bt-agent' },
    h('button', {
      type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-agent-id': agent.id, title: wide ? undefined : 'DSH Agent', onClick: () => actions.openAgent(agent.id),
      onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'agent', id: agent.id, x: event.clientX, y: event.clientY }) },
    },
    h('span', { className: `bt-agent-ava${running ? ' bt-run' : ''}` }, h(FishLogo, { size: 22 })),
    wide ? h('span', { className: 'bt-row-body' },
      h('span', { className: 'bt-row-name' }, 'DSH Agent'),
      preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
    wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null),
    h('div', { className: 'bt-agent-sub', 'data-open': open || undefined },
      h('div', { className: 'bt-agent-sub-in' },
        h('button', { type: 'button', className: 'bt-agent-sub-row bt-agent-new', style: { '--i': 0 }, onClick: () => { void actions.newAgentSession(agent.id).catch(error => actions.reportError(error, 'agent-session')) } },
          h(PlusIcon), h('span', { className: 'bt-agent-sub-title' }, t('New session'))),
        sessions.map((session, index) => h(AgentSessionRow, {
          key: session.id, session, agent, actions, index: index + 1,
          renaming: renaming === session.id,
        })))))
}

// List rows glide to new places on a spring.
const GLIDE = springEasing(1000, 63)

function useListGlide(listRef, layout, key) {
  const tops = useRef({ layout, map: new Map() })
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const next = new Map()
    const still = reducedMotion() || tops.current.layout !== layout
    for (const row of list.querySelectorAll('[data-bot-id],[data-room-id],[data-agent-id],[data-workgroup-id]')) {
      const id = row.dataset.botId ?? row.dataset.roomId ?? row.dataset.agentId
        ?? (row.dataset.workgroupId === undefined ? undefined : `wg:${row.dataset.workgroupId}`)
      if (id === undefined) continue
      // offsetTop ignores transforms, so a glide in flight does not skew the next one.
      const top = row.offsetTop
      next.set(id, top)
      const before = tops.current.map.get(id)
      if (!still && before !== undefined && Math.abs(before - top) > 0.5) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], GLIDE)
      }
    }
    tops.current = { layout, map: next }
  }, [layout, key])
}

// Opens the Main Bot whenever the main view holds no Bot conversation, the way
// The view always lands on a Bot rather than an empty New Session page.
// When a Bot's chat moves on to a fresh part, the shell clears the view of the part
// it archived; the chat then goes on in the Bot's current part instead.
function useLandOnMainBot(roster, useSessions, actions) {
  const mainView = useSessions((list) => {
    const row = Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
    return row ? `${row.id}|${row.blank ? 1 : 0}` : ''
  })
  const lastBot = useRef(null)
  useEffect(() => {
    if (!roster.ready || !roster.mainBotId) return undefined
    const [id, blank] = mainView.split('|')
    const bot = id === '' ? undefined : roster.byId[id]
    if (bot !== undefined) {
      lastBot.current = { botId: bot.id, sessionId: id }
      if (currentPart(bot) !== id) actions.landOn(bot.id)
      return undefined
    }
    // A DSH Agent Session, blank or not, is a real destination: it stays.
    if (id !== '' && (roster.roomsById[id] || (actions.isAgentSession?.(id) ?? roster.agentOf[id] !== undefined) || blank !== '1')) {
      lastBot.current = null
      return undefined
    }
    // A workgroup Session is a real destination too, and it is blank when first opened. The roster
    // has no row for one — the Hub owns the room — so the timer below would otherwise pull the user
    // back to the Main Bot moments after they entered their workgroup. The pane keys off this id.
    if (isWorkgroupSession(id)) {
      lastBot.current = null
      return undefined
    }
    const last = lastBot.current
    const timer = setTimeout(() => actions.landOn(roster.mainBotId, last), last ? 0 : 400)
    return () => clearTimeout(timer)
  }, [mainView, roster])
}

// The update button at the sidebar's top right: a cloud while a newer DS Bot —
// or a newer verified DSH — is available, then the install's progress and
// result. Its card has one row each for the bot and DSH, with their versions,
// the release notes link, and each row's own button.
function UpdateButton({ useUpdate, actions }) {
  const update = useUpdate(value => value)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const [error, setError] = useState('')
  const [dshError, setDshError] = useState('')
  const button = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-update-pop') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const phase = update?.phase ?? 'idle'
  const dsh = update?.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  const dshRow = showsDshRow(dsh, update?.app)
  if (!update?.available && !dshRow && phase === 'idle' && dshPhase === 'idle') return null
  const cloudPhase = phase === 'installing' || dshPhase === 'installing' ? 'installing' : phase !== 'idle' ? phase : dshPhase
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 })
    setOpen(value => !value)
  }
  const start = () => {
    setError('')
    void actions.installUpdate().catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const startDsh = () => {
    setDshError('')
    void actions.installDshUpdate().catch(failure => setDshError(hostText(failure?.message ?? String(failure))))
  }
  const label = phase === 'installing' ? t('Updating DS Bot…')
    : dshPhase === 'installing' ? t('Updating DSH…')
      : phase === 'installed' ? t('DS Bot {version} is installed. Restart DSH to use it.', { version: update.installed ?? update.latest })
        : dshPhase === 'installed' ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
          : update?.available ? t('DS Bot {version} is available', { version: update.latest })
            : t('DSH {version} is available', { version: dsh?.verified })
  const message = error || (phase === 'failed' ? update.error : '')
  const dshMessage = dshError || (dshPhase === 'failed' ? dsh?.error : '')
  const dshText = dshPhase === 'installed'
    ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
    : dsh?.available === false && dsh?.blockedBy
      ? t('Update DS Bot {version} first.', { version: dsh.blockedBy })
      : t('You have {version}.', { version: dsh?.current })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-round bt-update', 'data-phase': cloudPhase, 'aria-label': label, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle,
    }, h(CloudDownloadIcon, { done: phase === 'installed' }), phase === 'failed' || dshPhase === 'failed' ? h('span', { className: 'bt-update-dot', 'aria-hidden': true }) : null),
    open && box ? createPortal(h('div', { className: 'bt-update-pop', role: 'dialog', 'aria-label': update?.available || phase !== 'idle' ? t('DS Bot update') : t('DSH update'), style: box },
      update?.available || phase !== 'idle' ? h(Fragment, null,
        h('div', { className: 'bt-update-title' }, phase === 'installed' ? t('Update installed') : t('DS Bot {version}', { version: update.latest })),
        h('div', { className: 'bt-update-text' }, phase === 'installed'
          ? t('Restart DSH to start using DS Bot {version}.', { version: update.installed ?? update.latest })
          : t('You have {version}.', { version: update.current })),
        message ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: message })) : null,
        h('div', { className: 'bt-update-actions' },
          update.notesUrl ? h('a', { className: 'bt-update-notes', href: update.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, t("What's new")) : null,
          phase === 'installed' ? null : h('button', {
            type: 'button', className: 'bt-update-go', disabled: phase === 'installing', onClick: start,
          }, phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update')))) : null,
      dshRow ? h('div', { className: 'bt-update-dsh' },
        h('div', { className: 'bt-update-title' }, t('DSH {version}', { version: dsh.verified })),
        h('div', { className: 'bt-update-text' }, dshText),
        dshMessage ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: dshMessage })) : null,
        h('div', { className: 'bt-update-actions' },
          dsh.kind === 'app' ? (dsh.available
            ? h('button', { type: 'button', className: 'bt-update-go', onClick: () => void actions.openAppUpdates(dsh.verified).catch(() => {}) }, t('Open updates'))
            : null)
            : !dsh.available && dshPhase === 'idle' ? null
              : dshPhase === 'installed' ? null
                : h('button', {
                  type: 'button', className: 'bt-update-go', disabled: dshPhase === 'installing', onClick: startDsh,
                }, dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update')))) : null), document.body) : null)
}

// -------------------------------------------------------------------------
// Workgroup row shape and the additions around the local list.

const stampOf = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

const countOf = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

const invitationList = value => (Array.isArray(value)
  ? value
  : Array.isArray(value?.invitations) ? value.invitations : [])

const HUB_LABEL = {
  live: 'Hub online',
  reconnecting: 'Hub reconnecting',
  offline: 'Hub offline',
  absent: 'Hub is not configured',
  'signed-out': 'Configured, signed out',
  refused: 'Hub refused this device',
  unknown: 'Hub status unknown',
}

// `hubStatusOf` answers what the member can do. The row also has to say "reconnecting" rather than
// collapsing it into "offline", because one repairs itself and the other waits for a person.
function hubStateOf(hub) {
  const status = hubStatusOf(hub)
  return status === 'offline' && hub?.state === 'reconnecting' ? 'reconnecting' : status
}

const hubLabel = state => t(HUB_LABEL[state] ?? 'Hub status unknown')

const roleLabel = (role) => {
  if (role === 'owner') return t('Owner')
  if (role === 'admin') return t('Admin')
  return t('Member')
}

function WorkgroupRow({ row, active, hubState, wide, onOpen, onMenu }) {
  const id = row.id
  // The room list carries counts, not members, and reading each room to draw its faces would turn
  // one list into one request per row. The row therefore seats the same number of faces the room
  // reports: the shape of the original group avatar without inventing who is in it.
  const placeholderPeople = Array.from({ length: countOf(row.memberCount) }, (_, index) => ({ userId: `member-${index}`, displayName: '' }))
  const placeholderBots = Array.from({ length: countOf(row.botCount) }, (_, index) => ({ ownerUserId: 'room', botId: `${id}:${index}` }))
  const pinned = row.pinned === true
  // The badge shows the combined marker: a room the member manually marked unread looks unread even
  // when nothing new arrived, which is what "mark as unread" promises.
  const unread = countOf(row.badge ?? row.unread)
  const pending = countOf(row.pendingApprovalCount)
  const preview = String(row.lastMessagePreview ?? '').replace(/\s+/g, ' ').trim()
  // An empty workgroup still needs a stamp; its creation time is the only activity it has.
  const at = stampOf(row.lastMessageAt ?? row.createdAt)
  const stamp = preview || (at > 0 ? relativeShort(at) : '')
  const dissolved = row.dissolvedAt !== undefined && row.dissolvedAt !== null
  const members = countOf(row.memberCount)
  const bots = countOf(row.botCount)
  const label = [
    row.name,
    t('Workgroup'),
    t('{count} members', { count: members }),
    t('{count} Bots', { count: bots }),
    hubLabel(hubState),
    pinned ? t('Pinned') : '',
    unread > 0 ? t('Unread messages: {count}', { count: unread }) : '',
    pending > 0 ? t('Pending approvals: {count}', { count: pending }) : '',
    dissolved ? t('Dissolved') : '',
  ].filter(Boolean).join(', ')
  return h('button', {
    type: 'button',
    className: 'bt-row bt-wg-row',
    'aria-label': label,
    'aria-current': active ? 'page' : undefined,
    'data-workgroup-id': id,
    'data-wg-hub': hubState,
    'data-wg-unread': unread,
    'data-wg-approvals': pending,
    title: wide ? undefined : row.name,
    onClick: () => onOpen(id),
    onContextMenu: (event) => { event.preventDefault(); onMenu(row, event.clientX, event.clientY) },
  },
  h('span', { className: 'bt-row-ava bt-wg-row-ava' },
    h(WorkgroupAvatar, { members: placeholderPeople, bots: placeholderBots, size: 36 }),
    h('span', { className: 'bt-wg-hub-dot', 'data-hub': hubState, 'aria-hidden': true })),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' },
      h('span', { className: 'bt-row-title' }, row.name),
      h('span', { className: 'bt-wg-row-badge' }, t('Workgroup')),
      dissolved ? h('span', { className: 'bt-wg-row-badge bt-wg-row-ended' }, t('Dissolved')) : null,
      pinned ? h(PinMark) : null),
    stamp ? h('span', { className: 'bt-row-preview' }, stamp) : null,
    h('span', { className: 'bt-wg-row-meta' },
      h('span', null, t('{count} members', { count: members })),
      h('span', { className: 'bt-wg-row-sep', 'aria-hidden': true }, '·'),
      h('span', null, t('{count} Bots', { count: bots })),
      h('span', { className: 'bt-wg-row-sep', 'aria-hidden': true }, '·'),
      h('span', { className: 'bt-wg-row-hub', 'data-hub': hubState }, hubLabel(hubState)))) : null,
  wide && pending > 0
    ? h('span', {
      className: 'bt-wg-row-approval',
      title: t('Pending approvals: {count}', { count: pending }),
      'aria-label': t('Pending approvals: {count}', { count: pending }),
    }, pending > 99 ? '99+' : String(pending))
    : null,
  wide && unread > 0
    ? h('span', {
      className: 'bt-wg-row-unread',
      title: t('Unread messages: {count}', { count: unread }),
      'aria-label': t('Unread messages: {count}', { count: unread }),
    }, unread > 99 ? '99+' : String(unread))
    : null)
}

function WorkgroupMenu({ menu, actions, onClose }) {
  useEffect(() => {
    if (menu === null) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && event.target.closest('[data-workgroup-menu]')) return
      onClose()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [menu, onClose])
  if (menu === null) return null
  const run = (patch) => {
    try {
      const answer = actions.setWorkgroupFlag?.(menu.row.id, patch)
      if (answer?.catch !== undefined) answer.catch(error => actions.reportError?.(error, 'workgroup-sidebar'))
    } catch (error) {
      actions.reportError?.(error, 'workgroup-sidebar')
    }
    onClose()
  }
  // One action that is not a preference: it reaches the Hub or opens a surface, so it reports its own
  // failure instead of writing a flag.
  const call = (label, invoke, options = {}) => h('button', {
    type: 'button',
    role: 'menuitem',
    className: options.danger === true ? 'bt-danger' : undefined,
    'data-wg-menu-action': options.action,
    onClick: () => {
      onClose()
      try {
        const answer = invoke()
        if (answer?.catch !== undefined) answer.catch(error => actions.reportError?.(error, 'workgroup-sidebar'))
      } catch (error) {
        actions.reportError?.(error, 'workgroup-sidebar')
      }
    },
  }, h('span', { className: 'bt-menu-label' }, label))
  // The same seven rows the original group's menu carries, in the same order and grouping: pin,
  // unread, then the two settings entries, then the id, then hide and the destructive last row.
  // "Delete group" becomes "Dissolve workgroup": a workgroup is ended by state, and its history stays
  // readable, which a delete would not convey.
  const dissolved = menu.row.dissolvedAt !== undefined && menu.row.dissolvedAt !== null
  const mayDissolve = menu.row.myRole === 'owner' && !dissolved
  return createPortal(h('div', {
    className: 'bt-menu bt-wg-menu', role: 'menu', 'aria-label': menu.row.name,
    'data-workgroup-menu': menu.row.id, style: { left: menu.x, top: menu.y },
  },
  h('button', { type: 'button', role: 'menuitem', 'data-wg-menu-action': 'pin', onClick: () => run({ pinned: menu.row.pinned !== true }) },
    h('span', { className: 'bt-menu-label' }, menu.row.pinned === true ? t('Unpin') : t('Pin to top'))),
  h('div', { className: 'bt-menu-sep', role: 'separator' }),
  call(t('Mark as unread'), () => actions.markWorkgroupUnread?.(menu.row.id), { action: 'unread' }),
  call(t('Group settings'), () => actions.openSettings?.('groups', menu.row.id), { action: 'settings' }),
  call(t('Rename group'), () => actions.renameWorkgroup?.(menu.row.id), { action: 'rename' }),
  call(t('Copy conversation ID'), () => navigator.clipboard?.writeText?.(menu.row.id), { action: 'copy-id' }),
  h('div', { className: 'bt-menu-sep', role: 'separator' }),
  h('button', { type: 'button', role: 'menuitem', 'data-wg-menu-action': 'hide', onClick: () => run({ hidden: true }) },
    h('span', { className: 'bt-menu-label' }, t('Hide from sidebar'))),
  mayDissolve
    ? call(t('Dissolve workgroup'), () => actions.dissolveWorkgroup?.(menu.row.id), { action: 'dissolve', danger: true })
    : null), document.body)
}

function WorkgroupSectionHead({ hubState, hub, actions, wide }) {
  const [error, setError] = useState('')
  const action = actions.openWorkgroupCreate
  const hintKey = typeof action === 'function' ? hubCreateHint(hubState, hub) : undefined
  const hint = typeof action === 'function'
    ? (hintKey === undefined ? undefined : t(hintKey))
    : t('Workgroup creation is not available in this build.')
  const enabled = hubState === 'live' && typeof action === 'function'
  const run = () => {
    setError('')
    try {
      const answer = action()
      if (answer?.catch !== undefined) {
        answer.catch((failure) => {
          setError(t('Could not create a workgroup: {reason}', { reason: hostText(failure?.message ?? String(failure)) }))
          actions.reportError?.(failure, 'workgroup-sidebar')
        })
      }
    } catch (failure) {
      setError(t('Could not create a workgroup: {reason}', { reason: hostText(failure?.message ?? String(failure)) }))
      actions.reportError?.(failure, 'workgroup-sidebar')
    }
  }
  return h(Fragment, null,
    h('div', { className: 'bt-wg-side-head' },
      wide ? h('span', { className: 'bt-wg-side-title' }, t('Workgroups')) : null,
      h('button', {
        type: 'button', className: 'bt-wg-create', disabled: !enabled,
        'data-wg-create': enabled ? 'ready' : 'blocked', 'data-wg-create-state': hubState,
        'aria-label': t('Create workgroup chat'), title: enabled ? t('Create workgroup chat') : hint,
        onClick: enabled ? run : undefined,
      }, h(PlusIcon))),
    wide && !enabled && hint ? h('div', { className: 'bt-wg-create-hint', role: 'status', 'data-wg-create-hint': hubState }, hint) : null,
    error ? h('div', { className: 'bt-wg-create-error bt-danger', role: 'alert' }, error) : null)
}

function InvitationPanel({ roster, actions, wide }) {
  const human = invitationList(roster.invitations)
  const bot = invitationList(roster.botInvitations)
  const total = human.length + bot.length
  const [pending, setPending] = useState(null)
  const [errors, setErrors] = useState({})
  if (total === 0) return null

  const answer = async (kind, invitation, decision) => {
    const key = `${kind}:${invitation.id}`
    const action = kind === 'human' ? actions.answerWorkgroupInvitation : actions.answerWorkgroupBotInvitation
    setPending({ key, decision })
    setErrors((current) => {
      if (current[key] === undefined) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    try {
      if (typeof action !== 'function') throw new Error(t('Workgroup invitations are not available in this build.'))
      await action(invitation.id, decision)
      setPending(null)
    } catch (failure) {
      setPending(null)
      setErrors(current => ({
        ...current,
        [key]: t('The invitation could not be answered: {reason}', { reason: hostText(failure?.message ?? String(failure)) }),
      }))
    }
  }

  const card = (kind, invitation) => {
    const key = `${kind}:${invitation.id}`
    const humanInvite = kind === 'human'
    const who = humanInvite
      ? invitation.inviterDisplayName ?? t('Unknown user')
      : invitation.botDisplayName ?? t('Unknown Bot')
    const role = humanInvite ? roleLabel(invitation.role) : t('Bot')
    const room = invitation.roomName ?? t('Unknown workgroup')
    const busy = pending?.key === key
    return h('div', {
      key, className: 'bt-wg-invite', 'data-wg-invitation': kind, 'data-invitation-id': invitation.id,
    },
    h('div', { className: 'bt-wg-invite-head' },
      h('span', { className: 'bt-wg-invite-room' }, room),
      h('span', { className: 'bt-wg-invite-role' }, role)),
    h('div', { className: 'bt-wg-invite-who' }, humanInvite
      ? t('{name} invited you', { name: who })
      : t('{name} was invited to this workgroup', { name: who })),
    h('div', { className: 'bt-wg-invite-actions' },
      h('button', {
        type: 'button', className: 'bt-wg-invite-accept', disabled: busy,
        'data-wg-answer': 'accept', onClick: () => { void answer(kind, invitation, 'accept') },
      }, busy && pending.decision === 'accept' ? t('Accepting…') : t('Accept')),
      h('button', {
        type: 'button', className: 'bt-wg-invite-decline', disabled: busy,
        'data-wg-answer': 'decline', onClick: () => { void answer(kind, invitation, 'decline') },
      }, busy && pending.decision === 'decline' ? t('Declining…') : t('Decline'))),
    errors[key] ? h('div', {
      className: 'bt-wg-invite-error bt-danger', role: 'alert', 'data-wg-invite-error': key,
    }, errors[key]) : null)
  }

  if (!wide) {
    const names = [...human.map(entry => entry.roomName), ...bot.map(entry => entry.roomName)].filter(Boolean)
    return h('div', {
      className: 'bt-wg-invites-rail', 'data-wg-invites': total,
      role: 'status', title: names.join(', '),
      'aria-label': t('{count} invitations', { count: total }),
    }, h('span', { className: 'bt-wg-invite-badge' }, String(total)))
  }

  return h('div', { className: 'bt-wg-invites', 'data-wg-invites': total },
    h('div', { className: 'bt-wg-invites-head' },
      h('span', { className: 'bt-wg-invites-title' }, t('Invitations')),
      h('span', { className: 'bt-wg-invites-count' }, String(total))),
    human.map(invitation => card('human', invitation)),
    bot.map(invitation => card('bot', invitation)))
}

// -------------------------------------------------------------------------
// The copied container.

export function WorkgroupTeamSidebar(props) {
  const { wide, useRoster, useUi, useSessions, actions } = props
  const listRef = useRef(null)
  const roster = useRoster(value => value)
  const workgroupRoster = props.useWorkgroupRoster(value => value) ?? emptyWorkgroupRoster()
  const hub = props.useHub(value => value)
  // The adapter is read for the no-Hub fallback; `useHub` is the live connection view.
  const workgroups = props.useWorkgroups(value => value)
  const markedUnread = useUi(value => value.unread)
  props.useRegistry(value => value)
  const updated = useSessions((list) => {
    const stamps = {}
    for (const id of list.ids) stamps[id] = list.byId[id]?.updatedAt ?? 0
    return JSON.stringify(stamps)
  })
  const workgroupRows = useMemo(
    () => visibleWorkgroupRows(sortWorkgroupRows(Array.isArray(workgroupRoster.rooms) ? workgroupRoster.rooms : [])),
    [workgroupRoster.rooms],
  )
  const order = useMemo(() => {
    const stamps = JSON.parse(updated)
    const entries = [
      ...roster.bots.filter(bot => bot.id !== roster.mainBotId).map(bot => ({ kind: 'bot', item: bot, at: stamps[currentPart(bot)] ?? bot.createdAt })),
      ...roster.rooms.map(room => ({ kind: 'room', item: room, at: stamps[room.id] ?? room.createdAt })),
      // The Agent sorts by its most recent Session, falling back to when it was added.
      ...(roster.agents ?? []).map(agent => ({ kind: 'agent', item: agent, at: Math.max(0, ...agent.sessions.map(id => stamps[id] ?? 0)) || agent.createdAt })),
      ...workgroupRows.map(row => ({ kind: 'workgroup', item: row, at: stampOf(row.lastActivityAt) })),
    ]
    return entries.sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)
  }, [roster, updated, workgroupRows])
  const main = roster.byId[roster.mainBotId]
  useListGlide(listRef, wide, order.map(entry => (entry.kind === 'workgroup' ? `wg:${entry.item.id}` : entry.item.id)).join(','))
  useLandOnMainBot(roster, useSessions, actions)
  const activeSession = useSessions((list) => {
    const row = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
    return row?.id ?? ''
  })
  const [menu, setMenu] = useState(null)
  const closeMenu = useMemo(() => () => setMenu(null), [])
  const hubState = hubStateOf(hub)
  // `useHub` is always injected, but a Hub view that has not answered yet must not be mistaken
  // for a configured Hub while the adapter's own availability is the only fact present.
  const createHubState = hub === undefined && workgroups?.available === true ? 'live' : hubState
  const rowProps = { roster, actions, useSessions, useUi, useSessionStatus: props.useSessionStatus, useSessionRetainInfo: props.useSessionRetainInfo, useActivity: props.useActivity, useWork: props.useWork, wide }
  // Typing while the sidebar has focus starts a search.
  const typeToSearch = (event) => {
    if (event.defaultPrevented || event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) return
    event.preventDefault()
    actions.openPalette(event.key)
  }
  const openWorkgroup = (roomId) => {
    if (typeof actions.openWorkgroup !== 'function') return
    try {
      const answer = actions.openWorkgroup(roomId)
      if (answer?.catch !== undefined) answer.catch(error => actions.reportError?.(error, 'workgroup-sidebar'))
    } catch (error) {
      actions.reportError?.(error, 'workgroup-sidebar')
    }
  }
  const openMenu = (row, x, y) => {
    if (typeof actions.setWorkgroupFlag !== 'function') return
    setMenu({ row, x, y })
  }
  return h(Fragment, null,
    h('div', { className: wide ? 'bt-side' : 'bt-side bt-rail', onKeyDown: typeToSearch },
      wide ? h('div', { className: 'bt-side-top' },
        h('span', { className: 'bt-brand' }, h(BrandMark, { size: 22 }), h(BrandName)),
        h(UpdateButton, { useUpdate: props.useUpdate, actions }),
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon)))
        : h(Fragment, null,
          h(UpdateButton, { useUpdate: props.useUpdate, actions }),
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon))),
      wide && roster.readOnly ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)) : null,
      h(WorkgroupSectionHead, { hubState: createHubState, hub, actions, wide }),
      h(InvitationPanel, { roster: workgroupRoster, actions, wide }),
      workgroupRoster.phase === 'failed' && workgroupRoster.error
        ? h('div', { className: 'bt-wg-roster-error', role: 'status', 'data-wg-roster-error': workgroupRoster.phase },
          t('Workgroups could not be refreshed: {reason}', { reason: hostText(workgroupRoster.error) }))
        : null,
      h('div', { ref: listRef, className: 'bt-list', role: 'region', 'aria-label': t('Bot list') },
        main ? h(BotRow, { ...rowProps, bot: main, marked: markedUnread[main.id] === true }) : roster.ready ? null : h('div', { className: 'bt-hint' }, t('Setting up your Main Bot…')),
        order.map(entry => {
          if (entry.kind === 'workgroup') {
            return h(WorkgroupRow, {
              key: `wg:${entry.item.id}`,
              row: entry.item,
              active: activeSession === workgroupSessionId(entry.item.id),
              hubState,
              wide,
              onOpen: openWorkgroup,
              onMenu: openMenu,
            })
          }
          return entry.kind === 'bot'
            ? h(BotRow, { key: entry.item.id, ...rowProps, bot: entry.item, marked: markedUnread[entry.item.id] === true })
            : entry.kind === 'room'
              ? h(RoomRow, { key: entry.item.id, ...rowProps, room: entry.item, marked: markedUnread[entry.item.id] === true })
              : h(AgentRow, { key: entry.item.id, ...rowProps, agent: entry.item, marked: markedUnread[entry.item.id] === true })
        }))),
    h(WorkgroupMenu, { menu, actions, onClose: closeMenu }))
}

// New rules only: the copied rows keep using the original shell's classes and tokens, and every
// colour here is one of those tokens rather than a second palette. The workgroup rows add a Hub dot,
// a text badge, and compact counts beside the copied row body.
export const WORKGROUP_SIDEBAR_CSS = `
.bt-wg-side-head{flex:none;display:flex;align-items:center;gap:6px;margin:2px 8px 0;padding:0 2px}
.bt-wg-side-title{flex:1;min-width:0;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.04em;color:var(--bt-ink-3);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-create{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:none;color:var(--bt-ink-3);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-wg-create:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-wg-create:active:not(:disabled){transform:scale(.94)}
.bt-wg-create:disabled{opacity:.4;cursor:default}
.bt-wg-create svg{width:16px;height:16px}
.bt-wg-create-hint,.bt-wg-roster-error{margin:2px 10px 4px;font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-wg-create-error{margin:2px 10px 4px;font-size:11px;line-height:16px;overflow-wrap:anywhere}
.bt-rail .bt-wg-side-head{justify-content:center;margin:2px 0 0;padding:0}
.bt-wg-invites{flex:none;display:flex;flex-direction:column;gap:4px;margin:6px 8px 4px;padding:6px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card)}
.bt-wg-invites-head{display:flex;align-items:center;gap:6px;padding:0 2px 2px;font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-3)}
.bt-wg-invites-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-invites-count{flex:none;min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px;text-align:center;box-sizing:border-box}
.bt-wg-invite{display:flex;flex-direction:column;gap:3px;padding:5px 6px;border-radius:8px;background:var(--bt-hover)}
.bt-wg-invite-head{display:flex;align-items:center;gap:6px;min-width:0}
.bt-wg-invite-room{flex:1;min-width:0;font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-invite-role{flex:none;padding:0 5px;border-radius:5px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px}
.bt-wg-invite-who{font-size:11px;line-height:16px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-invite-actions{display:flex;gap:6px;margin-top:1px}
.bt-wg-invite-accept,.bt-wg-invite-decline{height:24px;padding:0 10px;border:0;border-radius:999px;font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.bt-wg-invite-accept{background:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
.bt-wg-invite-accept:hover:not(:disabled){opacity:.88}
.bt-wg-invite-decline{background:var(--bt-tag-bg);color:var(--bt-ink-2)}
.bt-wg-invite-decline:hover:not(:disabled){background:var(--bt-active);color:var(--bt-ink)}
.bt-wg-invite-accept:disabled,.bt-wg-invite-decline:disabled{opacity:.5;cursor:default}
.bt-wg-invite-error{font-size:11px;line-height:15px;overflow-wrap:anywhere}
.bt-wg-invites-rail{flex:none;display:flex;justify-content:center;margin:4px 0 2px}
.bt-wg-invite-badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:11px;line-height:18px;text-align:center;box-sizing:border-box}
.bt-wg-row-ava{position:relative;flex:none;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
.bt-wg-hub-dot{position:absolute;right:0;bottom:1px;width:9px;height:9px;border-radius:50%;background:var(--bt-ink-3);box-shadow:0 0 0 2px var(--bt-sidebar)}
.bt-wg-hub-dot[data-hub=live]{background:var(--bt-green)}
.bt-wg-hub-dot[data-hub=reconnecting]{background:var(--bt-accent,#4D6BFE);animation:bt-wg-hub-pulse 1.4s ease-in-out infinite}
.bt-wg-hub-dot[data-hub=offline],.bt-wg-hub-dot[data-hub=refused]{background:#E5484D}
.bt-wg-hub-dot[data-hub=absent],.bt-wg-hub-dot[data-hub=signed-out],.bt-wg-hub-dot[data-hub=unknown]{background:var(--bt-ink-3)}
@keyframes bt-wg-hub-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.bt-wg-row .bt-row-title{flex:0 1 auto}
.bt-wg-row-badge{flex:none;padding:0 5px;border-radius:5px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:15px;white-space:nowrap}
.bt-wg-row-ended{background:var(--bt-hover);color:var(--bt-ink-3)}
.bt-wg-row-meta{display:flex;align-items:center;gap:4px;min-width:0;font-size:11px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-wg-row-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-wg-row-sep{flex:none;color:var(--bt-ink-3)}
.bt-wg-row-hub[data-hub=live]{color:var(--bt-green)}
.bt-wg-row-hub[data-hub=offline],.bt-wg-row-hub[data-hub=refused]{color:#c21d2e}
.bt-wg-row-unread,.bt-wg-row-approval{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:11px;line-height:18px;text-align:center;box-sizing:border-box}
.bt-wg-row-unread{background:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
.bt-wg-row-approval{background:var(--bt-star,#E5484D);color:var(--bt-accent-ink,#fff)}
.bt-wg-menu{min-width:160px}
@media (prefers-reduced-motion:reduce){.bt-wg-hub-dot[data-hub=reconnecting]{animation:none}.bt-wg-create{transition:none}}
`
