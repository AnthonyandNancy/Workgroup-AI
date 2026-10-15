// A-06: the owner's approval card and the three dispatch modes.
//
// The blocking requirement is "**only B** decides, on B's own device". Two machines are not
// available (Q-01), so this file proves every layer below the chassis: two independent Hub clients,
// each with its own device, its own token, and its own real WebSocket, against a real Hub. What that
// covers is the authorization — which is the whole requirement — and what it cannot cover is a
// second physical keyboard.
//
// The negatives are the point of this task, so each is a case of its own:
//
//   * a non-owner cannot decide anything, not even to reject (the Hub owns this rule; the client's
//     `reducePending` makes it visible rather than being the enforcement)
//   * an approval that names no scope is refused rather than approving "whatever"
//   * `existing_bot` without a Bot is refused at the form *and* by the Hub
//   * a decision drawn from a stale card is refused, so two devices cannot both approve
//   * a `chief_auto` task still waits for the owner: the Chief choosing a Bot is not the Chief
//     approving the task
//
// The dispatch modes are asserted to be the Hub's own three names, because a client with its own
// vocabulary would produce requests the Hub rejects with a message nobody can act on.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createBridge } from '../bridge/index.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import {
  createApprovalClient,
  approvalChoices,
  approvalScope,
  isMineToDecide,
  reducePending,
  taskStateLabel,
  ASSIGNMENT_MODES,
  MEMBER_ROLES,
} from '../client/approvals.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a06-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a06-bootstrap-secret'

async function loadWebSocket() {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const resolved = createRequire(import.meta.url).resolve('ws', { paths: [resolve(APP_ROOT, 'apps', 'web')] })
  const module = await import(pathToFileURL(resolved).href)
  return module.default ?? module.WebSocket
}

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a06-'))
  const port = 22000 + Math.floor(Math.random() * 900)
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
let WebSocketImpl
let counter = 0

async function newPerson(label, { publishBot } = {}) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  const person = {
    handle,
    client,
    userId: client.identity.userId,
    workgroup: createWorkgroupClient({ client }),
  }
  person.approvals = createApprovalClient({ client, selfUserId: person.userId })
  if (publishBot !== undefined) {
    await client.request('POST', '/bots', { body: { botId: publishBot, displayName: publishBot, role: 'Worker', visibility: 'public' } })
  }
  return person
}

/** A room with `requester` and `owner` in it. */
async function roomWith(requester, owner) {
  const room = await requester.client.request('POST', '/rooms', { body: { name: 'Approval room' } })
  const invitation = await requester.workgroup.invite(room.room.id, { targetUserId: owner.userId })
  await owner.workgroup.respondToInvitation(invitation.id, 'accept')
  return room.room.id
}

/** Ask `owner` to do something in `roomId`, as `requester`. */
async function ask(requester, roomId, owner, description, targetBotId) {
  const created = await requester.client.request('POST', `/rooms/${roomId}/tasks`, {
    body: { ownerUserId: owner.userId, description, ...(targetBotId === undefined ? {} : { targetBotId }) },
  })
  return created.task
}

async function waitFor(predicate, { timeout = 15_000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resume => setTimeout(resume, interval))
  }
}

beforeAll(async () => {
  hub = await startRealHub()
  WebSocketImpl = await loadWebSocket()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
}, 30_000)

// ---------------------------------------------------------------------------
// Only the owner decides
// ---------------------------------------------------------------------------

describe('only the person being asked decides', () => {
  it('the request waits for the owner and grants nothing until they answer', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)

    const task = await ask(alice, roomId, bob, 'Draft the release notes', 'writer')
    assert.equal(task.state, 'PENDING_APPROVAL')

    // Nothing is granted yet: the state is the whole gate, and it is the Hub's.
    const mine = await bob.approvals.pending()
    assert.deepEqual(mine.map(entry => entry.id), [task.id])
    // The owner may look at their own grants, and there are none.
    assert.deepEqual((await bob.approvals.grants(task.id)).grants, [])
  })

  it('the requester cannot approve their own request, and neither can a third member', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const carol = await newPerson('carol')
    const roomId = await roomWith(alice, bob)
    await carol.workgroup.respondToInvitation((await alice.workgroup.invite(roomId, { targetUserId: carol.userId })).id, 'accept')

    const task = await ask(alice, roomId, bob, 'Something Bob must decide')
    // Even a rejection: a non-owner answering at all would let a room kill somebody's task.
    for (const person of [alice, carol]) {
      await expect(person.approvals.decide({
        taskId: task.id, decision: 'reject', expectedVersion: task.version,
      })).rejects.toThrow(/owner/i)
    }
    // And it is still Bob's to decide.
    assert.deepEqual((await bob.approvals.pending()).map(entry => entry.id), [task.id])
  })

  it('a room admin cannot approve on the owner\u2019s behalf either', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    // Alice created the room, so she is its owner and an admin. That still does not let her decide
    // Bob's task: room authority and personal approval are different things.
    const task = await ask(alice, roomId, bob, 'Bob decides this one')
    await expect(alice.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'chief_auto' }))
      .rejects.toThrow(/owner/i)
    assert.equal((await bob.approvals.task(task.id)).task.state, 'PENDING_APPROVAL')
  })

  it('the owner sees the request over their own socket, and the whole room learns it happened', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)

    const aliceEvents = []
    const aliceBridge = createBridge({ hubUrl: hub.base, client: alice.client, WebSocketImpl, onEvent: event => { aliceEvents.push(event) }, logger: {} })
    const bobEvents = []
    const bobBridge = createBridge({ hubUrl: hub.base, client: bob.client, WebSocketImpl, onEvent: event => { bobEvents.push(event) }, logger: {} })
    try {
      await aliceBridge.start([roomId])
      await bobBridge.start([roomId])
      await waitFor(() => aliceBridge.state === 'open' && bobBridge.state === 'open', { label: 'both sockets' })

      await ask(alice, roomId, bob, 'A request both should see')

      const approvalEvent = event => event.type === 'task.approval_requested'
      await waitFor(() => bobEvents.some(approvalEvent), { label: 'bob to be asked' })
      await waitFor(() => aliceEvents.some(approvalEvent), { label: 'alice to see the request exists' })
      // The event must name who it is waiting on: that is what makes the card appear on one client
      // and not the other.
      const payload = bobEvents.find(approvalEvent).payload
      assert.equal(payload.ownerUserId, bob.userId)
    } finally {
      aliceBridge.stop()
      bobBridge.stop()
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// The three dispatch modes
// ---------------------------------------------------------------------------

describe('the three dispatch modes', () => {
  it('the modes are the Hub\u2019s own three names', () => {
    assert.deepEqual([...ASSIGNMENT_MODES], ['existing_bot', 'chief_auto', 'create_bot'])
  })

  it('existing_bot: the owner names a Bot, and the grant records which one', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'analyst' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Analyse the numbers')

    const decided = await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version,
      mode: 'existing_bot', botId: 'analyst',
      workDir: '/tmp/workgroup-a06', tools: ['read', 'write'],
    })
    assert.equal(decided.state, 'APPROVED')
    // The scope is the owner's statement, and it comes back verbatim so the two ends agree.
    const scope = await bob.approvals.approvedScope(task.id)
    assert.equal(scope.assignmentMode, 'existing_bot')
    assert.equal(scope.assignedBotId, 'analyst')
    assert.equal(scope.workDir, '/tmp/workgroup-a06')
    assert.deepEqual(scope.tools, ['read', 'write'])
    // And it names the task, room, and both people, so a grant cannot be replayed onto another task.
    assert.equal(scope.taskId, task.id)
    assert.equal(scope.roomId, roomId)
    assert.equal(scope.requesterUserId, alice.userId)
    assert.equal(scope.ownerUserId, bob.userId)
    // The decided Bot also appears on the task itself, so a reader need not open the scope.
    assert.equal((await bob.approvals.task(task.id)).task.assignedBotId, 'analyst')
  })

  it('existing_bot without a Bot is refused by the form and by the Hub', async () => {
    // The form refuses synchronously, so nobody sends a request that cannot succeed.
    expect(() => approvalScope({ mode: 'existing_bot' })).toThrow(/picking one/)

    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Needs a Bot')
    // And the Hub refuses the same request if a client sends it anyway.
    await expect(bob.client.request('POST', `/tasks/${task.id}/decision`, {
      body: { decision: 'approve', expectedVersion: task.version, assignmentMode: 'existing_bot' },
    })).rejects.toThrow(/botId/)
  })

  it('chief_auto: the Chief chooses the Bot, but the owner still approves', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'chief' })
    await bob.client.request('POST', '/bots', { body: { botId: 'spare', displayName: 'Spare', role: 'Helper', visibility: 'public' } })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Let the Chief decide who does this')

    // The requester's @ of the Chief produces a request, not a run: this is the blocking rule.
    assert.equal((await bob.approvals.task(task.id)).task.state, 'PENDING_APPROVAL')

    const decided = await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'chief_auto',
    })
    assert.equal(decided.state, 'APPROVED')
    const scope = await bob.approvals.approvedScope(task.id)
    assert.equal(scope.assignmentMode, 'chief_auto')
    // Chief-auto means the local side picks; it must *not* have named a Bot here, or the mode would
    // be indistinguishable from existing_bot and the Chief would have no choice to make.
    assert.equal(scope.assignedBotId, undefined)
  })

  it('create_bot: approving the creation mode grants no Bot id, because none exists yet', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'This one needs somebody new')

    const decided = await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'create_bot',
    })
    assert.equal(decided.state, 'APPROVED')
    const scope = await bob.approvals.approvedScope(task.id)
    assert.equal(scope.assignmentMode, 'create_bot')
    assert.equal(scope.assignedBotId, undefined)
  })

  it('refuses a mode the Hub does not know, before sending it', async () => {
    await expect(newPerson('nobody').then(person => person.approvals.decide({
      taskId: 't', decision: 'approve', expectedVersion: 0, mode: 'ask_the_manager',
    }))).rejects.toThrow(/must be one of existing_bot, chief_auto, create_bot/)

    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Bad mode')
    // And the Hub refuses it too, so a client that skipped its own check is still stopped.
    await expect(bob.client.request('POST', `/tasks/${task.id}/decision`, {
      body: { decision: 'approve', expectedVersion: task.version, assignmentMode: 'ask_the_manager' },
    })).rejects.toThrow(/assignment mode/i)
  })

  it('a scope keeps the owner\u2019s own boundaries and invents no defaults', () => {
    // A directory the owner named is carried through.
    assert.equal(approvalScope({ mode: 'chief_auto', workDir: '/home/bob/project' }).workDir, '/home/bob/project')
    // No directory named means no directory in the scope. The executor must then refuse rather than
    // fall back to a team directory, which is the behaviour the requirement forbids.
    assert.equal('workDir' in approvalScope({ mode: 'chief_auto' }), false)
    assert.equal('tools' in approvalScope({ mode: 'chief_auto' }), false)
    assert.equal('recipients' in approvalScope({ mode: 'chief_auto' }), false)
    // Empty lists are treated as "not stated" rather than as "none allowed", because an empty tool
    // list would read as a grant of nothing and be indistinguishable from an omission.
    assert.equal('tools' in approvalScope({ mode: 'chief_auto', tools: [] }), false)
  })
})

// ---------------------------------------------------------------------------
// Staleness and rejection
// ---------------------------------------------------------------------------

describe('a decision cannot be made twice', () => {
  it('refuses a decision drawn from a card the task has moved past', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Decide me once')

    // Two devices both hold a card at version 0. The first approves; the second must be refused
    // rather than approving a task that is already approved.
    await bob.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'chief_auto' })
    await expect(bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'chief_auto',
    })).rejects.toThrow(/already|moved on/i)
  })

  it('refuses a decision that names no version at all', async () => {
    const person = await newPerson('nobody')
    await expect(person.approvals.decide({ taskId: 't', decision: 'approve', mode: 'chief_auto' }))
      .rejects.toThrow(/version it was made against/)
  })

  it('a rejection grants nothing and records who refused', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Bob will refuse this')

    const rejected = await bob.approvals.reject(task.id, task.version)
    assert.equal(rejected.state, 'REJECTED')
    // A rejection records who refused and against what — the identifying fields are there — but it
    // grants no dispatch: there is no mode and no Bot, so nothing could be started from it.
    const scope = await bob.approvals.approvedScope(task.id)
    assert.equal(scope.assignmentMode, undefined, 'a rejection must not name a dispatch mode')
    assert.equal(scope.assignedBotId, undefined)
    assert.equal(scope.taskId, task.id)
    assert.equal(scope.ownerUserId, bob.userId)
    // Nothing executable, so no grant can be minted from it.
    assert.deepEqual((await bob.approvals.grants(task.id)).grants, [])
    await expect(bob.approvals.mintGrant(task.id, { botId: 'writer' })).rejects.toThrow()
    const detail = await bob.approvals.task(task.id)
    assert.equal(detail.task.approval?.decision, 'reject')
    assert.equal(detail.task.state, 'REJECTED')
  })

  it('a rejected task leaves the owner\u2019s pending list', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Refuse this too')
    await bob.approvals.reject(task.id, task.version)
    assert.deepEqual(await bob.approvals.pending(), [])
  })
})

// ---------------------------------------------------------------------------
// Progress, grants, and revocation
// ---------------------------------------------------------------------------

describe('grants and revocation', () => {
  it('approving does not itself mint a grant; minting is the owner’s separate step', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Something to revoke')
    await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version,
      mode: 'existing_bot', botId: 'writer',
    })

    const { grants } = await bob.approvals.grants(task.id)
    // The approval is the standing answer; nothing is executable yet. A grant is short-lived
    // and single-use precisely because it is minted per run rather than per approval.
    assert.deepEqual(grants, [])

    const minted = await bob.approvals.mintGrant(task.id, { botId: 'writer' })
    assert.equal(minted.grant.taskId, task.id)
    assert.equal(minted.grant.botId, 'writer')
    // The nonce is returned once and never retrievable again, so a stolen grant list is useless.
    assert.equal(typeof minted.grant.nonce, 'string')

    const afterMint = await bob.approvals.grants(task.id)
    const mintedRow = afterMint.grants[0]
    // Presenting it starts work, and the nonce is then spent: a second presentation is refused.
    // The Hub looks the grant up by the nonce, not by id, because the nonce is the secret.
    const started = await bob.approvals.consumeGrant(minted.grant.nonce, task.id)
    assert.equal(started.taskId, task.id)
    assert.equal(started.botId, 'writer')
    // The answer names the scope, which is what the local executor must enforce.
    assert.equal(started.scope.assignmentMode, 'existing_bot')
    await expect(bob.approvals.consumeGrant(minted.grant.nonce, task.id)).rejects.toThrow(/already used/i)
    assert.equal('nonce' in mintedRow, false, 'the grant list must not publish the nonce')
    // A grant must be bound to this task, this Bot, and this owner: that binding is what A-07
    // verifies, and it must not be reconstructible from anything else.
    assert.equal(mintedRow.taskId, task.id)
    assert.equal(mintedRow.botId, 'writer')
    // The grant's owner is the authenticated caller, never a field: a grant that named its owner
    // would suggest an owner can be chosen, which is the one thing minting must not allow.
    assert.equal('ownerUserId' in mintedRow, false)
    assert.equal(mintedRow.consumedAt, null)
    assert.equal(mintedRow.revokedAt, null)
    // A second grant, still outstanding, so revocation has something real to take away. Revoking
    // counts only what was still valid: a consumed grant is already spent, and reporting it as
    // revoked would overstate what the revocation did.
    const second = await bob.approvals.mintGrant(task.id, { botId: 'writer' })
    const revoked = await bob.approvals.revokeGrants(task.id)
    assert.equal(revoked.revoked, 1, `expected exactly the outstanding grant to be revoked, saw ${JSON.stringify(revoked)}`)

    // The rows stay in the list, marked: the list is the record of what was handed out, and a grant
    // that vanished would make "was this ever authorized?" unanswerable after the fact.
    const afterRevoke = (await bob.approvals.grants(task.id)).grants
    assert.equal(afterRevoke.length, 2)
    const revokedRow = afterRevoke.find(row => row.id === second.grant.id)
    assert.equal(revokedRow.revokedAt !== null, true, 'a revoked grant must be marked, not deleted')
    const consumedRow = afterRevoke.find(row => row.id === minted.grant.id)
    assert.equal(consumedRow.consumedAt !== null, true, 'the spent grant keeps its consumption time')

    // A revoked grant can no longer be presented, and the refusal names revocation rather than the
    // replay it would otherwise look like.
    await expect(bob.approvals.consumeGrant(second.grant.nonce, task.id)).rejects.toThrow(/revoked/i)
    // A consumed one is refused as used, which is a different fact.
    await expect(bob.approvals.consumeGrant(minted.grant.nonce, task.id)).rejects.toThrow(/already used/i)
  })

  it('only the owner or a room admin may revoke, and a plain member is refused', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const carol = await newPerson('carol')
    const roomId = await roomWith(alice, bob)
    await carol.workgroup.respondToInvitation((await alice.workgroup.invite(roomId, { targetUserId: carol.userId })).id, 'accept')
    const task = await ask(alice, roomId, bob, 'Carol cannot revoke')
    await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer',
    })
    await bob.approvals.mintGrant(task.id, { botId: 'writer' })

    await expect(carol.approvals.revokeGrants(task.id)).rejects.toThrow(/owner or a room admin/i)
    // Still there, so the refusal was not a silent success.
    assert.equal((await bob.approvals.grants(task.id)).grants.length, 1)
  })

  it('the requester and the owner can both read the task\u2019s progress, a non-member cannot', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const outsider = await newPerson('outsider')
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Progress is readable')

    for (const person of [alice, bob]) {
      const detail = await person.approvals.task(task.id)
      assert.equal(detail.task.id, task.id)
      assert.equal(Array.isArray(detail.events), true)
    }
    // Not 403: a 403 would confirm the id names a real task.
    await expect(outsider.approvals.task(task.id)).rejects.toMatchObject({ status: 404 })
  })

  it('a member who is not the owner cannot read the grant list', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Grants are the owner\u2019s business')
    await bob.approvals.decide({
      taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer',
    })
    // The fact that a grant was minted is about Bob's machine, not the room's business.
    await expect(alice.approvals.grants(task.id)).rejects.toThrow(/owner/i)
  })

  it('cancelling stops a task the requester no longer wants', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', { publishBot: 'writer' })
    const roomId = await roomWith(alice, bob)
    const task = await ask(alice, roomId, bob, 'Never mind')
    const cancelled = await alice.approvals.cancel(task.id)
    assert.equal(['CANCELLED', 'CANCELLING'].includes(cancelled.task?.state ?? cancelled.state), true)
  })
})

// ---------------------------------------------------------------------------
// What the card offers, and what the list keeps
// ---------------------------------------------------------------------------

describe('what the approval card offers', () => {
  it('offers all three modes when the person has a published Bot', () => {
    const choices = approvalChoices({ id: 't', ownerUserId: 'bob' }, [{ botId: 'writer', displayName: 'Writer' }])
    assert.deepEqual(choices.modes, ['existing_bot', 'chief_auto', 'create_bot'])
    assert.deepEqual(choices.bots, [{ botId: 'writer', displayName: 'Writer', role: undefined }])
  })

  it('still offers creating a Bot when the person has none, and hides the two that need one', () => {
    const choices = approvalChoices({ id: 't' }, [])
    // `create_bot` needs no existing Bot, so it is always available; offering `existing_bot` with an
    // empty list would present a choice that cannot be completed.
    assert.deepEqual(choices.modes, ['create_bot'])
  })

  it('starts on the Bot the requester named, without asking twice', () => {
    const choices = approvalChoices({ id: 't', targetBotId: 'analyst' }, [{ botId: 'analyst', displayName: 'Analyst' }])
    assert.equal(choices.suggestedMode, 'existing_bot')
    assert.equal(choices.suggestedBotId, 'analyst')
  })

  it('isMineToDecide is the single predicate, and it is exact', () => {
    const task = { id: 't', state: 'PENDING_APPROVAL', ownerUserId: 'bob' }
    assert.equal(isMineToDecide(task, 'bob'), true)
    // Not for the requester, not for anyone else, and not once it has been decided.
    assert.equal(isMineToDecide(task, 'alice'), false)
    assert.equal(isMineToDecide({ ...task, state: 'APPROVED' }, 'bob'), false)
    assert.equal(isMineToDecide(undefined, 'bob'), false)
  })

  it('the pending list drops a task as soon as it stops waiting on this person', () => {
    const mine = { id: 't1', state: 'PENDING_APPROVAL', ownerUserId: 'bob' }
    const others = { id: 't2', state: 'PENDING_APPROVAL', ownerUserId: 'alice' }
    const pending = [mine, others]

    // Somebody else's task is never in this list to begin with, and an approval by anyone removes it.
    const afterApproval = reducePending(pending, { type: 'task.approved', payload: { task: { ...mine, state: 'APPROVED' } } }, { selfUserId: 'bob' })
    assert.deepEqual(afterApproval.map(entry => entry.id), ['t2'])

    // A change to a still-pending task replaces the entry, so the version the card holds advances.
    const afterChange = reducePending(pending, { type: 'task.approval_requested', payload: { task: { ...mine, version: 3 } } }, { selfUserId: 'bob' })
    assert.equal(afterChange.find(entry => entry.id === 't1').version, 3)
    assert.equal(afterChange.length, 2)
  })

  it('names every state the Hub can be in, and says so for one it does not know', () => {
    for (const state of ['PENDING_APPROVAL', 'APPROVED', 'QUEUED', 'RUNNING', 'REVIEW_REQUIRED', 'COMPLETED', 'SHARED', 'REJECTED', 'CANCELLING', 'CANCELLED', 'EXPIRED', 'FAILED']) {
      const label = taskStateLabel(state)
      assert.equal(label.startsWith('Unknown'), false, `${state} must have a label`)
    }
    // An unknown state is named rather than dropped: a task that vanishes looks like one that never
    // existed, and the reader has no way to ask about it.
    assert.match(taskStateLabel('SOMETHING_NEW'), /Unknown state \(SOMETHING_NEW\)/)
  })

  it('keeps the member roles in step with the Hub', () => {
    assert.deepEqual([...MEMBER_ROLES], ['owner', 'admin', 'member'])
  })
})
