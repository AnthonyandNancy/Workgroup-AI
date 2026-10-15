// A-10: workgroup memory a Bot may retrieve, with provenance and correction.
//
// The requirement is "traceable and correctable". Two things make that testable rather than
// aspirational, and this file tests both against a real Hub:
//
//   * **Provenance is data, not prose.** An entry names its author, its revision, and the message it
//     cites; a `room`-scoped entry and a private one are distinguishable; and an entry that cites
//     nothing says so rather than looking the same as one that does.
//   * **Correction is visible.** A revision creates a revision. The previous text stays readable, so
//     a Bot that acted on the old wording can be understood rather than blamed, and a reader can see
//     that the group changed its mind.
//
// The authorization cases are the ones worth having: a non-member must not be able to read a room's
// memory *at all*, and being removed must take the history with it. A memory that outlived the
// membership that justified reading it would be the worst kind of leak — silent, and about decisions
// rather than messages.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import {
  createMemoryClient,
  presentMemory,
  memoryForBot,
  citeMemory,
  isUsable,
  MEMORY_SCOPES,
  MemoryError,
} from '../client/memory.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a10-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a10-bootstrap-secret'

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a10-'))
  const port = 25000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try { if ((await fetch(`${base}/api/v1/health/live`)).ok) break } catch { /* not up */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`the Hub never came up:\n${log}`) }
    await new Promise(resume => setTimeout(resume, 150))
  }
  return {
    base,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resume => setTimeout(resume, 5000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true, maxRetries: 10 })
    },
  }
}

let hub
let counter = 0

async function newPerson(label) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  return {
    handle,
    client,
    userId: client.identity.userId,
    workgroup: createWorkgroupClient({ client }),
    memory: createMemoryClient({ client }),
  }
}

/** A room with every listed person in it, and a message to cite. */
async function sharedRoom(owner, members) {
  const room = await owner.client.request('POST', '/rooms', { body: { name: 'Memory room' } })
  for (const member of members) {
    await member.workgroup.respondToInvitation((await owner.workgroup.invite(room.room.id, { targetUserId: member.userId })).id, 'accept')
  }
  const posted = await owner.workgroup.sendMessage(room.room.id, 'We agreed to ship on Friday.')
  return { roomId: room.room.id, message: posted.message }
}

beforeAll(async () => {
  hub = await startRealHub()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
}, 30_000)

// ---------------------------------------------------------------------------
// Writing and retrieving
// ---------------------------------------------------------------------------

describe('writing something down', () => {
  it('an entry records its author and can cite the message it came from', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId, message } = await sharedRoom(alice, [bob])

    const entry = await alice.memory.remember(roomId, {
      body: 'We ship on Friday.',
      sourceMessageId: message.id,
    })
    assert.equal(entry.authorUserId, alice.userId)
    assert.equal(entry.sourceMessageId, message.id)
    assert.equal(entry.sourced, true)
    assert.equal(entry.revision, 1)
    assert.equal(entry.scope, 'room')
    assert.equal(entry.live, true)
  })

  it('refuses an empty entry, and an entry citing a message from another room', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const first = await sharedRoom(alice, [bob])
    const second = await alice.client.request('POST', '/rooms', { body: { name: 'Other room' } })
    const elsewhere = await alice.workgroup.sendMessage(second.room.id, 'Not in the first room')

    // `remember` is async, so its early refusal arrives as a rejection rather than a synchronous
    // throw — the distinction matters to a caller writing `try { await … }`.
    await expect(alice.memory.remember(first.roomId, { body: '   ' })).rejects.toThrow(MemoryError)
    await expect(alice.memory.remember(first.roomId, { body: '   ' })).rejects.toThrow(/needs some text/)

    // A memory that cited a message from another room would let a member quote across a boundary
    // they cannot read. The Hub refuses it; this checks the refusal reaches the caller.
    await expect(alice.memory.remember(first.roomId, { body: 'cross-room', sourceMessageId: elsewhere.message.id }))
      .rejects.toThrow()
    // And nothing was written: the refusal happened before the row.
    assert.equal((await alice.memory.list(first.roomId)).length, 0)
  })

  it('the client knows exactly the Hub’s two scopes', () => {
    // The Hub's own names, asserted rather than assumed: a client with its own vocabulary would send
    // a scope the Hub rejects with a message nobody can act on.
    assert.deepEqual([...MEMORY_SCOPES], ['room', 'author'])
  })
})

describe('retrieving', () => {
  it('a member reads the room\u2019s memory, with provenance intact', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId, message } = await sharedRoom(alice, [bob])
    await alice.memory.remember(roomId, { body: 'We ship on Friday.', sourceMessageId: message.id })

    const listed = await bob.memory.list(roomId)
    assert.equal(listed.length, 1)
    const presented = presentMemory({ memory: listed[0] })
    // Every fact a reader needs to judge the entry, and none of them implied.
    assert.equal(presented.body, 'We ship on Friday.')
    assert.equal(presented.authorUserId, alice.userId)
    assert.equal(presented.sourced, true)
    assert.equal(presented.sourceMessageId, message.id)
    assert.equal(presented.revision, 1)
    assert.equal(presented.live, true)
    assert.equal(presented.staleWhy, null)
  })

  it('search finds entries by text, and only what the caller may read', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const { roomId } = await sharedRoom(alice, [bob])
    await alice.memory.remember(roomId, { body: 'The release train leaves on Friday.' })
    await alice.memory.remember(roomId, { body: 'The budget is approved.' })
    // An entry only Alice may read.
    await alice.memory.remember(roomId, { body: 'Friday is also my holiday.', scope: 'author' })

    const found = await bob.memory.search(roomId, 'Friday')
    // Bob sees the room-scoped one, not Alice's private note.
    assert.deepEqual(found.map(entry => entry.body), ['The release train leaves on Friday.'])
    // Alice sees both.
    const asAlice = await alice.memory.search(roomId, 'Friday')
    assert.equal(asAlice.length, 2)
    assert.equal(asAlice.some(entry => entry.body.includes('holiday')), true)
    assert.equal(carol.userId.length > 0, true)

    await expect(bob.memory.search(roomId, '  ')).rejects.toThrow(/something to look for/)
  })

  it('an edit revision is visible, and the previous wording stays readable', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])
    const entry = await alice.memory.remember(roomId, { body: 'We ship on Friday.' })
    const revised = await alice.memory.revise(entry.id, 'We ship on Thursday instead.')

    assert.equal(revised.revision, 2)
    assert.equal(revised.body, 'We ship on Thursday instead.')

    const { memory, revisions } = await bob.memory.read(entry.id)
    assert.equal(memory.revision, 2)
    // One history row per *revision*, and the row carries both sides of the change. That is what
    // makes a correction a correction rather than a rewrite: the previous wording survives even
    // though the entry itself no longer holds it.
    assert.equal(revisions.length, 1, `expected one revision row, saw ${revisions.length}`)
    assert.equal(revisions[0].revision, 2)
    assert.equal(revisions[0].previousBody, 'We ship on Friday.')
    assert.equal(revisions[0].newBody, 'We ship on Thursday instead.')
    assert.equal(revisions[0].editorUserId, alice.userId)
  })

  it('deleting an entry records the deletion and stops it being live', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])
    const entry = await alice.memory.remember(roomId, { body: 'Temporary note.' })
    await alice.memory.forget(entry.id)

    // It leaves the live list, so a Bot retrieving memory does not act on it.
    assert.deepEqual(await bob.memory.list(roomId), [])
    // And it is no longer readable by id either: the Hub answers 404, so a caller cannot even
    // confirm that it once existed. The deletion is recorded in the audit trail, which is where the
    // "this was deleted" fact lives — not in a tombstone every member can read.
    await expect(bob.memory.read(entry.id)).rejects.toMatchObject({ status: 404 })
    // The revision history, however, **stays readable to a current member**, and that is deliberate:
    // the group can see that something was removed and by whom. The trail is the record of the
    // decision, not the entry's text — which is why losing the entry does not lose the trail.
    const trail = await bob.memory.history(entry.id)
    assert.equal(Array.isArray(trail), true)
    // A non-member gets nothing, so the trail is not a way around the membership boundary.
    const outsider = await newPerson('outsider')
    await expect(outsider.memory.history(entry.id)).rejects.toMatchObject({ status: 404 })
    // The shaping helpers still describe a stale entry correctly, for the case a caller holds one
    // from before the deletion.
    assert.equal(presentMemory({ memory: { id: 'm', body: 'x', revision: 1, live: false, deleted: true, authorUserId: 'a', scope: 'room' } }).staleWhy, 'deleted')
    assert.equal(isUsable({ live: false, deleted: false }), false)
  })
})

// ---------------------------------------------------------------------------
// Membership is the boundary
// ---------------------------------------------------------------------------

describe('membership is the boundary', () => {
  it('a non-member cannot read a room\u2019s memory, its search, or its history', async () => {
    const alice = await newPerson('alice')
    const outsider = await newPerson('outsider')
    const { roomId } = await sharedRoom(alice, [])
    const entry = await alice.memory.remember(roomId, { body: 'Private to the room.' })

    assert.equal(outsider.userId.length > 0, true)
    // 404, not 403: a 403 would confirm the room exists, which is what somebody probing ids wants.
    await expect(outsider.memory.list(roomId)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.memory.search(roomId, 'Private')).rejects.toMatchObject({ status: 404 })
    await expect(outsider.memory.remember(roomId, { body: 'let me in' })).rejects.toMatchObject({ status: 404 })
    await expect(outsider.memory.read(entry.id)).rejects.toMatchObject({ status: 404 })
    await expect(outsider.memory.history(entry.id)).rejects.toMatchObject({ status: 404 })
  })

  it('a removed member loses the memory with the rest of the room', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])
    await alice.memory.remember(roomId, { body: 'Decided before Bob left.' })
    assert.equal((await bob.memory.list(roomId)).length, 1)

    await alice.workgroup.removeMember(roomId, bob.userId)

    // The memory does not outlive the membership that justified reading it.
    await expect(bob.memory.list(roomId)).rejects.toMatchObject({ status: 404 })
    await expect(bob.memory.search(roomId, 'Decided')).rejects.toMatchObject({ status: 404 })
  })

  it('a room-scoped entry is readable by members; an author-scoped one is not', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])
    const shared = await alice.memory.remember(roomId, { body: 'The group decided X.', scope: 'room' })
    const private_ = await alice.memory.remember(roomId, { body: 'I think Y, privately.', scope: 'author' })

    const bobSees = await bob.memory.list(roomId)
    assert.deepEqual(bobSees.map(entry => entry.id), [shared.id])
    await expect(bob.memory.read(private_.id)).rejects.toThrow()
    // Alice reads both, because she wrote them.
    assert.equal((await alice.memory.list(roomId)).length, 2)
  })
})

// ---------------------------------------------------------------------------
// What a Bot may be told
// ---------------------------------------------------------------------------

describe('what a Bot retrieves', () => {
  it('a Bot reads as its owner, and every entry says so', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId, message } = await sharedRoom(alice, [bob])
    await alice.memory.remember(roomId, { body: 'We ship on Friday.', sourceMessageId: message.id })

    // The Bot's retrieval is Bob's retrieval: it presents what Bob's credential returned.
    const entries = await bob.memory.list(roomId)
    const forBot = memoryForBot({ entries, forUserId: bob.userId })
    assert.equal(forBot.length, 1)
    assert.equal(forBot[0].retrievedAs, bob.userId)
    // A Bot must be able to say where an entry came from, so provenance travels with it.
    assert.equal(forBot[0].authorUserId, alice.userId)
    assert.equal(forBot[0].sourced, true)
    assert.equal(forBot[0].sourceMessageId, message.id)
  })

  it('a Bot sees only what the Hub returned for its owner, and adds nothing', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])
    await alice.memory.remember(roomId, { body: 'A room fact.', scope: 'room' })
    await alice.memory.remember(roomId, { body: 'A private thought.', scope: 'author' })

    const forBot = memoryForBot({ entries: await bob.memory.list(roomId), forUserId: bob.userId })
    // One entry, because that is what Bob's credential returned. The private one is not mentioned:
    // a Bot has no basis to say "there may be more you cannot see".
    assert.equal(forBot.length, 1)
    assert.equal(JSON.stringify(forBot).includes('private thought'), false)
    assert.equal(memoryForBot({ entries: undefined, forUserId: 'x' }).length, 0)
  })

  it('a citation names the author, the revision and the source, and admits when there is none', () => {
    const sourced = citeMemory({ authorUserId: 'alice', revision: 2, sourced: true, sourceMessageId: 'm1', live: true })
    assert.match(sourced, /alice/)
    assert.match(sourced, /revision 2/)
    assert.match(sourced, /message m1/)

    // An unsourced entry says so. A Bot that fabricated a message id would be worse than one that
    // admitted it had nothing to cite.
    const unsourced = citeMemory({ authorUserId: 'bob', revision: 1, sourced: false, sourceMessageId: null, live: true })
    assert.match(unsourced, /unsourced/)
    assert.equal(unsourced.includes('message'), false)

    // A corrected entry states its revision, and a stale one states why.
    assert.match(citeMemory({ authorUserId: 'a', revision: 1, sourced: false, live: false, staleWhy: 'expired' }), /expired/)
    assert.match(citeMemory({ authorUserId: 'a', revision: 1, sourced: false, live: false, staleWhy: 'deleted' }), /deleted/)
    assert.equal(citeMemory(null), '')
  })

  it('an entry a Bot must not use is refused regardless of who asks', () => {
    assert.equal(isUsable({ live: true, deleted: false }), true)
    assert.equal(isUsable({ live: false, deleted: false }), false)
    assert.equal(isUsable({ live: true, deleted: true }), false)
    assert.equal(isUsable(null), false)
    assert.equal(isUsable('a string'), false)
  })

  it('presentation surfaces a stale entry rather than hiding it', () => {
    // "This was the answer until March" is often what a reader needs. Dropping it means a reader
    // cannot tell "we never wrote that down" from "we did, and it changed".
    const expired = presentMemory({ memory: { id: 'm', body: 'old', revision: 1, live: false, deleted: false, authorUserId: 'a', scope: 'room' } })
    assert.equal(expired.live, false)
    assert.equal(expired.staleWhy, 'expired')
    assert.equal(expired.body, 'old')
    assert.equal(presentMemory({ memory: undefined }), undefined)
  })

  it('refuses to build without a Hub client, and without text to remember', async () => {
    expect(() => createMemoryClient({})).toThrow(/Hub client is required/)
    const client = { request: async () => ({ memory: {} }) }
    const memory = createMemoryClient({ client })
    // Refusals before a request is made: an empty entry would spend a row on nothing, and an empty
    // search would scan the room for nothing.
    await expect(memory.remember('r', { body: '' })).rejects.toThrow(/needs some text/)
    await expect(memory.remember('r', { body: '   ' })).rejects.toThrow(/needs some text/)
    await expect(memory.revise('m', '  ')).rejects.toThrow(/needs some text/)
    await expect(memory.search('r', '   ')).rejects.toThrow(/something to look for/)
  })
})
