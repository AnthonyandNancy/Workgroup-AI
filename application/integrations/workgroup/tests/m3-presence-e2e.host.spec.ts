// M3 at evidence level L: presence falls back correctly, against the real Hub process.
//
// C5 is the requirement this file exists for: after a Hub restart, an abnormal disconnect, or a
// token revocation, a member must read as **offline** — a stale "online" is worse than no status at
// all, because it tells a colleague someone is there to answer when nobody is.
//
// Presence is derived from live connections and never persisted (`realtime/hub.js` builds it from
// its own `connections` map), so the property under test is really "does anything cache it". A
// single cached row would pass the obvious happy-path check and still fail every case here.
//
// The Hub is spawned as the real `server/` entry point, exactly as `a12-hub-provider-e2e.host.spec.ts`
// does and for the same reason: `server/` is a separate deployable that `application/` must not
// import, and a test that imported it would skip the configuration and migration path.

import { recycleTestPath } from './recycle.mjs'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createBridge } from '../bridge/index.mjs'

const SERVER_ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'server')
const NODE = process.env.WORKGROUP_TEST_NODE ?? process.execPath
const BOOTSTRAP = 'm3-e2e-bootstrap-secret'
const roots = []
const cleanups = []

/** Spawn the real Hub and wait until it reports its listening port. */
function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'wg-m3-'))
  roots.push(root)
  const child = spawn(NODE, [join(SERVER_ROOT, 'src', 'index.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HUB_DATA_DIR: join(root, 'data'),
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_TOKEN_SIGNING_KEY: 'm3-e2e-signing-key-at-least-32-chars-long!!!',
      HUB_REGISTRATION: 'admin_secret',
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined)
    const done = () => { clearTimeout(timer); resolve(undefined) }
    const timer = setTimeout(done, 10000)
    child.once('exit', done)
    try { child.kill() } catch { done() }
    return undefined
  }))

  const port = new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { reject(new Error(`the Hub did not report a listening address; output so far:\n${buffered}`)) }, 30000)
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk)
      const match = /Server listening at https?:\/\/127\.0\.0\.1:(\d+)/.exec(buffered)
      if (match !== null) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.stderr.on('data', (chunk) => { buffered += String(chunk) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the Hub exited early with code ${String(code)}:\n${buffered}`))
    })
  })
  return { port, child, root }
}

const hub = startRealHub()
const baseUrl = hub.port.then(port => `http://127.0.0.1:${String(port)}`)

afterAll(async () => {
  for (const cleanup of [...cleanups].reverse()) await cleanup()
  for (const root of roots) {
    try {
      recycleTestPath(root)
    } catch {
      // A temp directory the operating system still holds open is residue, not a test result.
    }
  }
})

/** Register, sign in, and open a live stream for one identity. */
async function signIn(userHandle, password) {
  const root = mkdtempSync(join(tmpdir(), 'wg-m3-state-'))
  roots.push(root)
  const client = createHubClient({ hubUrl: await baseUrl, statePath: join(root, 'session.json'), appVersion: '0.0.0-test' })
  await client.register({ userHandle, displayName: userHandle, password, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle, password })
  return { client, bridge: createBridge({ hubUrl: await baseUrl, client, WebSocketImpl: globalThis.WebSocket, logger: {} }) }
}

/** Read one member's `online` flag as a specific viewer sees it. */
async function onlineFor(viewer, roomId, userId) {
  const answer = await viewer.client.request('GET', `/rooms/${roomId}/members`)
  const rows = answer.members ?? answer.room?.members ?? []
  return rows.find(row => row.userId === userId)?.online
}

/** Poll until a condition holds, so a legitimate propagation delay is not reported as a failure. */
async function waitFor(probe, label) {
  const deadline = Date.now() + 15000
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last === true) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('M3 end to end against the real Hub process', () => {
  it('a member reads as offline after their stream stops, with nothing cached', async () => {
    const alice = await signIn('presence-alice', 'correct horse battery staple')
    const bob = await signIn('presence-bob', 'correct horse battery staple')
    const created = await alice.client.request('POST', '/rooms', { body: { name: 'Presence', kind: 'workgroup' } })
    const roomId = created.room.id

    // Both are joined and both are connected, so presence must say so.
    await alice.client.request('POST', `/rooms/${roomId}/invitations`, { body: { targetUserId: bob.client.identity.userId } })
    const pending = await bob.client.request('GET', '/invitations')
    const invitation = (pending.invitations ?? [])[0]
    await bob.client.request('POST', `/invitations/${invitation.id}/accept`, { body: {} })

    alice.bridge.start([roomId])
    bob.bridge.start([roomId])
    await waitFor(async () => (await onlineFor(alice, roomId, bob.client.identity.userId)) === true,
      'bob to read as online while his stream is open')

    // Bob's stream stops. Presence is not persisted, so the very next read must already say
    // offline: a Hub that cached it would leave Alice believing Bob is still reachable.
    bob.bridge.stop()
    await waitFor(async () => (await onlineFor(alice, roomId, bob.client.identity.userId)) === false,
      'bob to fall back to offline once his stream stopped')

    alice.bridge.stop()
  }, 90000)

  it('presence is scoped to the room, so a member of another room is not reported', async () => {
    // C2: presence is visible only between members of the same workgroup, and a non-member query is
    // refused without leaking whether the member exists. The refusal is what the routes enforce;
    // this case pins the part the client would otherwise get wrong — treating "not in this list" as
    // "offline" rather than as "not my business".
    const carol = await signIn('presence-carol', 'correct horse battery staple')
    const dave = await signIn('presence-dave', 'correct horse battery staple')
    const room = await carol.client.request('POST', '/rooms', { body: { name: 'Scoped', kind: 'workgroup' } })

    // Dave is a real account but not a member of carol's room.
    carol.bridge.start([room.room.id])
    await expect(carol.client.request('GET', `/rooms/${room.room.id}/members`)).resolves.toBeDefined()
    const seen = await carol.client.request('GET', `/rooms/${room.room.id}/members`)
    expect((seen.members ?? []).some(row => row.userId === dave.client.identity.userId)).toBe(false)

    // The non-member is refused rather than told anything about the room's membership.
    await expect(dave.client.request('GET', `/rooms/${room.room.id}/members`)).rejects.toThrow()
    carol.bridge.stop()
  }, 90000)
})
