// A-20: the Host publishes its local Bot team to the Hub directory.
//
// Task 6's product gap was not a missing route but a missing caller: only tests ever sent
// `POST /bots`, so a real install never put the Bots this machine runs into anyone's directory.
// These cases drive the real `install()`/`hubEndpoint` path — the same one the browser reaches
// through `/api/bot` — and assert the directory protocol itself:
//
//   * a Bot is published before its first presence report, with only public fields;
//   * a local rename becomes a second `POST /bots`, a deletion a `withdraw`;
//   * presence repeats on the Hub's TTL cadence and stops with the session, a Hub switch, or
//     plugin disposal;
//   * a refusing directory only warns: the local team and the other Hub endpoints keep working.
//
// The Hub is scripted rather than spawned, because every assertion here is about which requests
// this Host makes and with what body. `a12` owns the real-process proof that those routes work,
// and `a13` owns the rest of the adapter's real-path regression.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { BOT_HEARTBEAT_MS, BOT_SYNC_DEBOUNCE_MS, install } from '../../../packages/bundle/ds-bot/src/host/workgroup-hub.js'
import { createHubBridge, createWorkgroupHub } from '../../../packages/bundle/ds-bot/src/client/workgroup-hub.js'

import { recycleTestPath } from './recycle.mjs'

const API_ROOT = 'https://initial.example/api/v1'

const temporaryRoots: string[] = []
function temporaryRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}
// One recycled tree per case, and the recycle runs PowerShell on Windows: a whole file's worth in
// one hook would exceed the default timeout.
afterAll(() => { for (const root of temporaryRoots.splice(0)) recycleTestPath(root) }, 120_000)
afterEach(() => {
  // A case that fails before sign-out must not leave a faked clock or a scripted transport behind
  // for the next one.
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}

function errorResponse(status: number, payload: unknown) {
  return { ok: false, status, json: async () => payload }
}

interface RecordedRequest {
  url: string
  method: string
  body: string | undefined
}

/** Script the Hub transport, recording every request the Host makes. */
function scriptedHub(handler: (request: RecordedRequest) => unknown) {
  const requests: RecordedRequest[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      url: String(url),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? init.body : undefined,
    }
    requests.push(request)
    return handler(request)
  })
  return requests
}

function pathOf(url: string) {
  return url.replace(API_ROOT, '')
}

function loginPayload() {
  return {
    user: { id: 'user-1', userHandle: 'alice', displayName: 'Alice', status: 'active' },
    device: { id: 'device-1', label: 'test', platform: 'web', appVersion: 'test' },
    accessToken: 'test-only-access',
    accessTokenExpiresIn: 3_600,
    refreshToken: 'test-only-refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }
}

/** The Hub's directory routes, plus the session routes this Host touches on the way in and out. */
function directoryHandler(request: RecordedRequest) {
  const path = pathOf(request.url)
  if (request.method === 'POST' && path === '/auth/login') return response(loginPayload())
  if (request.method === 'POST' && path === '/auth/logout') return response({})
  if (request.method === 'POST' && path === '/bots') return response({ bot: {} })
  // The owner's own entries, read once per sign-in so a deletion made while this Host was off is
  // withdrawn and a shared visibility survives a rename. Cases that need entries override this.
  if (request.method === 'GET' && path.startsWith('/bots/directory')) return response({ bots: [] })
  if (request.method === 'POST' && path.endsWith('/heartbeat')) return response({ bot: {} })
  if (request.method === 'POST' && path.endsWith('/withdraw')) return response({ bot: {} })
  if (request.method === 'GET' && path === '/rooms') return response({ rooms: [{ id: 'room-1', kind: 'workgroup', name: 'Ops' }] })
  if (request.method === 'GET' && path === '/rooms/room-9/bot-candidates') return response({ bots: [{ botId: 'bot-1', displayName: 'Analyst' }] })
  return errorResponse(500, { error: { code: 'UNSCRIPTED', message: `unscripted ${request.method} ${path}` } })
}

function webSocketStub() {
  class TestWebSocket {
    static OPEN = 1
    static instances: TestWebSocket[] = []
    readyState = TestWebSocket.OPEN
    listeners = new Map<string, (event: unknown) => void>()
    url: string
    options: unknown
    constructor(url: string, options: unknown) {
      this.url = url
      this.options = options
      TestWebSocket.instances.push(this)
    }
    addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, listener) }
    send() {}
    close() { this.readyState = 3 }
  }
  return TestWebSocket
}

/** A persisted session, so `hub-resume` reaches the directory without a login round. */
function seededSession(root: string) {
  const path = join(root, 'hub-session.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    userId: 'user-1',
    userHandle: 'alice',
    displayName: 'Alice',
    deviceId: 'device-1',
    accessToken: 'test-only-access',
    refreshToken: 'test-only-refresh',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }))
  return path
}

/** A local Bot with every private field a real team record carries. */
function privateBot(id: string, name: string) {
  return {
    id,
    name,
    role: 'Analyst',
    instructions: 'PRIVATE-INSTRUCTIONS',
    model: 'private-model',
    sessionId: `session-private-${id}`,
    workDir: 'C:/private-folder',
    capabilities: ['private-tool'],
    segments: [{ sessionId: `segment-private-${id}` }],
  }
}

function runtime({ hubStatePath, dshHome, state = { bots: {} as Record<string, any> }, ctx }: {
  hubStatePath: string
  dshHome: string
  state?: { bots: Record<string, any> }
  ctx?: unknown
}) {
  return {
    config: { hubUrl: 'https://initial.example', hubStatePath },
    dshHome,
    version: 'test',
    warn: vi.fn(),
    state,
    save: vi.fn(async () => undefined),
    ctx,
  }
}

function publishRequests(requests: RecordedRequest[]) {
  return requests.filter(request => request.method === 'POST' && pathOf(request.url) === '/bots')
}

function publishBodies(requests: RecordedRequest[]) {
  return publishRequests(requests).map(request => JSON.parse(request.body ?? '{}'))
}

function heartbeatPaths(requests: RecordedRequest[]) {
  return requests.filter(request => pathOf(request.url).endsWith('/heartbeat')).map(request => pathOf(request.url))
}

/**
 * Let queued promise work finish.
 *
 * The publisher is deliberately fire-and-forget — a directory write must not block the local
 * team — so the cases below settle its chain instead of racing it. No wall-clock waiting is
 * involved: each turn runs the microtasks already queued, and the chain has a fixed shape.
 */
async function settle() {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
}

describe('the Host Bot directory publisher', () => {
  it('publishes each local Bot before its first heartbeat when signing in', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-signin-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst'), 'bot-2': privateBot('bot-2', 'Writer') } }
    const rt = runtime({ hubStatePath: join(root, 'hub-session.json'), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-sign-in', { userHandle: 'alice', password: 'test-only-password', label: 'test' })
    await settle()

    // The directory learns a Bot exists before presence claims it is reachable: a heartbeat for an
    // entry that was never published would be a 404 on the real Hub.
    expect(requests.slice(0, 6).map(request => `${request.method} ${pathOf(request.url)}`)).toEqual([
      'POST /auth/login',
      'GET /bots/directory?ownerUserId=user-1',
      'POST /bots', 'POST /bots/bot-1/heartbeat',
      'POST /bots', 'POST /bots/bot-2/heartbeat',
    ])

    const publishes = publishRequests(requests)
    expect(publishes).toHaveLength(2)
    for (const publish of publishes) {
      // The complete body is the privacy boundary: not a subset of a Bot record, an allowlist.
      expect(Object.keys(JSON.parse(publish.body ?? '{}')).sort()).toEqual(['botId', 'displayName', 'visibility'])
    }
    expect(publishBodies(requests)).toEqual([
      { botId: 'bot-1', displayName: 'Analyst', visibility: 'private' },
      { botId: 'bot-2', displayName: 'Writer', visibility: 'private' },
    ])

    // Nothing private rides along, not even as a value of an allowed key.
    const serialized = requests.map(request => request.body ?? '').join('\n')
    for (const secret of ['private-model', 'session-private', 'segment-private', 'private-folder', 'private-tool', 'PRIVATE-INSTRUCTIONS']) {
      expect(serialized).not.toContain(secret)
    }

    expect(requests.filter(request => pathOf(request.url).endsWith('/heartbeat')).map(request => JSON.parse(request.body ?? '{}')))
      .toEqual([{ state: 'online' }, { state: 'online' }])

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('republishes the new display name after a local rename', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-rename-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    expect(publishBodies(requests)).toHaveLength(1)

    // Renaming commits through `rt.save`; the publisher observes that commit point rather than
    // requiring roster code to know the Hub exists.
    state.bots['bot-1'].name = 'Renamed Analyst'
    await rt.save()
    // The burst is debounced, so the save alone has not written to the Hub yet.
    expect(publishBodies(requests)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(BOT_SYNC_DEBOUNCE_MS)
    await settle()

    const bodies = publishBodies(requests)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual({ botId: 'bot-1', displayName: 'Renamed Analyst', visibility: 'private' })

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('withdraws a Bot deleted while the Host was offline and keeps a shared visibility', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-reconcile-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Renamed Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub((request) => {
      const path = pathOf(request.url)
      if (request.method === 'POST' && path === '/auth/logout') return response({})
      if (request.method === 'GET' && path.startsWith('/bots/directory')) {
        return response({
          bots: [
            // Deleted from the team while this Host was not running.
            { botId: 'gone-1', displayName: 'Gone', visibility: 'private' },
            // Still here, shared with the owner's workgroups, and renamed since.
            { botId: 'bot-1', displayName: 'Analyst', visibility: 'room' },
          ],
        })
      }
      if (request.method === 'POST' && path === '/bots') return response({ bot: {} })
      if (request.method === 'POST' && path.endsWith('/heartbeat')) return response({ bot: {} })
      if (request.method === 'POST' && path.endsWith('/withdraw')) return response({ bot: {} })
      return errorResponse(500, { error: { code: 'UNSCRIPTED', message: `unscripted ${request.method} ${path}` } })
    })
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()

    const withdrawals = requests.filter(request => pathOf(request.url).endsWith('/withdraw'))
    expect(withdrawals.map(request => pathOf(request.url))).toEqual(['/bots/gone-1/withdraw'])
    // The rename is republished with the visibility the owner chose, not reset to private.
    expect(publishBodies(requests)).toEqual([
      { botId: 'bot-1', displayName: 'Renamed Analyst', visibility: 'room' },
    ])

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('withdraws a deleted Bot and stops heartbeating it', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-delete-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst'), 'bot-2': privateBot('bot-2', 'Writer') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    const initialHeartbeats = heartbeatPaths(requests)

    delete state.bots['bot-2']
    await rt.save()
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DEBOUNCE_MS)
    await settle()

    const withdrawals = requests.filter(request => pathOf(request.url).endsWith('/withdraw'))
    expect(withdrawals.map(request => `${request.method} ${pathOf(request.url)}`)).toEqual(['POST /bots/bot-2/withdraw'])
    // Withdrawal carries no field at all: the owner and the id in the path are the whole request.
    expect(Object.keys(JSON.parse(withdrawals[0].body ?? '{}'))).toEqual([])

    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS)
    await settle()
    const nextHeartbeats = heartbeatPaths(requests).slice(initialHeartbeats.length)
    expect(nextHeartbeats).toEqual(['/bots/bot-1/heartbeat'])

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('records an owner sharing decision and keeps it across a later rename', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-visibility-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()

    await rt.hubEndpoint('hub-set-bot-visibility', { botId: 'bot-1', visibility: 'room' })
    expect(publishBodies(requests).at(-1)).toEqual({ botId: 'bot-1', displayName: 'Analyst', visibility: 'room' })

    state.bots['bot-1'].name = 'Shared Analyst'
    await rt.save()
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DEBOUNCE_MS)
    await settle()
    expect(publishBodies(requests).at(-1)).toEqual({ botId: 'bot-1', displayName: 'Shared Analyst', visibility: 'room' })

    // A visibility this UI does not offer is refused before any request leaves the machine.
    await expect(rt.hubEndpoint('hub-set-bot-visibility', { botId: 'bot-1', visibility: 'public' })).rejects.toThrow()
    expect(publishBodies(requests).at(-1).visibility).toBe('room')

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('repeats heartbeats on the presence cadence and stops them at sign-out', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-heartbeat-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst'), 'bot-2': privateBot('bot-2', 'Writer') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    // The Hub's presence TTL is 90 s, so the Host must report more often than that. One interval is
    // asserted directly rather than sleeping the TTL: the request cadence *is* the behaviour.
    expect(BOT_HEARTBEAT_MS).toBeLessThan(90_000)
    expect(heartbeatPaths(requests)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS)
    await settle()
    expect(heartbeatPaths(requests)).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS)
    await settle()
    expect(heartbeatPaths(requests)).toHaveLength(6)
    // Every round reports presence, never a private state or a stale 'idle' the Hub would reject.
    expect(new Set(requests.filter(request => pathOf(request.url).endsWith('/heartbeat'))
      .map(request => JSON.stringify(JSON.parse(request.body ?? '{}'))))).toEqual(new Set(['{"state":"online"}']))

    await rt.hubEndpoint('hub-sign-out', {})
    const signedOut = heartbeatPaths(requests).length
    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS * 3)
    await settle()
    expect(heartbeatPaths(requests), 'a signed-out Host must not keep reporting presence').toHaveLength(signedOut)
  })

  it('stops the heartbeat when the plugin is disposed', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-dispose-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const disposers: Array<() => void> = []
    const rt = runtime({
      hubStatePath: seededSession(root),
      dshHome: join(root, 'dsh'),
      state,
      ctx: { effect: (callback: () => () => void) => { disposers.push(callback()) } },
    })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)
    expect(disposers).toHaveLength(1)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    expect(heartbeatPaths(requests)).toHaveLength(1)

    for (const dispose of disposers) dispose()
    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS * 2)
    await settle()
    expect(heartbeatPaths(requests), 'a disposed Host must not keep a timer').toHaveLength(1)
  })

  it('stops the heartbeat when the Hub is switched', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-configure-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    expect(heartbeatPaths(requests)).toHaveLength(1)

    await rt.hubEndpoint('hub-configure', { hubUrl: 'https://second.example' })
    expect(rt.hubConfigured).toBe(true)
    // The old Hub session is gone until the next sign-in; its timer must be gone with it.
    expect(rt.hubSignedIn).toBe(false)

    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS * 2)
    await settle()
    expect(heartbeatPaths(requests), 'the previous Hub must receive nothing after a switch').toHaveLength(1)
  })

  it('warns and keeps the Host usable when the directory refuses a publish', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-publish-failure-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(request => {
      const path = pathOf(request.url)
      if (request.method === 'POST' && path === '/bots') {
        return errorResponse(503, { error: { code: 'DIRECTORY_UNAVAILABLE', message: 'directory unavailable' } })
      }
      return directoryHandler(request)
    })
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()

    expect(rt.warn.mock.calls.some(args => String(args[0]).includes('Hub directory'))).toBe(true)
    // No entry means no presence report: the Host does not pretend a refused Bot is online.
    expect(requests.some(request => pathOf(request.url).endsWith('/heartbeat'))).toBe(false)

    // The failure is visible, and it is contained: Hub reads still answer and the local team still
    // saves. A directory outage must never become a local-group outage.
    await expect(rt.hubEndpoint('hub-rooms', {})).resolves.toEqual([{ id: 'room-1', kind: 'workgroup', name: 'Ops' }])
    await expect(rt.save()).resolves.toBeUndefined()
    expect(state.bots['bot-1'].name).toBe('Analyst')

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('warns and keeps the Bot published when a heartbeat fails', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-heartbeat-failure-')
    const state = { bots: { 'bot-1': privateBot('bot-1', 'Analyst') } }
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh'), state })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(request => {
      const path = pathOf(request.url)
      if (request.method === 'POST' && path.endsWith('/heartbeat')) {
        return errorResponse(503, { error: { code: 'PRESENCE_UNAVAILABLE', message: 'presence unavailable' } })
      }
      return directoryHandler(request)
    })
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    expect(heartbeatPaths(requests)).toHaveLength(1)
    expect(rt.warn.mock.calls.some(args => String(args[0]).includes('heartbeat was not recorded'))).toBe(true)

    await vi.advanceTimersByTimeAsync(BOT_HEARTBEAT_MS)
    await settle()
    // A failed heartbeat is retried on the next round, still without failing anything locally.
    expect(heartbeatPaths(requests)).toHaveLength(2)
    expect(rt.warn.mock.calls.filter(args => String(args[0]).includes('heartbeat was not recorded')).length).toBeGreaterThanOrEqual(2)
    // A missing presence update is not a reason to stop being a Hub client or a local team.
    await expect(rt.hubEndpoint('hub-rooms', {})).resolves.toEqual([{ id: 'room-1', kind: 'workgroup', name: 'Ops' }])
    await expect(rt.save()).resolves.toBeUndefined()

    await rt.hubEndpoint('hub-sign-out', {})
  })

  it('forwards room Bot candidates through the authenticated Hub client', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a20-candidates-')
    const rt = runtime({ hubStatePath: seededSession(root), dshHome: join(root, 'dsh') })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(directoryHandler)
    install(rt)

    await rt.hubEndpoint('hub-resume', {})
    await settle()
    const candidates = await rt.hubEndpoint('hub-bot-candidates', { roomId: 'room-9' })

    expect(candidates).toEqual({ bots: [{ botId: 'bot-1', displayName: 'Analyst' }] })
    const last = requests.at(-1)
    expect(last).toMatchObject({ method: 'GET', url: `${API_ROOT}/rooms/room-9/bot-candidates` })
    // A read carries no body, and the Host does not invent a filter the Hub owns.
    expect(last?.body).toBeUndefined()

    await rt.hubEndpoint('hub-sign-out', {})
  })
})

describe('the browser half Bot candidate method', () => {
  it('asks the Host for one room through one bridge call', async () => {
    const calls: Array<{ endpoint: string; payload: unknown }> = []
    const bridge = createHubBridge({
      pollMs: 0,
      callImpl: async (endpoint: string, payload: unknown) => {
        calls.push({ endpoint, payload })
        if (endpoint === 'hub-view') return { configured: true, signedIn: true, state: 'open' }
        if (endpoint === 'hub-bot-candidates') return { bots: [{ botId: 'bot-1' }] }
        throw new Error(`unscripted endpoint ${endpoint}`)
      },
    })
    const hub = createWorkgroupHub({ bridge })
    await bridge.refresh()

    await expect(hub.botCandidates('room-9')).resolves.toEqual({ bots: [{ botId: 'bot-1' }] })
    expect(calls).toContainEqual({ endpoint: 'hub-bot-candidates', payload: { roomId: 'room-9' } })
  })
})
