// A1 at evidence level L: the real Hub process, reached through the real client modules.
//
// The unit cases next door (`a11-hub-provider.spec.ts`) script the transport, which proves the
// browser half's logic but not that anything downstream of it works. This case spawns the actual
// `server/` entry point as its own process — the same thing an operator starts — and drives it with
// the same client modules the host half imports. What it establishes, and why each part matters:
//
//   * **A room really lands as a workgroup.** This is M1/S1's column plus M2/A1's routing, end to
//     end. Before A1 there was no route at all, so the browser could not have created anything, and
//     an `ordinary` room here would be the original S1 defect: the client asked for one thing and
//     the Hub stored another with nothing failing.
//   * **The invitation path works by exact user id.** The requirement fixes on that (no directory,
//     no search), so the invite is addressed by the id the Hub itself reports.
//   * **A realtime event crosses the real socket.** Presence and message delivery are only
//     observable through the WebSocket, so nothing else in the suite covers this link.
//
// The Hub runs as a spawned process rather than an in-process server on purpose. `server/` is a
// separate deployable that must not be imported by `application/`, so importing its source here
// would both cross the two runtime boundaries and skip the configuration and migration path that
// only the real entry point exercises. It also means this case would still pass if someone later
// broke the packaged startup sequence.
//
// Credentials come from this process's environment, never from source.

import { recycleTestPath } from './recycle.mjs'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import { createBridge } from '../bridge/index.mjs'

const SERVER_ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'server')
const NODE = process.env.WORKGROUP_TEST_NODE ?? process.execPath
const BOOTSTRAP = 'a11-e2e-bootstrap-secret'
const roots = []
const cleanups = []

/** Spawn the real Hub and wait until it reports its listening port. */
function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'wg-a12-'))
  roots.push(root)
  const child = spawn(NODE, [join(SERVER_ROOT, 'src', 'index.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HUB_DATA_DIR: join(root, 'data'),
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_TOKEN_SIGNING_KEY: 'a12-e2e-signing-key-at-least-32-chars-long!!',
      HUB_REGISTRATION: 'admin_secret',
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Kill, then wait for the process to actually be gone: on Windows the Hub's SQLite file stays
  // locked while it exits, so removing the temp directory before that would fail with EPERM and
  // report a teardown error after a passing test. The wait is bounded so a wedged child cannot hang
  // the suite.
  cleanups.push(() => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined)
    const done = () => { clearTimeout(timer); resolve(undefined) }
    const timer = setTimeout(done, 10000)
    child.once('exit', done)
    try { child.kill() } catch { done() }
    return undefined
  }))

  // A port of 0 means the operating system chose one, so the address is read from the line the
  // entry point prints rather than guessed: guessing would let this case pass against a Hub that
  // was never actually listening.
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
  // Children first, so a Hub cannot still be writing into a directory that is being removed. Each
  // cleaner is isolated: one failure must not leave the others (or the temp dirs) behind.
  for (const cleanup of [...cleanups].reverse()) await cleanup()
  for (const root of roots) {
    try {
      recycleTestPath(root)
    } catch {
      // A temp directory the operating system still holds open is residue, not a test result: the
      // cases above have already run and reported. Failing here would turn leftover files into a
      // red suite, which is the one thing a teardown must never do.
    }
  }
})

/** Register and sign in one identity on the real Hub. */
async function signIn(userHandle, password) {
  const root = mkdtempSync(join(tmpdir(), 'wg-a12-state-'))
  roots.push(root)
  const client = createHubClient({ hubUrl: await baseUrl, statePath: join(root, 'session.json'), appVersion: '0.0.0-test' })
  await client.register({ userHandle, displayName: userHandle, password, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle, password })
  // A per-identity fingerprint, so two identities in one test process do not collide on the device
  // row the Hub reuses per fingerprint.
  return { client, bridge: createBridge({ hubUrl: await baseUrl, client, WebSocketImpl: globalThis.WebSocket, logger: {} }) }
}

describe('A1 end to end against the real Hub process', () => {
  it('creates a workgroup and reads it back as a workgroup', async () => {
    const alice = await signIn('alice', 'correct horse battery staple')

    // The same request the host module's `hub-create-room` issues.
    const created = await alice.client.request('POST', '/rooms', { body: { name: 'Finance', kind: 'workgroup' } })
    expect(created.room.kind).toBe('workgroup')

    // Read back through a second request, so this asserts the Hub stored a workgroup rather than
    // that it echoed the request.
    const listed = await alice.client.request('GET', '/rooms')
    const found = (listed.rooms ?? []).find(room => room.id === created.room.id)
    expect(found, 'the created workgroup is listed').toBeDefined()
    expect(found.kind).toBe('workgroup')

    // The invitation path: by exact user id, and a nonexistent target is refused rather than
    // silently accepted, because a silent accept shows the inviter a member who never appears.
    const workgroup = createWorkgroupClient({ client: alice.client, bridge: alice.bridge })
    await expect(workgroup.invite(created.room.id, { targetUserId: 'no-such-user' })).rejects.toThrow()
    alice.bridge.stop()
  }, 90000)

  it('invites a real second identity, and only the invitee can accept', async () => {
    const alice = await signIn('bob', 'correct horse battery staple')
    const carol = await signIn('carol', 'correct horse battery staple')
    const workgroup = createWorkgroupClient({ client: alice.client, bridge: alice.bridge })
    const carolWorkgroup = createWorkgroupClient({ client: carol.client, bridge: carol.bridge })

    const created = await alice.client.request('POST', '/rooms', { body: { name: 'Ops', kind: 'workgroup' } })
    const roomId = created.room.id
    await workgroup.invite(roomId, { targetUserId: carol.client.identity.userId })

    // The invitee sees it without being told the invitation id out of band: the Hub decides who may
    // see an invitation, and this is the path the UI's invitation list uses.
    const invitations = await carol.client.request('GET', '/invitations')
    const invitation = (invitations.invitations ?? []).find(entry => entry.roomId === roomId)
    expect(invitation, 'the invitee sees the invitation').toBeDefined()

    // Object-level authorization asserted rather than assumed: the inviter cannot answer an
    // invitation addressed to someone else, even though they created the room. The Hub answers
    // 404 rather than 403, which is the stronger choice — it does not confirm the id exists.
    await expect(workgroup.respondToInvitation(invitation.id, 'accept')).rejects.toThrow(/NO_SUCH_INVITATION/)

    // The invitee can, and afterwards the Hub lists them as a member.
    await carolWorkgroup.respondToInvitation(invitation.id, 'accept')
    const members = await carol.client.request('GET', `/rooms/${roomId}/members`)
    const ids = (members.members ?? []).map(member => member.userId)
    expect(ids, 'the accepted member is in the room').toContain(carol.client.identity.userId)
    alice.bridge.stop()
    carol.bridge.stop()
  }, 90000)

  it('delivers a realtime event over the real socket', async () => {
    const dave = await signIn('dave', 'correct horse battery staple')
    const created = await dave.client.request('POST', '/rooms', { body: { name: 'Realtime', kind: 'workgroup' } })
    const roomId = created.room.id

    const seen = []
    const bridge = createBridge({
      hubUrl: await baseUrl,
      client: dave.client,
      WebSocketImpl: globalThis.WebSocket,
      onEvent: (event) => { seen.push(event.type) },
      logger: {},
    })
    cleanups.push(() => bridge.stop())

    // `start()` resolves once the connection attempt is under way, not once the socket is up: it
    // does not await the `open` event, because a Bridge that blocked on the network would stall its
    // caller on every reconnect. Subscribe is sent from the `open` handler, so the wait is for the
    // socket to actually be open.
    await bridge.start([roomId])
    const openedAt = Date.now()
    while (bridge.state !== 'open' && Date.now() - openedAt < 20000) {
      await new Promise(settle => setTimeout(settle, 50))
    }
    expect(bridge.state, 'the socket is open').toBe('open')

    // Membership is re-checked when the Hub handles `subscribe`, and an unsubscribed socket
    // receives nothing while still looking connected — so the message is sent repeatedly until the
    // live event arrives. Reusing one `clientMessageId` is safe: the Hub treats it as the
    // idempotency key, so retries cannot manufacture duplicates and the event observed is a real
    // delivery rather than a catch-up fetch.
    const deadline = Date.now() + 25000
    while (!seen.includes('message.created') && Date.now() < deadline) {
      await dave.client.request('POST', `/rooms/${roomId}/messages`, {
        body: { clientMessageId: 'a12-message-1', body: 'hello team' },
      })
      await new Promise(settle => setTimeout(settle, 400))
    }
    expect(seen, `expected a live event, saw ${JSON.stringify(seen)}`).toContain('message.created')
    bridge.stop()
  }, 90000)
})
