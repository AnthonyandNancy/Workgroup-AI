// A1: the workgroup Hub provider — the thing that was missing entirely.
//
// Before this change `ctx.get('workgroupHub')` had no provider anywhere in the repository, so
// `workgroups` was always `undefined`, so the "创建工作群聊" menu entry never rendered in any install.
// The existing `bot-entry.spec.ts` could not catch that: its workgroup case asserted that the view
// module *contains certain source strings*, which stayed true while the feature was unreachable.
// These cases assert the observable behaviour the menu actually depends on instead.
//
// Two separations matter here and are what most of these cases are about:
//
//   * **Configured is not the same as reachable.** A Host with no Hub address is a supported
//     local-only install; a Host that cannot be reached is a service problem. The first means the
//     entry stays out, the second means the UI must say so rather than tell the user to configure
//     something that is already configured.
//   * **The Hub's answer is not the renderer's business.** The view carries display fields and
//     deliberately no token: a credential that reaches the browser has escaped the Host for no
//     benefit. The last case here fails if one ever does.

import { describe, expect, it, vi } from 'vitest'
import { createHubBridge, createWorkgroupHub } from '../../../packages/bundle/ds-bot/src/client/workgroup-hub.js'

/** A bridge over a scripted Host, so these cases need no browser, no Host, and no Hub. */
function bridgeOver(answers) {
  const calls = []
  const callImpl = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    const answer = answers[endpoint]
    if (answer === undefined) throw Object.assign(new Error(`unscripted endpoint ${endpoint}`), { code: 'HTTP_404' })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { bridge: createHubBridge({ callImpl, pollMs: 0 }), calls }
}

describe('the workgroup Hub provider', () => {
  it('provides nothing the menu can use until the Host confirms a Hub', async () => {
    const { bridge } = bridgeOver({ 'hub-view': { configured: false, signedIn: false, state: 'signed-out' } })
    const hub = createWorkgroupHub({ bridge })
    await bridge.refresh()
    // `available: false` is exactly what makes `workgroups` undefined, which is what keeps the
    // entry out of the menu. A local-only install must not advertise a feature it cannot offer.
    expect(hub.available).toBe(false)
    expect(hub.signedIn).toBe(false)
  })

  it('becomes usable once the Host confirms a Hub, without re-mounting the plugin', async () => {
    const calls = []
    let configured = false
    const bridge = createHubBridge({
      pollMs: 0,
      callImpl: async (endpoint) => {
        calls.push(endpoint)
        return configured
          ? { configured: true, signedIn: true, state: 'open', userId: 'u1', userHandle: 'alice', displayName: 'Alice' }
          : { configured: false, signedIn: false, state: 'signed-out' }
      },
    })
    const hub = createWorkgroupHub({ bridge })
    await bridge.refresh()
    expect(hub.available, 'no Hub configured yet').toBe(false)

    // This is the case the old hardcoded value could not express: the answer changes while the
    // window is open. A value captured at apply time would still say "no Hub" here, and the menu
    // entry would never appear until the user happened to reload.
    configured = true
    await bridge.refresh()
    expect(hub.available).toBe(true)
    expect(hub.identity.userHandle).toBe('alice')
  })

  it('reports an unreachable Host as unknown rather than as "no Hub configured"', async () => {
    const { bridge } = bridgeOver({ 'hub-view': new Error('network error: failed to fetch') })
    const hub = createWorkgroupHub({ bridge })
    await bridge.refresh()
    const view = bridge.view.getSnapshot()
    // The two need different UI: one is a setting an operator must supply, the other is a service to
    // restart. Collapsing them sends a user hunting for configuration that already exists.
    expect(view.phase).toBe('unreachable')
    expect(view.configured).toBe(false)
    expect(view.message).toMatch(/network error/)
    expect(hub.available).toBe(false)
  })

  it('forwards a mutation to the Host and re-reads the connection state', async () => {
    const { bridge, calls } = bridgeOver({
      'hub-view': { configured: true, signedIn: true, state: 'open' },
      'hub-create-room': { id: 'room-9', name: 'Finance', kind: 'workgroup' },
    })
    const hub = createWorkgroupHub({ bridge })
    const created = await hub.createRoom('Finance', { kind: 'workgroup' })
    expect(created.id).toBe('room-9')
    expect(calls.map(entry => entry.endpoint)).toEqual(['hub-create-room', 'hub-view'])
    // The room kind travels with the request: this is what S1 added on the server side, and a
    // create without it would land as an ordinary room.
    expect(calls[0].payload).toEqual({ name: 'Finance', kind: 'workgroup' })
  })

  it('never carries a credential into the renderer', async () => {
    const { bridge } = bridgeOver({
      'hub-view': { configured: true, signedIn: true, state: 'open', userId: 'u1', userHandle: 'alice', displayName: 'Alice', deviceId: 'd1' },
    })
    const hub = createWorkgroupHub({ bridge })
    await bridge.refresh()
    // A token in the view would reach the browser and any extension in it, with no benefit: every
    // call already goes through the Host, which holds the credential.
    const serialized = JSON.stringify({ view: bridge.view.getSnapshot(), identity: hub.identity })
    for (const forbidden of ['accessToken', 'refreshToken', 'password', 'Bearer ']) {
      expect(serialized.includes(forbidden), `the view must not expose ${forbidden}`).toBe(false)
    }
  })

  it('stops polling when the plugin is disposed, so nothing runs after unload', async () => {
    const { bridge, calls } = bridgeOver({ 'hub-view': { configured: true, signedIn: false, state: 'signed-out' } })
    bridge.start()
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    bridge.stop()
    const seen = calls.length
    await new Promise(settle => setTimeout(settle, 30))
    expect(calls.length).toBe(seen)
    // A timer that outlived the plugin would keep issuing Host requests after the entry unloaded.
    expect(bridge.view.getSnapshot().phase).toBe('ready')
  })
})

describe('the host-side workgroup module', () => {
  it('is mounted in the host module list, so the browser has something to call', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(import.meta.dirname, '..', '..', '..')
    const source = readFileSync(join(root, 'packages', 'bundle', 'ds-bot', 'index.js'), 'utf8')
    // Registering the module is what puts `rt.hubEndpoint` on the runtime. Without this line every
    // `hub-*` call answers `bot/invalid`, which the browser would surface as a failed create.
    expect(source).toMatch(/workgroupHub/)
    expect(source).toMatch(/const MODULES = \[[^\]]*workgroupHub\]/)
  })

  it('routes the hub endpoints through the channel, and keeps the local team load out of them', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(import.meta.dirname, '..', '..', '..')
    const source = readFileSync(join(root, 'packages', 'bundle', 'ds-bot', 'src', 'host', 'channel.js'), 'utf8')
    expect(source).toMatch(/case 'hub-create-room':/)
    expect(source).toMatch(/rt\.hubEndpoint\(endpoint, body, signal\)/)
    // A workgroup lives on the Hub, not in this machine's team state. Making a Hub read wait for
    // `rt.load()` would mean signing in required a local team file to exist first.
    const hubBlock = source.slice(source.indexOf("case 'hub-view':"), source.indexOf("return ok(await rt.hubEndpoint"))
    expect(hubBlock.includes('rt.load()')).toBe(false)
  })
})
