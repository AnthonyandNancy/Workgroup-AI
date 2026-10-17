import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { ACCENT_INKS, INKS } from './inks.js'
import { isMainOf } from './sources.js'
import { allThemes } from './themes.js'
import { CloseIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, ConnectorIcon, InfoIcon, PlugIcon, PlusIcon, SlidersIcon, SETTINGS_ICONS } from './icons.js'
import { AdminStar, BotAvatar, RoomAvatar } from './mark.js'
import { openHarnessSettings } from './sidebar.js'
import { useEscape } from './overlay-hooks.js'
import { BotSettingsForm } from './bot-settings.js'
import { Segmented, useGlide } from './motion.js'
import { GroupSettingsForm, NewGroupForm } from './group-settings.js'
import { enterWorkgroup } from './workgroup-entry.js'
import { CreateBot } from './create-bot.js'
import { KeyIcon, SecretsPage } from './secret-card.js'
import { UsagePage } from './usage-page.js'
import { ConnectorsPage } from './connectors.js'
import { CapabilitiesPage } from './capability-settings.js'
import { SchedulesPage } from './schedules.js'
import { FeedbackIcon, FeedbackPage } from './feedback.js'
import { AboutPage } from './about.js'
import { t } from './i18n.js'

const capitalize = word => word[0].toUpperCase() + word.slice(1)

// Settings dialog: a 198px page list beside the page. Bots and group chats each list
// their members, and one opens on its own settings form. Usage widens the dialog.
const SETTINGS_PAGES = [['general', 'General'], ['hub', 'Workgroup Hub'], ['bots', 'Bots'], ['groups', 'Group chats'], ['connectors', 'Connectors'], ['capabilities', 'Capabilities'], ['schedules', 'Scheduled tasks'], ['usage', 'Usage'], ['secrets', 'Secrets'], ['feedback', 'Feedback'], ['about', 'About DS Bot']]
const PAGE_ICONS = { ...SETTINGS_ICONS, hub: PlugIcon, connectors: ConnectorIcon, capabilities: PlugIcon, schedules: ClockIcon, secrets: KeyIcon, feedback: FeedbackIcon, about: InfoIcon }

function SetSection({ title, children }) {
  return h('section', { className: 'bt-set-section' }, h('h3', null, title), h('div', { className: 'bt-set-card' }, children))
}
function SetRow({ label, hint, children, wide = false }) {
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' }, h('span', null, label), hint ? h('span', { className: 'bt-set-hint' }, hint) : null),
    children ? h('div', { className: `bt-set-control${wide ? ' bt-set-control-wide' : ''}` }, children) : null)
}

function GeneralPage({ roster, actions, run }) {
  const prefs = roster.prefs ?? {}
  const themes = allThemes()
  const current = themes[prefs.theme] ? prefs.theme : 'deepseek'
  const [custom, setCustom] = useState(prefs.accent ?? '#4d6bfe')
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const pickCustom = (value) => {
    setCustom(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => run(actions.setPrefs({ accent: value })), 350)
  }
  return [
    h(SetSection, { key: 'look', title: t('Appearance') },
      h(SetRow, { label: t('Theme'), hint: t('Colors for the whole team, on every device.') },
        h('select', { className: 'bt-select', 'aria-label': t('Theme'), value: current, onChange: event => run(actions.setPrefs({ theme: event.target.value })) },
          Object.entries(themes).map(([id, theme]) => h('option', { key: id, value: id }, t(theme.label))))),
      h(SetRow, { label: t('Accent'), hint: t('Unread marks, badges, and the brand mark.') },
        h('div', { className: 'bt-swatches' },
          h('button', { type: 'button', className: 'bt-swatch bt-swatch-default', title: t('Theme accent'), 'aria-label': t('Theme accent'), 'aria-pressed': !prefs.accent, onClick: () => run(actions.setPrefs({ accent: null })) }),
          ACCENT_INKS.map(ink => h('button', {
            key: ink, type: 'button', className: 'bt-swatch', title: t(capitalize(ink)), 'aria-label': t(capitalize(ink)), 'aria-pressed': prefs.accent === INKS[ink][0],
            style: { background: INKS[ink][0] }, onClick: () => run(actions.setPrefs({ accent: INKS[ink][0] })),
          })),
          h('label', { className: 'bt-swatch bt-swatch-custom', title: t('Custom accent'), 'data-on': Boolean(prefs.accent) && !ACCENT_INKS.some(ink => INKS[ink][0] === prefs.accent) },
            h('input', { type: 'color', value: custom, 'aria-label': t('Custom accent'), onChange: event => pickCustom(event.target.value) }))))),
    h(SetSection, { key: 'mode', title: t('Mode') },
      h(SetRow, { label: t('Classic Agent mode') },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.setSurface('agent') }, t('Switch')))),
  ]
}

// The first Main Bot is the sidebar tile. Picking another Bot there hands it the role
// in one step; more Main Bots can sit beside it.
function MainBotsSection({ roster, actions, run }) {
  const mains = (roster.mainBotIds ?? []).map(id => roster.byId[id]).filter(Boolean)
  const [first, ...others] = mains
  const candidates = roster.bots.filter(bot => !isMainOf(roster, bot.id))
  return h(SetSection, { title: t('Main Bot') },
    h(SetRow, {
      label: t('Main Bot'),
      hint: first ? t('First in the sidebar. Pick another Bot to hand it the role; {name} then stops being a Main Bot.', { name: first.name }) : undefined,
    },
    h('select', {
      className: 'bt-select', 'aria-label': t('Main Bot'), value: first?.id ?? '',
      onChange: event => run(actions.setMain(event.target.value, true, first ? { replace: first.id } : {})),
    }, first ? null : h('option', { value: '' }, t('Choose a Bot…')), roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
    others.map(bot => h(SetRow, { key: bot.id, label: bot.name, hint: t('Also a Main Bot.') },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, true, { primary: true })) }, t('Move to first')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.setMain(bot.id, false)) }, t('Remove Main Bot role')))),
    candidates.length > 0 ? h(SetRow, { label: t('Add a Main Bot'), hint: t('Main Bots can create and change Bots, and run every group chat.') },
      h('select', {
        className: 'bt-select', 'aria-label': t('Add a Main Bot'), value: '',
        onChange: (event) => { if (event.target.value) void run(actions.setMain(event.target.value, true)) },
      }, h('option', { value: '' }, t('Choose a Bot…')), candidates.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))) : null)
}

const MOTIONS = [['quiet', 'Quiet'], ['normal', 'Normal'], ['lively', 'Lively']]
function MotionSection({ roster, actions, run }) {
  const motion = roster.prefs?.motion === 'quiet' || roster.prefs?.motion === 'lively' ? roster.prefs.motion : 'normal'
  return h(SetSection, { title: t('Animation') },
    h(SetRow, { label: t('Bot animation') },
      h(Segmented, { label: t('Bot animation'), value: motion, className: 'bt-motion-seg' }, MOTIONS.map(([id, label]) => h('button', {
        key: id, type: 'button', 'aria-pressed': motion === id,
        onClick: () => { if (motion !== id) run(actions.setPrefs({ motion: id })) },
      }, t(label))))))
}

function BotsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  return [
    h(MainBotsSection, { key: 'main', roster, actions, run }),
    h(MotionSection, { key: 'motion', roster, actions, run }),
    creating
      ? h(CreateBot, { key: 'create', roster, actions, inline: true, onBack: () => setCreating(false), onCreated: bot => actions.openSettings('bots', bot.id) })
      : h('div', { key: 'new', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setCreating(true) }, h(PlusIcon), t('New Bot'))),
    h(SetSection, { key: 'bots', title: t('Bots · {count}', { count: roster.bots.length }) },
      roster.bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('bots', bot.id) },
        h('span', { className: 'bt-set-bot' },
          h(BotAvatar, { bot, size: 28, badge: false, live: false }),
          h('span', { className: 'bt-row-title' }, bot.name),
          bot.role ? h('span', { className: 'bt-tag' }, bot.role) : null,
          isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Main Bot')) : null,
          bot.hidden && !isMainOf(roster, bot.id) ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
        h('span', { className: 'bt-chevron' }, h(ChevronRightIcon))))),
  ]
}

function GroupsPage({ roster, actions, run }) {
  const [creating, setCreating] = useState(false)
  return [
    creating
      ? h(NewGroupForm, { key: 'create', roster, actions, run, onCancel: () => setCreating(false), onCreated: room => actions.openSettings('groups', room.id) })
      : h('div', { key: 'new', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: roster.bots.length < 2, title: roster.bots.length < 2 ? t('A group chat needs at least two Bots') : undefined, onClick: () => setCreating(true) }, h(PlusIcon), t('Create group chat'))),
    h(SetSection, { key: 'groups', title: t('Group chats · {count}', { count: roster.rooms.length }) },
      roster.rooms.length === 0
        ? h(SetRow, { label: t('No group chats yet.'), hint: t('A group chat lets several Bots work on one thing with you.') })
        : roster.rooms.map((room) => {
            const admin = roster.byId[room.admin]
            return h('button', { key: room.id, type: 'button', className: 'bt-set-row', onClick: () => actions.openSettings('groups', room.id) },
              h('span', { className: 'bt-set-bot' },
                h(RoomAvatar, { room, roster, size: 28 }),
                h('span', { className: 'bt-row-title' }, room.name),
                h('span', { className: 'bt-tag' }, t('{count} members', { count: room.members.length })),
                admin ? h('span', { className: 'bt-tag bt-tag-admin' }, h(AdminStar), admin.name) : null,
                room.hidden ? h('span', { className: 'bt-tag' }, t('Hidden')) : null),
              h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))
          })),
  ]
}

function HubPage({ hub, workgroupHub, sessions, actions }) {
  const [url, setUrl] = useState(hub?.hubUrl ?? '')
  const [userHandle, setUserHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [bootstrapSecret, setBootstrapSecret] = useState('')
  const [deviceLabel, setDeviceLabel] = useState('')
  const [rooms, setRooms] = useState([])
  const [invitations, setInvitations] = useState([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (hub?.hubUrl !== undefined) setUrl(hub.hubUrl)
  }, [hub?.hubUrl])

  const refresh = useCallback(async () => {
    if (hub?.signedIn !== true) {
      setRooms([])
      setInvitations([])
      return
    }
    const [nextRooms, nextInvitations] = await Promise.all([
      workgroupHub.rooms(),
      workgroupHub.invitations(),
    ])
    setRooms(Array.isArray(nextRooms) ? nextRooms : [])
    setInvitations(Array.isArray(nextInvitations) ? nextInvitations : nextInvitations?.invitations ?? [])
  }, [hub?.signedIn, workgroupHub])

  useEffect(() => {
    void refresh().catch(failure => setError(failure?.message ?? String(failure)))
  }, [refresh])

  const invoke = async (task, success, refreshRooms = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await task()
      setNotice(t(success))
      if (refreshRooms) await refresh()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value) => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard) {
      setError(t('Copy is unavailable'))
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setNotice(t('Copied'))
      setError('')
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }

  const openRoom = roomId => enterWorkgroup({
    roomId,
    sessions,
    openSession: actions.openSession,
    closeOverlay: actions.closeSettings,
    watch: room => workgroupHub.watch(room),
    report: failure => setError(failure?.message ?? String(failure)),
  })

  const configured = hub?.configured === true
  const signedIn = hub?.signedIn === true
  const status = !configured
    ? t('Hub is not configured')
    : signedIn
      ? t('Signed in as {name}', { name: hub.userHandle ?? hub.userId ?? t('Unknown user') })
      : t('Configured, signed out')

  const submitRegistration = () => {
    const payload = { userHandle: userHandle.trim(), displayName: displayName.trim(), password, deviceLabel: deviceLabel.trim() }
    if (bootstrapSecret.trim() !== '') payload.bootstrapSecret = bootstrapSecret
    return workgroupHub.register(payload)
  }

  return [
    h(SetSection, { key: 'connection', title: t('Connection') },
      h(SetRow, { label: t('Current status'), hint: hub?.state ?? 'unknown' }, h('span', { className: 'bt-tag' }, status)),
      h(SetRow, { label: t('Hub URL'), wide: true, hint: t('The Host keeps this non-sensitive address on this machine.') },
        h('input', { className: 'bt-input', type: 'url', value: url, placeholder: t('Enter a Hub URL'), autoComplete: 'url', onChange: event => setUrl(event.target.value) })),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || url.trim() === '', onClick: () => invoke(() => workgroupHub.configure({ url: url.trim() }), 'Hub configuration saved') }, t('Configure Hub')),
        signedIn ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => invoke(() => workgroupHub.signOut(), 'Signed out') }, t('Sign out')) : null,
        configured && !signedIn ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => invoke(() => workgroupHub.resume(), 'Sign-in restored') }, t('Resume')) : null)),
    h(SetSection, { key: 'account', title: t('Hub account') },
      h(SetRow, { label: t('Username'), wide: true, hint: t('Use this exact handle when a colleague invites you.') },
        h('input', { className: 'bt-input', value: userHandle, autoComplete: 'username', onChange: event => setUserHandle(event.target.value), placeholder: t('Username') })),
      h(SetRow, { label: t('Password'), wide: true },
        h('input', { className: 'bt-input', type: 'password', value: password, autoComplete: 'current-password', onChange: event => setPassword(event.target.value), placeholder: t('Password') })),
      h(SetRow, { label: t('Device label'), wide: true },
        h('input', { className: 'bt-input', value: deviceLabel, autoComplete: 'off', onChange: event => setDeviceLabel(event.target.value), placeholder: t('Device label') })),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || userHandle.trim() === '' || password === '', onClick: () => invoke(() => workgroupHub.signIn({ userHandle: userHandle.trim(), password, label: deviceLabel.trim() }), 'Signed in') }, t('Sign in')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !configured, onClick: () => invoke(() => workgroupHub.resume(), 'Sign-in restored') }, t('Resume'))),
      signedIn && hub?.userId ? h(SetRow, { label: t('Your user ID'), hint: t('Copy this ID to let a colleague invite you.') },
        h('span', { className: 'bt-tag' }, hub.userId),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => copy(hub.userId) }, t('Copy my ID'))) : null,
      signedIn && hub?.userHandle ? h(SetRow, { label: t('Your username') },
        h('span', { className: 'bt-tag' }, hub.userHandle),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => copy(hub.userHandle) }, t('Copy my username'))) : null,
      signedIn && hub?.displayName ? h(SetRow, { label: t('Display name') }, h('span', { className: 'bt-tag' }, hub.displayName)) : null,
      signedIn && hub?.deviceId ? h(SetRow, { label: t('Device ID') }, h('span', { className: 'bt-tag' }, hub.deviceId)) : null),
    h(SetSection, { key: 'register', title: t('Register this account') },
      h(SetRow, { label: t('Display name'), wide: true },
        h('input', { className: 'bt-input', value: displayName, autoComplete: 'name', onChange: event => setDisplayName(event.target.value), placeholder: t('Display name') })),
      h(SetRow, { label: t('Registration key'), wide: true, hint: t('Only sent to the Host for this request.') },
        h('input', { className: 'bt-input', type: 'password', value: bootstrapSecret, autoComplete: 'off', onChange: event => setBootstrapSecret(event.target.value), placeholder: t('Registration key') })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || !configured || userHandle.trim() === '' || password === '', onClick: () => invoke(submitRegistration, 'Registration submitted') }, t('Register'))),
    signedIn ? h(SetSection, { key: 'rooms', title: t('Rooms I belong to') },
      rooms.length === 0
        ? h(SetRow, { label: t('No workgroups yet.') })
        : rooms.map(room => h('button', {
          key: room.id,
          type: 'button',
          className: 'bt-set-row',
          onClick: () => void openRoom(room.id),
        },
          h('span', { className: 'bt-row-title' }, room.name ?? room.id),
          h('span', { className: 'bt-tag' }, t('Reopen')),
          h('span', { className: 'bt-chevron' }, h(ChevronRightIcon)))),
    ) : null,
    signedIn ? h(SetSection, { key: 'invitations', title: t('Invitations') },
      invitations.length === 0
        ? h(SetRow, { label: t('No pending invitations') })
        : invitations.map(invitation => h('div', { key: invitation.id, className: 'bt-set-row' },
            h('span', { className: 'bt-row-title' }, invitation.roomName ?? invitation.room?.name ?? invitation.roomId),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => invoke(() => workgroupHub.respondToInvitation(invitation.id, 'accept'), 'Invitation accepted', true) }, t('Accept')),
            h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => invoke(() => workgroupHub.respondToInvitation(invitation.id, 'decline'), 'Invitation rejected', true) }, t('Reject'))))) : null,
    notice ? h('div', { key: 'notice', className: 'bt-success', role: 'status' }, notice) : null,
    error ? h('div', { key: 'error', className: 'bt-error', role: 'alert' }, error) : null,
  ]
}

// While `leaving`, the dialog plays its exit and takes no input.
export function SettingsDialog({ page, id, roster, actions, useUpdate, hub, workgroupHub, sessions, leaving = false }) {
  const [error, setError] = useState('')
  const close = useCallback(() => actions.closeSettings(), [])
  useEscape(close)
  const run = promise => Promise.resolve(promise)
    .then(() => { setError(''); return true })
    .catch(failure => { setError(failure?.message ?? String(failure)); return false })
  // A Bot or group deleted while its form is open leaves its page on the list.
  const bot = page === 'bots' && id ? roster.byId[id] : undefined
  const room = page === 'groups' && id ? roster.roomsById[id] : undefined
  const shown = SETTINGS_PAGES.some(([key]) => key === page) ? page : 'general'
  const usageFocus = shown === 'usage' && id ? id : null
  const label = t(SETTINGS_PAGES.find(([key]) => key === shown)[1])
  const back = bot ? t('Back to Bots') : room ? t('Back to group chats') : usageFocus ? t('All usage') : null
  const nav = useGlide(shown, { axis: 'y' })
  // A page enters from the right when it is one level in, from the left when it comes
  // back out, and from below beside it. Usage keeps its own entrance and its data
  // across its own levels, so they share one page.
  const pageKey = `${shown}:${bot?.id ?? room?.id ?? ''}`
  const depth = bot || room ? 1 : 0
  const last = useRef({ key: pageKey, depth, move: 'up' })
  if (last.current.key !== pageKey) {
    last.current = { key: pageKey, depth, move: depth > last.current.depth ? 'in' : depth < last.current.depth ? 'out' : 'up' }
  }
  // Usage stays mounted from its first visit until Settings closes: coming back to it
  // shows the same page at once instead of loading it again. Meanwhile it keeps its
  // rendered state off screen (content-visibility).
  const [usageOpened, setUsageOpened] = useState(shown === 'usage')
  if (shown === 'usage' && !usageOpened) setUsageOpened(true)
  const errorLine = error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null
  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-settings', role: 'dialog', 'aria-modal': true, 'aria-label': t('DS Bot settings'), 'data-wide': shown === 'usage' ? '' : undefined },
      h('nav', { ref: nav.box, className: 'bt-settings-nav', 'aria-label': t('Settings pages') },
        h('span', { ref: nav.thumb, className: 'bt-thumb', 'aria-hidden': true }),
        SETTINGS_PAGES.map(([key, text]) => h('button', {
          key, type: 'button', className: 'bt-settings-item', 'aria-current': shown === key ? 'page' : undefined, onClick: () => actions.openSettings(key),
        }, h(PAGE_ICONS[key]), t(text))),
        h('button', {
          type: 'button', className: 'bt-settings-item bt-settings-shell', title: t('Models, providers, and the rest of DeepSeek Harness'),
          onClick: () => { close(); openHarnessSettings() },
        }, h(SlidersIcon), t('Harness settings'))),
      h('div', { className: 'bt-settings-main' },
        h('div', { className: 'bt-settings-head' },
          back ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': back, title: back, onClick: () => actions.openSettings(shown) }, h(ChevronLeftIcon)) : null,
          h('h2', { key: bot?.id ?? room?.id ?? shown }, bot?.name ?? room?.name ?? label)),
        shown === 'usage' ? null : h('div', { key: pageKey, className: 'bt-settings-scroll bt-settings-page', 'data-move': last.current.move },
          errorLine,
          shown === 'general' ? h(GeneralPage, { roster, actions, run }) : null,
          shown === 'hub' ? h(HubPage, { hub, workgroupHub, sessions, actions }) : null,
          bot ? h('div', { className: 'bt-settings-form' }, h(BotSettingsForm, { key: bot.id, bot, roster, actions, run })) : null,
          shown === 'bots' && !bot ? h(BotsPage, { roster, actions, run }) : null,
          room ? h('div', { className: 'bt-settings-form' }, h(GroupSettingsForm, { key: room.id, room, roster, actions, run })) : null,
          shown === 'groups' && !room ? h(GroupsPage, { roster, actions, run }) : null,
          shown === 'connectors' ? h(ConnectorsPage, { roster, actions }) : null,
          shown === 'capabilities' ? h(CapabilitiesPage, { roster, actions, run }) : null,
          shown === 'schedules' ? h(SchedulesPage, { roster, actions, start: id ?? undefined }) : null,
          shown === 'secrets' ? h(SecretsPage, { roster, actions, run, Section: SetSection }) : null,
          shown === 'feedback' ? h(FeedbackPage, { actions, run, Section: SetSection, Row: SetRow }) : null,
          shown === 'about' ? h(AboutPage, { useUpdate, actions, run, Section: SetSection, Row: SetRow }) : null),
        usageOpened ? h('div', { key: 'usage', className: 'bt-settings-scroll bt-settings-usage', 'data-off': shown === 'usage' ? undefined : '', 'aria-hidden': shown === 'usage' ? undefined : true },
          shown === 'usage' ? errorLine : null,
          h(UsagePage, { roster, actions, focusId: usageFocus })) : null),
      h('button', { type: 'button', className: 'bt-settings-close', 'aria-label': t('Close settings'), onClick: close }, h(CloseIcon))))
}
