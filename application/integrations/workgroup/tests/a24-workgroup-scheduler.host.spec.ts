// A-24: scheduled workgroup messages are the Host's promise, not the window's.
//
// The original composer's "+ → Scheduled task" fires even when the chat window is closed, because a
// Host process owns the timer. A workgroup has no local Session to schedule against, so the queue
// lives beside the team's own state and the Host sends a normal Hub message when it is due. These
// cases drive the real install()/hubEndpoint path:
//
//   * a due message is sent with one idempotency id, then removed from the queue;
//   * cancelling removes it without a send;
//   * a refusal keeps the entry with its reason and retries later;
//   * the queue survives a restart, because it is a file and not memory.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULE_RETRY_MS, install } from '../../../packages/bundle/ds-bot/src/host/workgroup-hub.js'

import { recycleTestPath } from './recycle.mjs'

const API_ROOT = 'https://initial.example/api/v1'
const roots: string[] = []
function temporaryRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterAll(() => { for (const root of roots.splice(0)) recycleTestPath(root) }, 120_000)
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}
function errorResponse(status: number, payload: unknown) {
  return { ok: false, status, json: async () => payload }
}
interface Recorded { url: string, method: string, body: string | undefined }

function scriptedHub(handler: (request: Recorded) => unknown) {
  const requests: Recorded[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const request = { url: String(url), method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? init.body : undefined }
    requests.push(request)
    return handler(request)
  })
  return requests
}
const pathOf = (url: string) => url.replace(API_ROOT, '')

function seededSession(root: string, home: string) {
  const session = join(root, 'hub-session.json')
  mkdirSync(dirname(session), { recursive: true })
  writeFileSync(session, JSON.stringify({
    userId: 'user-1', userHandle: 'alice', displayName: 'Alice', deviceId: 'device-1',
    accessToken: 'test-only-access', refreshToken: 'test-only-refresh',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  }))
  mkdirSync(home, { recursive: true })
  return session
}

function runtime({ hubStatePath, home }: { hubStatePath: string, home: string }) {
  return { config: { hubUrl: 'https://initial.example', hubStatePath }, dshHome: home, home, version: 'test', warn: vi.fn(), state: { bots: {} }, save: vi.fn(async () => undefined) }
}

function webSocketStub() {
  class TestWebSocket {
    static OPEN = 1
    readyState = TestWebSocket.OPEN
    listeners = new Map<string, (event: unknown) => void>()
    constructor() {}
    addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, listener) }
    send() {}
    close() { this.readyState = 3 }
  }
  return TestWebSocket
}

function hub(handler?: (request: Recorded) => unknown) {
  return (request: Recorded) => {
    const path = pathOf(request.url)
    if (handler !== undefined) {
      const answered = handler(request)
      if (answered !== undefined) return answered
    }
    if (request.method === 'GET' && path.startsWith('/bots/directory')) return response({ bots: [] })
    if (request.method === 'POST' && path === '/bots') return response({ bot: {} })
    if (request.method === 'POST' && path.endsWith('/heartbeat')) return response({ bot: {} })
    if (request.method === 'GET' && path === '/rooms') return response({ rooms: [] })
    return errorResponse(500, { error: { code: 'UNSCRIPTED', message: `unscripted ${request.method} ${path}` } })
  }
}

async function settle() {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
}

describe('the Host workgroup scheduler', () => {
  it('sends a due message once, with one idempotency id, and removes it', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a24-send-')
    const home = join(root, 'bot')
    const rt = runtime({ hubStatePath: seededSession(root, home), home })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(hub((request) => {
      if (request.method === 'POST' && pathOf(request.url) === '/rooms/room-1/messages') return response({ message: { id: 'm1' } })
      return undefined
    }))
    install(rt)
    await rt.hubEndpoint('hub-resume', {})
    await settle()

    const created = await rt.hubEndpoint('hub-schedule-workgroup-message', { roomId: 'room-1', text: 'later', at: Date.now() + 1_000 })
    expect(created.schedules).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    const sends = requests.filter(request => pathOf(request.url) === '/rooms/room-1/messages')
    expect(sends).toHaveLength(1)
    const body = JSON.parse(sends[0].body ?? '{}')
    expect(body.body).toBe('later')
    expect(body.clientMessageId).toBe(created.schedule.clientMessageId)

    const after = await rt.hubEndpoint('hub-workgroup-schedules', {})
    expect(after.schedules).toEqual([])
  })

  it('cancels without sending', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a24-cancel-')
    const home = join(root, 'bot')
    const rt = runtime({ hubStatePath: seededSession(root, home), home })
    vi.stubGlobal('WebSocket', webSocketStub())
    const requests = scriptedHub(hub())
    install(rt)
    await rt.hubEndpoint('hub-resume', {})
    await settle()

    const created = await rt.hubEndpoint('hub-schedule-workgroup-message', { roomId: 'room-1', text: 'never', at: Date.now() + 1_000 })
    const cancelled = await rt.hubEndpoint('hub-cancel-workgroup-schedule', { id: created.schedule.id })
    expect(cancelled.schedules).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(requests.filter(request => pathOf(request.url) === '/rooms/room-1/messages')).toHaveLength(0)
  })

  it('keeps a refused message with its reason and retries it later', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a24-retry-')
    const home = join(root, 'bot')
    const rt = runtime({ hubStatePath: seededSession(root, home), home })
    vi.stubGlobal('WebSocket', webSocketStub())
    let refuse = true
    const requests = scriptedHub(hub((request) => {
      if (request.method === 'POST' && pathOf(request.url) === '/rooms/room-1/messages') {
        return refuse
          ? errorResponse(503, { error: { code: 'UNAVAILABLE', message: 'Hub is down' } })
          : response({ message: { id: 'm1' } })
      }
      return undefined
    }))
    install(rt)
    await rt.hubEndpoint('hub-resume', {})
    await settle()

    await rt.hubEndpoint('hub-schedule-workgroup-message', { roomId: 'room-1', text: 'retry me', at: Date.now() + 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()

    const kept = await rt.hubEndpoint('hub-workgroup-schedules', {})
    expect(kept.schedules).toHaveLength(1)
    expect(kept.schedules[0].lastError).toMatch(/Hub is down/)

    refuse = false
    await vi.advanceTimersByTimeAsync(SCHEDULE_RETRY_MS)
    await settle()
    expect(requests.filter(request => pathOf(request.url) === '/rooms/room-1/messages')).toHaveLength(2)
    expect((await rt.hubEndpoint('hub-workgroup-schedules', {})).schedules).toEqual([])
  })

  it('keeps the queue across a restart', async () => {
    vi.useFakeTimers()
    const root = temporaryRoot('wg-a24-restart-')
    const home = join(root, 'bot')
    const rt = runtime({ hubStatePath: seededSession(root, home), home })
    vi.stubGlobal('WebSocket', webSocketStub())
    scriptedHub(hub())
    install(rt)
    await rt.hubEndpoint('hub-resume', {})
    await settle()
    const created = await rt.hubEndpoint('hub-schedule-workgroup-message', { roomId: 'room-1', text: 'tomorrow', at: Date.now() + 86_400_000 })

    // A second Host instance reads the same file at install; nothing was carried in memory.
    const restarted = runtime({ hubStatePath: join(root, 'hub-session.json'), home })
    install(restarted)
    const listed = await restarted.hubEndpoint('hub-workgroup-schedules', {})
    expect(listed.schedules.map(entry => entry.id)).toEqual([created.schedule.id])
  })
})
