// F-07 / F-08 / F-09: the Bot entry, what it shows, and what it leaves behind.
//
// These cases run the real client bundle through `apply` against a fake shell, so they need no
// browser and no Host. They exist because the browser reports only "one entry did not activate"
// when a plugin throws during `apply` — an error that says nothing about the cause. Driving
// `apply` here surfaces the real exception and records what was registered, which is what the
// three requirements actually assert:
//
//   F-07  exactly one `Bot` entry, ordered directly below `Plugins`
//   F-08  entering it shows the original team interface, not a replacement chat
//   F-09  the team surface is gated on that entry, so other surfaces keep the shell's own UI
//
// The UI-level proof (real browser, real screenshots) lives in
// `application/tests/app-f07-ui-check.mjs`; these cases are the fast regression net for the same
// behaviour.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadClientPlugin, fakeShell } from '../../ds-bot/tests/apply-harness.mjs'
import { groupsFor } from '../../../packages/bundle/ds-bot/src/client/surface.js'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const bundlePath = join(repoRoot, 'packages', 'bundle', 'ds-bot', 'client.js')
const clientSource = join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'index.js')
const stylesSource = join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'styles.js')

describe('the Bot entry, its surface, and what it leaves behind', () => {
  const loaded = loadClientPlugin(bundlePath)
  const shell = fakeShell()
  loaded.module.apply(shell.ctx)
  // The plugin keeps a poll timer; stop it so nothing runs after this file finishes.
  loaded.stopTimers()


// ---------------------------------------------------------------- F-07

it('the client registers exactly one Bot entry, and nothing else in the first-level navigation', () => {
  const entries = shell.registrations.filter(r => r.options.name === 'sidebar.panellist')
  // One entry, and it is the Bot entry. A second would be a second button in the sidebar.
  expect(entries.length, `expected one panellist entry, got ${entries.length}`).toBe(1)
  expect(entries[0].options.id).toBe('conversation')
  expect(entries[0].component.name).toBe('BotPanelIcon')
})

it('the Bot entry is ordered directly below Plugins and above Automation tasks', () => {
  const botOrder = shell.registrations.find(r => r.options.name === 'sidebar.panellist').options.order
  // The shell's own values, read from the two packages that register them: `plugins` uses 0
  // and `schedules` uses 10, so anything strictly between puts Bot directly beneath Plugins
  // without moving either of them.
  const pluginsOrder = 0
  const schedulesOrder = 10
  expect(botOrder > pluginsOrder, `Bot (${botOrder}) must come after Plugins (${pluginsOrder})`).toBe(true)
  expect(botOrder < schedulesOrder, `Bot (${botOrder}) must come before Automation tasks (${schedulesOrder})`).toBe(true)
})

it('the Bot entry carries a label and no second-level team entries are promoted', () => {
  const entry = shell.registrations.find(r => r.options.name === 'sidebar.panellist')
  const label = entry.options.label()
  expect(label).toBe('Bot')
  // The first-level list is what the sidebar renders; Chief, the Bot list, and the chats are
  // reached from inside the Bot surface, never from here.
  const panelIds = shell.registrations.filter(r => r.options.name === 'sidebar.panellist').map(r => r.options.id)
  for (const forbidden of ['chief', 'bots', 'chats', 'groups', 'workgroups']) {
    expect(panelIds.includes(forbidden), `${forbidden} must not be a first-level entry`).toBe(false)
  }
})

it('the client registers no second Conversation panel', () => {
  // `main.conversation` is declared once, by ui-conversation, and the slot registry refuses a
  // second declaration. Registering a `main` entry here would therefore either throw or show an
  // empty column; the entry selects the reserved key instead.
  const mainEntries = shell.registrations.filter(r => r.options.name === 'main')
  expect(mainEntries, 'the client must not register a main entry of its own').toEqual([])
})

// ---------------------------------------------------------------- F-08

it('the Bot entry selects the shell\'s reserved conversation key, so the team chat is the real chat', () => {
  const entry = shell.registrations.find(r => r.options.name === 'sidebar.panellist')
  // `ui-conversation` registers the centre Conversation under this key, and the sidebar row
  // calls `selectPanel(entry.id)`. Sharing the id is what makes a click land on the real chat.
  expect(entry.options.id).toBe('conversation')
  const shellConversationKey = 'conversation'
  expect(entry.options.id).toBe(shellConversationKey)
})

it('the team surface is applied to the Conversation rather than replacing it', () => {
  const source = readFileSync(clientSource, 'utf8')
  // The team's replacements are DS Bot's own `shadow` calls over shell slots; the guarantee
  // that matters here is that they are installed through `installShell`/`installConversation`
  // and gated, not that a second chat component exists.
  expect(source).toMatch(/installShell/)
  expect(source).toMatch(/installConversation/)
  expect(/function BotPanelPage/.test(source), 'there must be no second chat component').toBe(false)
})

// ---------------------------------------------------------------- F-09

it('both surface groups are gated on the Bot entry being the active panel', () => {
  // Inside the Bot entry: the team surface is on.
  expect(groupsFor({ mode: 'bot', panelActive: true })).toEqual({ shell: true, conversation: true })
  // On any other surface: nothing of DS Bot remains.
  expect(groupsFor({ mode: 'bot', panelActive: false })).toEqual({ shell: false, conversation: false })
  // Agent mode inside the Bot entry keeps the shell but withdraws the conversation replacements.
  expect(groupsFor({ mode: 'agent', panelActive: true })).toEqual({ shell: false, conversation: false })
  // A plain Session inside the Bot entry keeps the shell and drops the chat replacements.
  expect(groupsFor({ mode: 'bot', plain: true, panelActive: true })).toEqual({ shell: true, conversation: false })
})

it('a profile without the fork\'s entry keeps upstream behaviour, where the team is the surface', () => {
  // `panelActive` defaults to true so a plain DS Bot install — nothing registers the entry, so
  // nothing ever sets the flag — renders the team exactly as upstream intends.
  expect(groupsFor({ mode: 'bot' })).toEqual({ shell: true, conversation: true })
})

it('the shell-chrome rules that used to hide the first-level navigation are scoped to the entry', () => {
  const styles = readFileSync(stylesSource, 'utf8')
  // The rule that hid `nav.panelList` globally is gone: it removed the very entry a user needs
  // in order to leave the team view.
  expect(/nav\[class\*="_panelList"\]\{display:none/.test(styles), 'the navigation must never be hidden').toBe(false)
  // Every shell-chrome rule is scoped to the attribute the entry sets, so leaving the entry
  // gives the shell back untouched.
  const chromeRules = styles.split('\n').filter(line => /_footArea|_widthHandle|_logoRow|_newSession/.test(line) && line.includes('display'))
  expect(chromeRules.length, 'expected shell-chrome rules to exist').toBeGreaterThan(0)
  for (const rule of chromeRules) {
    expect(rule, `unscoped shell-chrome rule: ${rule.slice(0, 80)}`).toMatch(/html\[data-wg-bot-panel="on"\]/)
  }
})

// ---------------------------------------------------------------- A-03 / A-04

it('A-04: the menu gains one workgroup entry, immediately below the group entry', () => {
  const source = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'new-chat.js'), 'utf8')
  const groupLine = source.split(String.fromCharCode(10)).findIndex(line => line.includes("t('Create group chat')"))
  const workgroupLine = source.split(String.fromCharCode(10)).findIndex(line => line.includes("t('Create workgroup chat')"))
  expect(groupLine, 'the original group entry must still exist').toBeGreaterThanOrEqual(0)
  expect(workgroupLine, 'the workgroup entry must exist').toBeGreaterThanOrEqual(0)
  // "Directly below" is the requirement, so the two pushes are adjacent statements with nothing
  // pushed between them. A comment line is allowed; another `options.push` is not.
  const between = source.split(String.fromCharCode(10)).slice(groupLine + 1, workgroupLine)
  const pushedBetween = between.filter(line => line.includes('options.push('))
  expect(pushedBetween, `something was pushed between them: ${pushedBetween.join(' | ')}`).toEqual([])
})

it('A-04: the workgroup entry appears only when a Hub is configured', () => {
  const source = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'new-chat.js'), 'utf8')
  // The entry is gated on a prop rather than on a global, so a plain-plugin install — where no
  // Hub exists — keeps upstream's menu exactly as it was.
  expect(source).toMatch(/if \(workgroups !== undefined\) \{/)
  // The adapter is chosen in `index.js` from the Hub adapter's own availability, not a constant.
  // The runtime behaviour — that availability turns true only after the Host confirms a Hub, and
  // that it can change while a window is open — is covered by a11-hub-provider.spec.ts. What is
  // checked here is only that this module reads that reactive flag rather than freezing a value.
  const indexSource = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'index.js'), 'utf8')
  expect(indexSource).toMatch(/const workgroupsNow = \(\) => \(workgroupHub\.available \? \{/)
  expect(indexSource).toMatch(/hubBridge\.view\.subscribe\(\(\) => \{ workgroups\.set\(workgroupsNow\(\)\) \}\)/)
  // And the original group entry is not behind any Hub gate.
  const groupLine = source.split(String.fromCharCode(10)).find(line => line.includes("t('Create group chat')"))
  expect(groupLine).toBeDefined()
  expect(groupLine.includes('workgroups')).toBe(false)
})

it('A-04: both menu labels are in the shipped bundle, with their Chinese copy', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  expect(bundle.includes('Create group chat'), 'the original label is still shipped').toBe(true)
  expect(bundle.includes('Create workgroup chat'), 'the workgroup label is shipped').toBe(true)
  expect(bundle.includes('创建工作群聊'), 'the workgroup label has Chinese copy').toBe(true)
  // The original Chinese copy must not have been reused for the new entry: two adjacent rows
  // reading the same words in Chinese would be indistinguishable.
  expect(bundle.includes('新建群聊'), 'the original group copy is unchanged').toBe(true)
})

it('A-03: a workgroup is rendered through the team’s own room components', () => {
  const source = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'workgroup.js'), 'utf8')
  // Reuse is the requirement, so the module must mount the team's own settings form and avatar
  // rather than define a second version of either.
  expect(source).toMatch(/import \{ GroupSettingsForm \} from '\.\/group-settings\.js'/)
  expect(source).toMatch(/import \{ RoomAvatar \} from '\.\/mark\.js'/)
  expect(source, 'the settings view must be the group settings form').toMatch(/h\(GroupSettingsForm, \{/)
  // And it must not carry the local-group affordances, which would imply a workgroup is local.
  expect(source.includes('createRoom('), 'the view must not create local rooms').toBe(false)
  expect(source.includes("call('"), 'the view must not call the host: everything arrives through props').toBe(false)
})

it('A-03: the workgroup view and its labels are in the shipped bundle', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  for (const marker of ['bt-wg-thread', 'bt-wg-message', 'bt-wg-members', 'bt-wg-compose', 'bt-wg-tasks']) {
    expect(bundle.includes(marker), `${marker} must be in the shipped bundle`).toBe(true)
  }
  // The task strip's approve/reject are the only actions the view offers, and they exist because a
  // workgroup's approval is per-person.
  expect(bundle.includes('data-wg-approve')).toBe(true)
  expect(bundle.includes('data-wg-reject')).toBe(true)
})

it('A-03/A-04: the workgroup surface keeps the Hub boundary visible in the module contract', () => {
  const source = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'client', 'workgroup.js'), 'utf8')
  // The one sentence a reader must not miss: this module renders, and the only module that acts on
  // a task is `bot-adapter`, behind the local policy check.
  expect(source).toMatch(/no code path from an inbound frame/)
  // Session ids are namespaced, so a Hub room and a local room can never collide on one id. The
  // rule itself lives in `src/shared/`: both halves of the plugin have to agree on the string, so
  // the module that owns it is the one both halves import. This module re-exports it, and the
  // assertion follows it there rather than pinning a copy that could drift from the Host's.
  const identity = readFileSync(join(repoRoot, 'packages', 'bundle', 'ds-bot', 'src', 'shared', 'workgroup-session.js'), 'utf8')
  expect(identity).toMatch(/return `wg:\$\{roomId\}`/)
  expect(source).toMatch(/from '\.\.\/shared\/workgroup-session\.js'/)
})

it('the activation gate is armed before it is read', () => {
  const source = readFileSync(clientSource, 'utf8')
  const callIndex = source.indexOf('  registerBotPanel()')
  const gateIndex = source.indexOf('!panelRegistered) return')
  expect(callIndex, 'the entry registration must be called').toBeGreaterThanOrEqual(0)
  expect(gateIndex, 'the activation gate must exist').toBeGreaterThanOrEqual(0)
  // The gate reads a flag the registration sets. An effect that ran first would subscribe with
  // the flag still false and never look again, which showed up as a surface that never switched.
  expect(callIndex, 'registerBotPanel() must run before the activation effect').toBeLessThan(gateIndex)
  expect(source, 'the flag must be declared').toMatch(/let panelRegistered = false/)
  expect(source, 'the flag must be set by the registration').toMatch(/panelRegistered = true/)
})
})
