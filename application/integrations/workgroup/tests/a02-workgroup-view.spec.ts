// A-02 / WP-A0: entering a workgroup Session shows the workgroup interface.
//
// The audit that opened this round found the view written but unreachable: `WorkgroupView` was
// exported and imported by nothing, `isWorkgroupSession` had zero call sites, and a
// `wg:<roomId>` Session rendered as an empty conversation. Nothing failed loudly — the component
// was green in the tests that asserted its source, while no employee could ever see it.
//
// So these cases assert the wiring instead of the component, and they take the two routes that
// can observe it:
//
//   * identity and routing are decided by a module with no imports of its own, called directly.
//     It is the same module the built client uses, so a divergence here is a real one;
//   * the plugin's own `apply` runs against the fake shell for the registration, because a module
//     that exports the right function and registers nothing is exactly the defect being fixed.
//
// The pane module itself is deliberately not imported: it reaches the team's own settings and
// sidebar components, whose `@deepseek-ai/dsh-client-ui-primitives` dependency resolves in the
// built bundle but not in a test process. The registration is compared by the component's
// identity to what the bundle exports, which pins the same fact without that resolution.
//
// What is deliberately NOT asserted is the rendered markup: that proof is the real-browser check
// in `application/tests/`, because the pane reads the Hub through the Host and no fake of that
// path would be evidence of it.

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { loadClientPlugin, fakeShell } from '../../ds-bot/tests/apply-harness.mjs'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const bundlePath = join(repoRoot, 'packages', 'bundle', 'ds-bot', 'client.js')

// The client modules read browser globals at module scope, so the harness installs them before
// the import below resolves.
const loaded = loadClientPlugin(bundlePath)
loaded.stopTimers()
const { isWorkgroupSession, mainSessionId, mainWorkgroupSession, needsHomeFallback, workgroupSessionId } =
  await import('../../../packages/bundle/ds-bot/src/shared/workgroup-session.js')

/** The shell's Session list as the pane reads it: entries keyed by id, claiming the main view. */
const mainView = id => ({ byId: { [id]: { id, retainedBy: { mainView: 1 } } }, ids: [id] })
const ORDINARY = '3f0c2b18-9a1e-4a2f-9a4e-2b6f0c1d5e77'

describe('a workgroup Session is recognized by its identity', () => {
  it('tells a workgroup apart from an ordinary Session and a local group chat', () => {
    expect(isWorkgroupSession(workgroupSessionId('room-1'))).toBe(true)
    // An ordinary Bot Session, and a local group chat — which is also an ordinary Session —
    // keep their own rendering.
    expect(isWorkgroupSession(ORDINARY)).toBe(false)
    expect(isWorkgroupSession(undefined)).toBe(false)
  })

  it('finds the workgroup the main view is showing, and only that one', () => {
    const sessionId = workgroupSessionId('room-1')
    expect(mainWorkgroupSession(mainView(sessionId))).toBe(sessionId)
    expect(mainWorkgroupSession(mainView(ORDINARY))).toBeUndefined()
    expect(mainWorkgroupSession({ byId: {}, ids: [] })).toBeUndefined()
  })

  it('reads the main Session the way the shell does, from the retained reference', () => {
    // Recovery after a reload goes through the same read: nothing was clicked and nothing was
    // passed down, so the retained reference is the only thing that names what is on screen.
    expect(mainSessionId(mainView(ORDINARY))).toBe(ORDINARY)
    expect(mainSessionId({ byId: {}, ids: [] })).toBeUndefined()
  })

  it('does not bounce a workgroup back to the Main Bot as an unknown Session', () => {
    // A workgroup Session is never in the team's roster — it lives on the Hub — so without this
    // exception the shell's fallback would warm up the Main Bot and the workgroup would vanish.
    const roster = { byId: {}, roomsById: {} }
    expect(needsHomeFallback(roster, workgroupSessionId('room-1'))).toBe(false)
    expect(needsHomeFallback(roster, ORDINARY)).toBe(true)
    expect(needsHomeFallback(roster, undefined)).toBe(false)
    // A Bot's Session and a local room are still recognized as belonging to this team.
    expect(needsHomeFallback({ byId: { 'session-a': {} }, roomsById: {} }, 'session-a')).toBe(false)
    expect(needsHomeFallback({ byId: {}, roomsById: { 'room-a': {} } }, 'room-a')).toBe(false)
  })
})

describe('the client plugin mounts the pane', () => {
  it('registers the workgroup pane, so it is reachable at all', () => {
    const shell = fakeShell()
    loaded.module.apply(shell.ctx)
    // The pane lives in the shell group, which is installed only while the Bot panel is the active
    // view. Choosing the panel is the same call the sidebar row makes, so the registrations below
    // are the ones a user's click produces, not a special test-only install path.
    shell.layout.selectPanel('conversation')
    loaded.stopTimers()
    const entry = shell.registrations.find(registration =>
      registration.options.name === 'shell.overlay' && registration.options.id === 'bot-workgroup')
    expect(entry, 'the workgroup pane must be registered on shell.overlay').toBeDefined()
    // The registered component is the pane itself: a wrapper registered while the pane sat
    // unreferenced is the defect this case exists for.
    expect(entry?.component?.name).toBe('WorkgroupPane')
    // Its inject face carries the panel's own hook source, so the mounted pane reads the Hub
    // adapter this plugin provides over `POST /api/bot` — a pane that opened its own connection
    // could not be given this one.
    const props = entry?.options.inject?.()
    expect(props?.hooks?.workgroups, 'the pane reads workgroup state through a reactive source').toBeDefined()
    expect(typeof props.hooks.workgroups.subscribe).toBe('function')
    // The Hub's connection state is injected the same way. Without it the pane could only ever say
    // "no Hub" or show the room, and a Hub that dropped mid-session would look like a quiet one.
    expect(props?.hooks?.hub, 'the pane reads the Hub connection state through a reactive source').toBeDefined()
    expect(typeof props.hooks.hub.subscribe).toBe('function')
  })

  it('does not register a second main.conversation, which ui-conversation owns', () => {
    const shell = fakeShell()
    loaded.module.apply(shell.ctx)
    loaded.stopTimers()
    const conversations = shell.registrations.filter(registration => registration.options.name === 'main.conversation')
    expect(conversations.length, 'main.conversation stays with ui-conversation').toBe(0)
  })
})
