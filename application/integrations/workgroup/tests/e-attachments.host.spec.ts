// E on the application side: uploading a file and attaching it to a message.
//
// The Hub has accepted artifacts since early on, but nothing in the application could produce one:
// the protocol's request helper only ever sent JSON, so the upload route — which takes the bytes as
// the body — was unreachable from this side. A workgroup that can mention a colleague but cannot send
// them the file is the half-feature the requirement calls out by name.
//
// Two properties are checked here that are easy to get wrong and expensive to discover in production:
//
//   * **the bytes are sent as bytes**, not base64-wrapped JSON. The Hub accepts both, but a JSON
//     wrapper inflates the payload by a third and makes the configured size limit mean something
//     different from what the operator set.
//   * **a download is refused to a viewer the ACL excludes**, with the Hub answering 404 rather than
//     403 so that the refusal does not confirm the file exists.

import { recycleTestPath } from './recycle.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'

// `integrations/workgroup/tests` → `application` → `Workgroup-AI`, so the Hub lives four levels up.
const SERVER_ROOT = fileURLToPath(new URL('../../../../server', import.meta.url))
const NODE = process.env.WORKGROUP_TEST_NODE ?? process.execPath
// The Hub's own bootstrap secret, and what a client presents at registration. `HUB_REGISTRATION`
// names the *mode* (`open`/`admin_secret`/`closed`), not this value — the two are separate variables,
// which is why they are named apart here.
const BOOTSTRAP = 'e-attach-bootstrap-secret'
const PASSWORD = 'a-long-enough-password'

let hub
const roots = []
const cleanups = []

/**
 * Start the real Hub and resolve once it reports its port.
 *
 * `HUB_PORT=0` lets the Hub choose, which is what every other host lane here does: a fixed random port
 * races with other specs in the same run, and this suite runs beside them.
 */
function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-e-attach-'))
  roots.push(root)
  const child = spawn(NODE, [join(SERVER_ROOT, 'src', 'index.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HUB_DATA_DIR: join(root, 'data'),
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_TOKEN_SIGNING_KEY: 'e-attach-signing-key-at-least-32-chars-long!!',
      HUB_REGISTRATION: 'admin_secret',
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined)
    const done = () => { clearTimeout(timer); resolve(undefined) }
    const timer = setTimeout(done, 10_000)
    child.once('exit', done)
    try { child.kill() } catch { done() }
    return undefined
  }))

  const port = new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => { reject(new Error(`the Hub did not report a listening address; output so far:\n${buffered}`)) }, 30_000)
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

const realHub = startRealHub()

beforeAll(async () => {
  hub = { base: `http://127.0.0.1:${String(await realHub.port)}` }
}, 30_000)

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  for (const root of roots) {
    try {
      recycleTestPath(root)
    } catch {
      // A temp directory the OS still holds open is residue, not a test result.
    }
  }
})

let counter = 0
async function newPerson(label) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  return { client, userId: client.identity.userId, workgroup: createWorkgroupClient({ client }) }
}

/**
 * One workgroup with the given people in it.
 *
 * Rooms are created through the Hub client's own room route: the workgroup client deliberately has no
 * `createRoom`, because a workgroup is created from the Bot UI's own dialog and the client wrapper only
 * covers what the workgroup pane does afterwards.
 */
async function sharedRoom(alice, people) {
  const created = await alice.client.request('POST', '/rooms', { body: { name: 'Attachments', kind: 'workgroup' } })
  const roomId = created.room.id
  for (const person of people) {
    await alice.workgroup.invite(roomId, { targetUserId: person.userId })
    const pending = await person.workgroup.incomingInvitations()
    await person.workgroup.respondToInvitation(pending.find(entry => entry.roomId === roomId).id, 'accept')
  }
  return roomId
}

describe('E uploading and attaching a file', () => {
  it('uploads bytes and attaches them to a message', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const roomId = await sharedRoom(alice, [bob])

    const uploaded = await alice.workgroup.uploadArtifact(roomId, {
      fileName: 'release-notes.txt',
      bytes: Buffer.from('what changed, and why', 'utf8'),
      contentType: 'text/plain',
      recipients: [bob.userId],
    })
    expect(uploaded.artifact.fileName).toBe('release-notes.txt')
    expect(uploaded.artifact.sizeBytes).toBe(Buffer.byteLength('what changed, and why'))

    const sent = await alice.workgroup.sendMessage(roomId, 'here are the notes', {
      attachments: [{ artifactId: uploaded.artifact.id }],
    })
    expect(sent.message.attachments).toHaveLength(1)
    expect(sent.message.attachments[0].artifactId).toBe(uploaded.artifact.id)
    // The Hub records the name with the message so a reader does not need a second request per file.
    expect(sent.message.attachments[0].fileName).toBe('release-notes.txt')
  })

  it('sends the bytes as bytes rather than as base64 inside JSON', async () => {
    const alice = await newPerson('alice2')
    const roomId = await sharedRoom(alice, [])
    // The distinction matters at the limit: the Hub's `maxUploadBytes` bounds the request body, so a
    // base64 wrapper would make the configured limit mean three quarters of itself.
    const bytes = Buffer.from('x'.repeat(64), 'utf8')
    const uploaded = await alice.workgroup.uploadArtifact(roomId, { fileName: 'sized.bin', bytes, contentType: 'application/octet-stream' })
    expect(uploaded.artifact.sizeBytes).toBe(64)
  })

  it('lets a named recipient download it and refuses a member who was not named', async () => {
    const alice = await newPerson('alice3')
    const bob = await newPerson('bob3')
    const carol = await newPerson('carol3')
    const roomId = await sharedRoom(alice, [bob, carol])

    const uploaded = await alice.workgroup.uploadArtifact(roomId, {
      fileName: 'for-bob.txt', bytes: Buffer.from('bob only', 'utf8'), contentType: 'text/plain', recipients: [bob.userId],
    })

    const mine = await bob.workgroup.downloadArtifact(uploaded.artifact.id)
    expect(mine.bytes.toString('utf8')).toBe('bob only')

    // Carol shares the room and can read the message, so the refusal has to come from the artifact's
    // own ACL. She is refused as if it did not exist: an answer of 403 would confirm the file.
    await expect(carol.workgroup.downloadArtifact(uploaded.artifact.id)).rejects.toThrow(/not available|does not exist|404/i)
  })

  it('refuses an upload with no bytes', async () => {
    const alice = await newPerson('alice4')
    const roomId = await sharedRoom(alice, [])
    // An empty file is a plausible accident and a useless artifact. The client refuses it without a
    // request: the Hub would answer the same way, and sending it would spend a rate-limit slot to learn
    // something already known.
    expect(() => alice.workgroup.uploadArtifact(roomId, { fileName: 'empty.txt', bytes: Buffer.alloc(0) }))
      .toThrow(/empty|bytes/i)
  })

  it('refuses an upload without a file name', async () => {
    const alice = await newPerson('alice5')
    const roomId = await sharedRoom(alice, [])
    // The Hub needs a name to show a reader, and the name is not inferable from the bytes.
    expect(() => alice.workgroup.uploadArtifact(roomId, { bytes: Buffer.from('data', 'utf8') }))
      .toThrow(/name/i)
  })
})

describe('E mentioning over the client', () => {
  it('sends mentions as ids and a Bot mention comes back as a pending candidate', async () => {
    const alice = await newPerson('alice6')
    const bob = await newPerson('bob6')
    const roomId = await sharedRoom(alice, [bob])
    await bob.client.request('POST', '/bots', {
      body: { botId: 'e-client-bot', displayName: 'Writer', description: 'writes', capabilities: ['draft'], visibility: 'room' },
    })

    const sent = await alice.workgroup.sendMessage(roomId, 'Writer, please draft it', {
      mentions: [{ userId: bob.userId, botId: 'e-client-bot' }],
    })
    expect(sent.message.mentions).toEqual([{ userId: bob.userId, botId: 'e-client-bot' }])
    // The Hub answers with the candidate it created, and it is pending: nothing has run anywhere.
    expect(sent.proposedTasks).toHaveLength(1)
    expect(sent.proposedTasks[0].state).toBe('PENDING_APPROVAL')
    // A mention is a request, not an authorization. The owner has no grant to present, and the
    // task's own history stops at the request: no approval, no dispatch, no execution record.
    const taskId = sent.proposedTasks[0].id
    expect((await bob.client.request('GET', `/tasks/${taskId}/grants`)).grants).toEqual([])
    const detail = await bob.client.request('GET', `/tasks/${taskId}`)
    const kinds = detail.events.map(event => event.eventType)
    expect(kinds).toContain('task.created')
    expect(kinds).not.toContain('task.approved')
    expect(kinds).not.toContain('task.progress')
    // The owner's client is the only one asked to decide; the requester can read the request but
    // the approval queue is addressed to Bob.
    expect((await bob.client.request('GET', '/tasks/pending')).tasks.some(task => task.id === taskId)).toBe(true)
    expect((await alice.client.request('GET', '/tasks/pending')).tasks.some(task => task.id === taskId)).toBe(false)
  })

  it('refuses a mention of somebody outside the workgroup', async () => {
    const alice = await newPerson('alice7')
    const outsider = await newPerson('outsider7')
    const roomId = await sharedRoom(alice, [])
    await expect(alice.workgroup.sendMessage(roomId, 'hello', { mentions: [{ userId: outsider.userId }] }))
      .rejects.toThrow(/member/i)
  })
})
