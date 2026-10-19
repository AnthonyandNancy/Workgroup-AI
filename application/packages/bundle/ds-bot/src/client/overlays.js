import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { NewChat } from './new-chat.js'
import { WorkgroupCreate } from './workgroup-ui/create.js'
import { WorkgroupSettingsForm } from './workgroup-ui/settings.js'
import { workgroupRow } from './workgroup-roster.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { MemoryDialog } from './memory-panel.js'
import { useLinger } from './motion.js'
import { PlugIcon } from './icons.js'
import { t } from './i18n.js'

// How long a closing dialog or menu stays for its exit (see their [data-leaving] CSS).
const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useRegistry, useBrowserPages, useBrowserTabs, useUpdate, useWorkgroups, useHub, useWorkgroupRoster, useWorkgroupPrefs, workgroupHub, sessions, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  const hub = useHub(value => value)
  useRegistry(value => value)
  // The workgroup adapter, or `undefined` when this install has no Hub. Read as a hook because the
  // answer is confirmed asynchronously by the Host and can change while the window is open: a prop
  // captured at mount would freeze the first answer, and with it the menu entry.
  const workgroups = useWorkgroups(value => value)
  // The settings page draws workgroups from the same polled roster the sidebar uses, so a room's
  // settings and its sidebar row can never disagree about the room's name or its members.
  const workgroupRoster = useWorkgroupRoster === undefined ? undefined : useWorkgroupRoster(value => value)
  const workgroupPrefs = useWorkgroupPrefs === undefined ? undefined : useWorkgroupPrefs(value => value)
  // The sidebar's own rows, so a room's settings page and its sidebar row describe the same room.
  const workgroupRows = workgroupRoster?.rows === undefined
    ? undefined
    : workgroupRoster.rows.map(row => workgroupRow(row, workgroupPrefs))
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab } : null
  const [kept, setKept] = useState(open)
  useEffect(() => {
    if (open) { setKept(open); return undefined }
    const timer = setTimeout(() => setKept(null), PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab])
  const pane = open ?? kept
  const [settings, settingsLeaving] = useLinger(ui.settings, DIALOG_EXIT_MS)
  const [memory, memoryLeaving] = useLinger(ui.memory && roster.byId[ui.memory] ? ui.memory : null, DIALOG_EXIT_MS)
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  return h(Fragment, null,
    pane ? createPortal(h(BotPanel, { pane, leaving: open === null, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages }), document.body) : null,
    ui.newChat === 'workgroup'
      ? createPortal(h(WorkgroupCreate, {
        key: 'workgroup',
        workgroups,
        hub,
        onCancel: actions.closeOverlay,
        onCreated: (room) => { void workgroups.openWorkgroup(room.id); actions.closeOverlay() },
        report: error => actions.reportError?.(error, 'workgroup'),
      }), document.body)
      : ui.newChat ? createPortal(h(NewChat, {
        key: ui.newChat, mode: ui.newChat, roster, actions,
        extraOptions: workgroups === undefined ? [] : [{
          key: 'workgroup', icon: h(PlugIcon), label: t('Create workgroup chat'),
          run: () => workgroups.openWorkgroupCreate(),
        }],
      }), document.body) : null,
    ui.palette ? createPortal(h(CommandPalette, {
      key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions,
      extraCommands: workgroups === undefined ? [] : [{
        key: 'cmd:workgroup', icon: h(PlugIcon), title: t('Create workgroup chat'),
        run: () => workgroups.openWorkgroupCreate(),
      }],
    }), document.body) : null,
    ui.exchange ? createPortal(h(ExchangeDialog, { pair: ui.exchange, roster, actions }), document.body) : null,
    ui.voice ? createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, roster, actions, useSessions, useSessionStatus }), document.body) : null,
    menu ? createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, leaving: menuLeaving }), document.body) : null,
    settings ? createPortal(h(SettingsDialog, {
      page: settings.page, id: settings.id, roster, actions, useUpdate, hub, workgroupHub, sessions, leaving: settingsLeaving,
      // The groups page lists workgroups beside local groups and opens one in the same dialog: the
      // sidebar's "group settings" row leads here, and a second settings surface would be a second set
      // of the same rules.
      externalGroups: workgroupRows === undefined ? {} : Object.fromEntries(workgroupRows.map(row => [row.id, row])),
      // Drawn here rather than in the dialog because this layer is the one that knows what a workgroup
      // is: the settings dialog only knows where the page goes.
      renderGroup: workgroupRows === undefined ? undefined : ({ id }) => {
        const row = workgroupRows.find(entry => entry.id === id)
        if (row === undefined) return null
        const snapshot = workgroups?.roomState?.(id)?.getSnapshot?.()
        if (snapshot?.room === undefined) {
          return h('div', { className: 'bt-muted', 'data-external-group-loading': id, role: 'status' }, t('Opening the workgroup…'))
        }
        return h(WorkgroupSettingsForm, {
          room: snapshot.room,
          members: snapshot.members ?? [],
          bots: snapshot.bots ?? [],
          selfUserId: workgroups?.identity?.userId,
          identity: workgroups?.identity,
          prefs: workgroupPrefs?.[id] ?? {},
          onAction: async (operation, payload) => {
            switch (operation) {
              case 'renameRoom': return workgroups.renameRoom(id, payload)
              case 'updateNotice': return workgroups.updateNotice(id, payload.notice)
              case 'updateSettings': return workgroups.updateSettings(id, payload)
              case 'addBot': return workgroups.addBot(id, payload.botId)
              case 'inviteBot': return workgroups.inviteBot(id, payload)
              case 'removeBot': return workgroups.removeBot(id, payload.ownerUserId, payload.botId)
              case 'invite': return workgroups.invite(id, payload)
              case 'setRole': return workgroups.setRole(id, payload.userId, payload.role)
              case 'removeMember': return workgroups.removeMember(id, payload.userId)
              case 'revokeInvitation': return workgroups.revokeInvitation(payload.invitationId)
              case 'leaveRoom': return workgroups.leaveRoom(id)
              default: throw new Error(`Unknown workgroup action ${operation}`)
            }
          },
          onDissolve: async () => { await workgroups.dissolve(id); await workgroups.refresh?.() },
          onClose: () => actions.closeSettings?.(),
          onFlag: patch => workgroups.setWorkgroupFlag?.(id, patch),
          loadOwnerBots: workgroups?.directory,
          loadBotCandidates: workgroups?.botCandidates === undefined ? undefined : () => workgroups.botCandidates(id),
        })
      },
      extraGroups: workgroups === undefined ? [] : [{
        key: 'workgroup', label: t('Create workgroup chat'),
        run: () => { actions.closeSettings?.(); workgroups.openWorkgroupCreate(); return undefined },
      }],
    }), document.body) : null,
    memory && roster.byId[memory] ? createPortal(h(MemoryDialog, { key: memory, bot: roster.byId[memory], actions, leaving: memoryLeaving }), document.body) : null)
}
