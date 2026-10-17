import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { install } from '../../../packages/bundle/ds-bot/src/host/workgroup-hub.js'

import { recycleTestPath } from './recycle.mjs'

const temporaryRoots = []
function temporaryPath(prefix, name) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return join(root, name)
}
// The recycle runs PowerShell on Windows, and this file now leaves a tree per case: a whole
// file's worth in one hook exceeds the default hook timeout.
afterAll(() => { for (const root of temporaryRoots.splice(0)) recycleTestPath(root) }, 60_000)

function response(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

function runtime({ hubUrl = 'https://initial.example', hubStatePath, hubConfigPath, dshHome = join(tmpdir(), 'workgroup-host-adapter-home'), ctx } = {}) {
  return {
    config: { hubUrl, hubStatePath, hubConfigPath },
    dshHome,
    version: 'test',
    warn: vi.fn(),
    ctx,
  }
}

function errorResponse(status, payload) {
  return { ok: false, status, json: async () => payload }
}

function webSocketStub() {
  class TestWebSocket {
    static OPEN = 1
    static instances = []
    readyState = TestWebSocket.OPEN
    listeners = new Map()
    constructor(url, options) {
      this.url = url
      this.options = options
      TestWebSocket.instances.push(this)
    }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    send() {}
    close() { this.readyState = 3 }
  }
  return TestWebSocket
}

describe('the Host workgroup adapter', () => {
  it('bootstraps one guest session for concurrent hub-view calls and redacts credentials', async () => {
    const hubStatePath = temporaryPath('wg-host-guest-', 'hub-session.json')
    const dshHome = temporaryPath('wg-host-guest-home-', 'dsh')
    const requests = []
    vi.stubGlobal('WebSocket', webSocketStub())
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/auth/bootstrap')) {
        return response({
          user: { id: 'guest-user', userHandle: 'guest-abcd', displayName: 'Guest ABCD', status: 'active' },
          device: { id: 'guest-device', label: 'DSH Bot', platform: 'web', appVersion: 'test' },
          accessToken: 'host-only-access',
          refreshToken: 'host-only-refresh',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath, dshHome })
    install(rt)
    const views = await Promise.all([rt.hubEndpoint('hub-view'), rt.hubEndpoint('hub-view')])

    expect(views[0]).toMatchObject({ configured: true, signedIn: true, userHandle: 'guest-abcd' })
    expect(views[1]).toMatchObject({ configured: true, signedIn: true, userHandle: 'guest-abcd' })
    expect(requests.filter(request => request.url.endsWith('/auth/bootstrap'))).toHaveLength(1)
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      installationId: expect.any(String), deviceLabel: 'DSH Bot', platform: 'web', appVersion: 'test',
    })
    expect(JSON.stringify(views)).not.toContain('host-only')

    const installation = JSON.parse(readFileSync(join(dshHome, 'workgroup', 'installation.json'), 'utf8'))
    expect(Object.keys(installation).sort()).toEqual(['appVersion', 'hubUrl', 'installationId'])
    expect(installation).toMatchObject({ hubUrl: 'https://initial.example/api/v1', appVersion: 'test' })
    expect(installation.installationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(hubStatePath, 'utf8')).not.toContain('installationId')
  })

  it('keeps the provider unavailable when guest bootstrap cannot reach the Hub', async () => {
    const hubStatePath = temporaryPath('wg-host-offline-', 'hub-session.json')
    const dshHome = temporaryPath('wg-host-offline-home-', 'dsh')
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })

    const rt = runtime({ hubStatePath, dshHome })
    install(rt)
    await expect(rt.hubEndpoint('hub-view')).resolves.toMatchObject({
      configured: true, signedIn: false, state: 'unavailable',
    })
  })

  it('resumes a persisted guest session and refreshes it without bootstrapping again', async () => {
    const hubStatePath = temporaryPath('wg-host-resume-', 'hub-session.json')
    const dshHome = temporaryPath('wg-host-resume-home-', 'dsh')
    writeFileSync(hubStatePath, JSON.stringify({
      userId: 'guest-user', userHandle: 'guest-old', displayName: 'Guest Old', deviceId: 'guest-device',
      accessToken: 'old-access', refreshToken: 'old-refresh',
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }))
    const requests = []
    vi.stubGlobal('WebSocket', webSocketStub())
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/auth/refresh')) {
        return response({
          accessToken: 'refreshed-access',
          accessTokenExpiresIn: 3_600,
          refreshToken: 'refreshed-refresh',
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath, dshHome })
    install(rt)
    const view = await rt.hubEndpoint('hub-view')

    expect(view).toMatchObject({ configured: true, signedIn: true, userHandle: 'guest-old' })
    expect(requests.filter(request => request.url.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(requests.filter(request => request.url.endsWith('/auth/bootstrap'))).toHaveLength(0)
  })

  it('replaces a guest session after refresh failure while retaining installation identity', async () => {
    const hubStatePath = temporaryPath('wg-host-rebootstrap-', 'hub-session.json')
    const dshHome = temporaryPath('wg-host-rebootstrap-home-', 'dsh')
    mkdirSync(join(dshHome, 'workgroup'), { recursive: true })
    const installationPath = join(dshHome, 'workgroup', 'installation.json')
    writeFileSync(installationPath, JSON.stringify({
      installationId: '44444444-4444-4444-8444-444444444444',
      hubUrl: 'https://initial.example/api/v1',
      appVersion: 'test',
    }))
    writeFileSync(hubStatePath, JSON.stringify({
      userId: 'guest-old', userHandle: 'guest-old', displayName: 'Guest Old', deviceId: 'old-device',
      accessToken: 'expired-access', refreshToken: 'revoked-refresh',
      accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }))
    const requests = []
    vi.stubGlobal('WebSocket', webSocketStub())
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/auth/refresh')) return errorResponse(401, { error: { code: 'REFRESH_TOKEN_REVOKED', message: 'revoked' } })
      if (String(url).endsWith('/auth/bootstrap')) {
        return response({
          user: { id: 'guest-new', userHandle: 'guest-new', displayName: 'Guest New', status: 'active' },
          device: { id: 'new-device', label: 'DSH Bot', platform: 'web', appVersion: 'test' },
          accessToken: 'replacement-access',
          refreshToken: 'replacement-refresh',
          accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath, dshHome })
    install(rt)
    const view = await rt.hubEndpoint('hub-view')

    expect(view).toMatchObject({ configured: true, signedIn: true, userHandle: 'guest-new' })
    expect(requests.filter(request => request.url.endsWith('/auth/refresh'))).toHaveLength(1)
    expect(requests.filter(request => request.url.endsWith('/auth/bootstrap'))).toHaveLength(1)
    expect(JSON.parse(readFileSync(installationPath, 'utf8'))).toEqual({
      installationId: '44444444-4444-4444-8444-444444444444',
      hubUrl: 'https://initial.example/api/v1',
      appVersion: 'test',
    })
  })
  it('publishes Bridge events through the existing DSH event channel', async () => {
    const hubStatePath = temporaryPath('wg-host-events-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      userId: 'u1',
      userHandle: 'alice',
      displayName: 'Alice',
      deviceId: 'device-1',
      accessToken: 'test-only-access-token',
      refreshToken: 'test-only-refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }))
    const published = []
    vi.stubGlobal('fetch', async (url) => {
      const value = String(url)
      if (value.endsWith('/rooms/room-1')) return response({ room: { id: 'room-1', name: 'Ops' }, members: [] })
      if (value.endsWith('/rooms/room-1/messages?afterSeq=0&limit=200')) return response({ messages: [], hasMore: false })
      if (value.endsWith('/rooms/room-1/messages?limit=200')) return response({ messages: [], nextAfterSeq: 0 })
      if (value.endsWith('/rooms/room-1/tasks')) return response({ tasks: [] })
      throw new Error(`unexpected request ${value}`)
    })
    class TestWebSocket {
      static OPEN = 1
      static instances = []
      readyState = 0
      listeners = new Map()
      constructor() { TestWebSocket.instances.push(this) }
      addEventListener(type, listener) { this.listeners.set(type, listener) }
      send() {}
      close() {}
      emit(type, event) { this.listeners.get(type)?.(event) }
    }
    vi.stubGlobal('WebSocket', TestWebSocket)
    const rt = runtime({
      hubStatePath,
      ctx: { emit: (name, event) => { published.push({ name, event }) } },
    })
    install(rt)
    try {
      await rt.hubEndpoint('hub-open-room', { roomId: 'room-1' })
      const socket = TestWebSocket.instances?.at(-1)
      expect(socket).toBeDefined()
      socket.readyState = TestWebSocket.OPEN
      socket.emit('open')
      await rt.hubEndpoint('hub-open-room', { roomId: 'room-1' })
      expect(TestWebSocket.instances).toHaveLength(1)
      const event = {
        schemaVersion: 'wg.v1',
        eventId: 'event-1',
        type: 'presence.changed',
        roomId: 'room-1',
        payload: { userId: 'u2', online: true },
      }
      socket.emit('message', { data: JSON.stringify(event) })
      await vi.waitFor(() => expect(published).toEqual([{ name: 'workgroup/event', event }]))
    } finally {
      await rt.hubEndpoint('hub-sign-out', {})
    }
  })

  it('configures the Hub, persists only its URL, and returns a safe registration result', async () => {
    const hubStatePath = temporaryPath('wg-host-state-', 'hub-session.json')
    const hubConfigPath = temporaryPath('wg-host-config-', 'hub-config.json')
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      if (String(url).endsWith('/auth/config')) {
        return response({ protocol: 'wg.v1', registrationMode: 'admin_secret', handlePolicy: { minLength: 3 } })
      }
      if (String(url).endsWith('/auth/register')) {
        return response({ user: { id: 'u1', userHandle: 'bob', displayName: 'Bob' } })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath, hubConfigPath })
    install(rt)

    const configured = await rt.hubEndpoint('hub-configure', { hubUrl: 'https://configured.example' })
    const registered = await rt.hubEndpoint('hub-register', {
      userHandle: 'bob',
      displayName: 'Bob',
      password: 'test-only-password',
      bootstrapSecret: 'test-only-bootstrap',
    })

    expect(configured.configured).toBe(true)
    expect(configured.hubUrl).toBe('https://configured.example/api/v1')
    expect(configured.signedIn).toBe(false)
    expect(JSON.parse(readFileSync(hubConfigPath, 'utf8'))).toEqual({ hubUrl: 'https://configured.example/api/v1' })
    expect(registered).toEqual({ user: { userId: 'u1', userHandle: 'bob', displayName: 'Bob' } })
    expect(JSON.stringify(configured)).not.toContain('test-only')
    expect(JSON.stringify(registered)).not.toContain('test-only')
    expect(requests.map(request => request.url)).toEqual([
      'https://configured.example/api/v1/auth/config',
      'https://configured.example/api/v1/auth/register',
    ])
  })

  it('lists rooms through the authenticated Hub client without exposing session fields', async () => {
    const hubStatePath = temporaryPath('wg-host-rooms-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token',
      userId: 'u1',
      userHandle: 'alice',
      displayName: 'Alice',
      deviceId: 'device-1',
    }))
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).endsWith('/rooms')) {
        return response({ rooms: [{ id: 'room-1', kind: 'workgroup', name: 'Ops' }] })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath })
    install(rt)
    const rooms = await rt.hubEndpoint('hub-rooms', {})

    expect(rooms).toEqual([{ id: 'room-1', kind: 'workgroup', name: 'Ops' }])
    expect(JSON.stringify(rooms)).not.toContain('test-only-access-token')
  })

  it('forwards owner dissolution and artifact uploads through the authenticated integration client', async () => {
    const hubStatePath = temporaryPath('wg-host-artifact-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token',
      userId: 'u1',
      userHandle: 'alice',
      displayName: 'Alice',
      deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
      if (String(url).endsWith('/rooms/room-1/dissolve')) return response({ dissolved: true, roomId: 'room-1' })
      if (String(url).includes('/rooms/room-1/artifacts?')) return response({ artifact: { id: 'artifact-1', fileName: 'report.txt' } })
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath })
    install(rt)
    const dissolved = await rt.hubEndpoint('hub-dissolve', { roomId: 'room-1' })
    const uploaded = await rt.hubEndpoint('hub-upload-artifact', {
      roomId: 'room-1',
      fileName: 'report.txt',
      bytes: [1, 2, 3],
      contentType: 'text/plain',
      recipients: ['u2'],
    })

    expect(dissolved).toEqual({ dissolved: true, roomId: 'room-1' })
    expect(uploaded).toEqual({ artifact: { id: 'artifact-1', fileName: 'report.txt' } })
    expect(requests.map(request => request.url)).toEqual([
      'https://initial.example/api/v1/rooms/room-1/dissolve',
      'https://initial.example/api/v1/rooms/room-1/artifacts?fileName=report.txt&recipients=u2',
    ])
    expect(requests[1].method).toBe('POST')
    expect(requests[1].headers['content-type']).toBe('text/plain')
    expect(Array.from(requests[1].body)).toEqual([1, 2, 3])
  })

  it('forwards reply, mention, attachment, and idempotency fields through hub-send', async () => {
    const hubStatePath = temporaryPath('wg-host-send-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token',
      userId: 'u1',
      userHandle: 'alice',
      displayName: 'Alice',
      deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      if (String(url).endsWith('/rooms/room-1/messages')) {
        return response({ message: { id: 'm2', body: 'ask the Bot' } })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath })
    install(rt)
    await rt.hubEndpoint('hub-send', {
      roomId: 'room-1',
      text: 'ask the Bot',
      clientMessageId: 'client-1',
      replyToMessageId: 'm1',
      mentions: [{ userId: 'owner-1', botId: 'bot-1' }],
      attachments: [{ artifactId: 'artifact-1' }],
    })

    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0].body)).toEqual({
      clientMessageId: 'client-1',
      body: 'ask the Bot',
      replyToMessageId: 'm1',
      mentions: [{ userId: 'owner-1', botId: 'bot-1' }],
      attachments: [{ artifactId: 'artifact-1' }],
    })
  })
  it('forwards owner task decisions to the versioned decision route with one validated scope', async () => {
    const hubStatePath = temporaryPath('wg-host-decision-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token',
      userId: 'owner-1',
      userHandle: 'owner',
      displayName: 'Owner',
      deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      if (String(url).endsWith('/tasks/task-1/decision')) return response({ task: { id: 'task-1', state: 'APPROVED' } })
      throw new Error(`unexpected request ${String(url)}`)
    })

    const rt = runtime({ hubStatePath })
    // The folder guard the Host installs (src/host/folders.js) resolves and approves a real path.
    // It is stubbed here because only the wiring is under test; the guard's own refusals are proven
    // against the real filesystem in `A07`/`F12` and in `hub-approve-task` below.
    rt.cleanWorkDir = vi.fn(async input => (input === 'approved-dir' ? '/real/approved-dir' : undefined))
    install(rt)

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const result = await rt.hubEndpoint('hub-approve-task', {
      taskId: 'task-1',
      decision: 'approve',
      expectedVersion: 3,
      mode: 'existing_bot',
      botId: 'bot-1',
      workDir: 'approved-dir',
      tools: ['read'],
      recipients: ['requester-1'],
      expiresAt,
    })

    // The integration client builds the body once, so the Host does not rename a field on the way.
    expect(result).toEqual({ id: 'task-1', state: 'APPROVED' })
    expect(rt.cleanWorkDir).toHaveBeenCalledWith('approved-dir')
    expect(requests).toEqual([{
      url: 'https://initial.example/api/v1/tasks/task-1/decision',
      method: 'POST',
      body: JSON.stringify({
        decision: 'approve',
        expectedVersion: 3,
        assignmentMode: 'existing_bot',
        assignedBotId: 'bot-1',
        approvedScope: {
          mode: 'existing_bot',
          assignedBotId: 'bot-1',
          workDir: '/real/approved-dir',
          tools: ['read'],
          recipients: ['requester-1'],
          expiresAt,
        },
      }),
    }])
  })

  it('forwards owner review decisions to the three review routes with their own payloads', async () => {
    const hubStatePath = temporaryPath('wg-host-review-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token', userId: 'owner-1', userHandle: 'owner', displayName: 'Owner', deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      for (const action of ['keep', 'reject', 'share']) {
        if (String(url).endsWith(`/tasks/task-1/${action}`)) return response({ task: { id: 'task-1', state: action === 'reject' ? 'FAILED' : 'COMPLETED' } })
      }
      throw new Error(`unexpected request ${String(url)}`)
    })
    const rt = runtime({ hubStatePath })
    install(rt)

    await rt.hubEndpoint('hub-review-task', { taskId: 'task-1', decision: 'keep', expectedVersion: 4 })
    await rt.hubEndpoint('hub-review-task', { taskId: 'task-1', decision: 'reject', expectedVersion: 5 })
    await rt.hubEndpoint('hub-review-task', { taskId: 'task-1', decision: 'share', expectedVersion: 6, recipients: ['requester-1'] })

    expect(requests.map(entry => entry.url.replace('https://initial.example/api/v1', ''))).toEqual([
      '/tasks/task-1/keep', '/tasks/task-1/reject', '/tasks/task-1/share',
    ])
    // `keep` and `reject` publish nothing, so they carry no recipients; `share` names them.
    expect(requests.map(entry => JSON.parse(entry.body))).toEqual([
      { expectedVersion: 4 },
      { expectedVersion: 5 },
      { expectedVersion: 6, recipients: ['requester-1'] },
    ])
    // The same refusal the Hub makes happens here first, so an unnamed share is never sent.
    await expect(rt.hubEndpoint('hub-review-task', { taskId: 'task-1', decision: 'share', expectedVersion: 7, recipients: [] }))
      .rejects.toThrow(/named recipient/)
    expect(requests).toHaveLength(3)
  })

  it('forwards a cancellation to the Hub cancel route for the caller the Hub authenticates', async () => {
    const hubStatePath = temporaryPath('wg-host-cancel-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token', userId: 'u2', userHandle: 'requester', displayName: 'Requester', deviceId: 'device-2',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      if (String(url).endsWith('/tasks/task-1/cancel')) return response({ task: { id: 'task-1', state: 'CANCELLED' } })
      throw new Error(`unexpected request ${String(url)}`)
    })
    const rt = runtime({ hubStatePath })
    install(rt)
    const result = await rt.hubEndpoint('hub-cancel-task', { taskId: 'task-1' })
    expect(result.task.state).toBe('CANCELLED')
    // The caller is the authenticated device, never a field in the body: a requester cannot cancel
    // as somebody else by naming them.
    expect(requests).toEqual([{
      url: 'https://initial.example/api/v1/tasks/task-1/cancel',
      method: 'POST',
      body: JSON.stringify({}),
    }])
  })

  it('refuses an approval whose folder is missing or resolves to the default workspace', async () => {
    const hubStatePath = temporaryPath('wg-host-decision-refusal-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token', userId: 'owner-1', userHandle: 'owner', displayName: 'Owner', deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      throw new Error(`unexpected request ${String(url)}`)
    })
    const rt = runtime({ hubStatePath })
    // `cleanWorkDir` answers `undefined` for the team workspace and throws for an unusable path.
    rt.cleanWorkDir = vi.fn(async input => {
      if (input === '') return undefined
      if (input === 'team') return undefined
      throw new Error(`There is no folder at ${input}`)
    })
    install(rt)
    const common = {
      taskId: 'task-1', decision: 'approve', expectedVersion: 3, mode: 'chief_auto',
      tools: ['read'], recipients: ['requester-1'], expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }
    // Missing, team workspace, and unresolvable all fail closed: no request names a default folder.
    await expect(rt.hubEndpoint('hub-approve-task', common)).rejects.toThrow(/specific folder/)
    await expect(rt.hubEndpoint('hub-approve-task', { ...common, workDir: 'team' })).rejects.toThrow(/specific folder/)
    await expect(rt.hubEndpoint('hub-approve-task', { ...common, workDir: 'missing' })).rejects.toThrow(/no folder/)
    expect(requests).toEqual([])
  })

  it('refuses an approval when the folder guard is unavailable', async () => {
    const hubStatePath = temporaryPath('wg-host-decision-unavailable-', 'hub-session.json')
    writeFileSync(hubStatePath, JSON.stringify({
      accessToken: 'test-only-access-token', userId: 'owner-1', userHandle: 'owner', displayName: 'Owner', deviceId: 'device-1',
    }))
    const requests = []
    vi.stubGlobal('fetch', async (url, init) => { requests.push(String(url)); throw new Error('unexpected request') })
    const rt = runtime({ hubStatePath })
    install(rt)
    await expect(rt.hubEndpoint('hub-approve-task', {
      taskId: 'task-1', decision: 'approve', expectedVersion: 3, mode: 'chief_auto',
      workDir: 'approved-dir', tools: ['read'], recipients: ['requester-1'],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })).rejects.toThrow(/folder guard is unavailable/)
    expect(requests).toEqual([])
  })
})
