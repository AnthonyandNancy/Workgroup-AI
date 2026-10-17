import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { install } from '../../../packages/bundle/ds-bot/src/host/workgroup-hub.js'

function temporaryPath(prefix, name) {
  return join(mkdtempSync(join(tmpdir(), prefix)), name)
}

function response(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

function runtime({ hubUrl = 'https://initial.example', hubStatePath, hubConfigPath } = {}) {
  return {
    config: { hubUrl, hubStatePath, hubConfigPath },
    dshHome: join(tmpdir(), 'workgroup-host-adapter-home'),
    version: 'test',
    warn: vi.fn(),
  }
}

describe('the Host workgroup adapter', () => {
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
      bytes: new Uint8Array([1, 2, 3]),
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
})
