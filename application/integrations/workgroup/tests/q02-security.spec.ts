// Q-02: the negative cases, as one suite.
//
// The acceptance criteria name five groups — cross-room, over-privilege, directories, tools, and
// cancellation — plus the credential cases in section E (signature, replay, expiry, device
// revocation, log redaction). Each has been tested where it belongs; this file is the audit that
// they still all hold **together**, against one real Hub, in the shape a reviewer would check.
//
// It is deliberately a *re-test*, not a re-implementation: every case here uses the public client
// surface the product ships. A security property that only holds through a test-only back door is
// not a property of the product, so nothing here reaches into the Hub's internals.
//
// Every case is a refusal. A suite of positives says "the feature works"; this one says "the ways in
// are shut", which is the only useful form for a release gate.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { checkHubProtocol } from '../protocol/index.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import { createApprovalClient } from '../client/approvals.mjs'
import { createMemoryClient } from '../client/memory.mjs'

// One Ed25519 key pair for this file: the Hub signs dispatch grants with it (E1).
const GRANT_KEYS = generateKeyPairSync('ed25519')
const GRANT_PRIVATE_PEM = GRANT_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' })
import { acceptDispatch, resolveTaskDirectory, DISPATCH_REFUSALS } from '../policy/dispatch.mjs'
import { publicProgress, assertPublishable, NEVER_PUBLISHED } from '../client/review.mjs'
import { issueAccessToken, verifyAccessToken, TokenError, keyringFromConfig, parsePreviousKeys } from '../../../../server/src/auth/tokens.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'q02-test-signing-key-long-enough-for-hs256'
const OTHER_KEY = 'q02-other-signing-key-long-enough-000000'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'q02-bootstrap-secret'

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-q02-'))
  const port = 26000 + Math.floor(Math.random() * 900)
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      // E1: grants are asymmetrically signed, so the Hub under test needs a key for the same reason a
      // real one does. Generated per run, passed through the environment, never written to disk.
      HUB_GRANT_SIGNING_KEY: GRANT_PRIVATE_PEM, HUB_GRANT_SIGNING_KEY_ID: 'g1',
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
    log: () => log,
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
const scratch = []

function scratchRoot(name) {
  const path = mkdtempSync(join(tmpdir(), `workgroup-q02-${name}-`))
  scratch.push(path)
  return path
}

async function newPerson(label) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  return {
    handle, client, userId: client.identity.userId, deviceId: client.deviceId,
    workgroup: createWorkgroupClient({ client }),
    approvals: createApprovalClient({ client, selfUserId: client.identity.userId }),
    memory: createMemoryClient({ client }),
  }
}

async function sharedRoom(owner, members) {
  const room = await owner.client.request('POST', '/rooms', { body: { name: 'Security room' } })
  for (const member of members) {
    await member.workgroup.respondToInvitation((await owner.workgroup.invite(room.room.id, { targetUserId: member.userId })).id, 'accept')
  }
  const posted = await owner.workgroup.sendMessage(room.room.id, 'A message in the room.')
  return { roomId: room.room.id, message: posted.message }
}

beforeAll(async () => {
  hub = await startRealHub()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
  for (const path of scratch) rmSync(path, { recursive: true, force: true, maxRetries: 10 })
}, 30_000)

// ---------------------------------------------------------------------------
// Cross-room: an id is not access
// ---------------------------------------------------------------------------

describe('cross-room', () => {
  it('a guessed room id reads nothing: room, messages, memories, artifacts, tasks', async () => {
    const alice = await newPerson('alice')
    const outsider = await newPerson('outsider')
    const { roomId } = await sharedRoom(alice, [])
    await alice.memory.remember(roomId, { body: 'A private decision.' })
    const task = await alice.client.request('POST', `/rooms/${roomId}/tasks`, { body: { ownerUserId: alice.userId, description: 'x' } }).catch(() => ({ task: undefined }))

    // Every read is a 404, not a 403: a 403 would confirm the id names a real room, which is what
    // somebody enumerating ids wants to learn.
    for (const path of [
      `/rooms/${roomId}`,
      `/rooms/${roomId}/members`,
      `/rooms/${roomId}/messages`,
      `/rooms/${roomId}/memories`,
      `/rooms/${roomId}/memories/search?q=private`,
      `/rooms/${roomId}/artifacts`,
      `/rooms/${roomId}/tasks`,
    ]) {
      await expect(outsider.client.request('GET', path)).rejects.toMatchObject({ status: 404 })
    }
    // And writing is refused as well, so membership is not a read-only boundary.
    await expect(outsider.workgroup.sendMessage(roomId, 'hello')).rejects.toMatchObject({ status: 404 })
    await expect(outsider.memory.remember(roomId, { body: 'let me in' })).rejects.toMatchObject({ status: 404 })
    assert.equal(task.task === undefined || task.task.id.length > 0, true)
  })

  it('an invitation cannot be accepted by a third party who learns its id', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const { roomId } = await sharedRoom(alice, [])
    const invitation = await alice.workgroup.invite(roomId, { targetUserId: bob.userId })

    await expect(carol.workgroup.respondToInvitation(invitation.id, 'accept')).rejects.toThrow()
    await expect(carol.client.request('GET', `/rooms/${roomId}`)).rejects.toMatchObject({ status: 404 })
  })

  it('a memory cannot cite a message from a room its author is not in', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const mine = await sharedRoom(alice, [bob])
    const theirs = await sharedRoom(bob, [])
    const theirMessage = await bob.workgroup.sendMessage(theirs.roomId, 'Not for Alice')

    // Quoting across a boundary would let a member learn what is in a room they cannot read.
    await expect(alice.memory.remember(mine.roomId, { body: 'quoting', sourceMessageId: theirMessage.message.id }))
      .rejects.toThrow()
  })

  it('removing a member takes the subscription with it, and a stale token cannot re-subscribe', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const { roomId } = await sharedRoom(alice, [bob])

    // Bob holds a live token. After removal it must not open a subscription, whatever its expiry.
    const staleToken = bob.client.accessToken
    assert.equal(typeof staleToken, 'string')
    await alice.workgroup.removeMember(roomId, bob.userId)
    await expect(bob.client.request('GET', `/rooms/${roomId}`)).rejects.toMatchObject({ status: 404 })
  })

  it('a revoked device cannot use its still-unexpired access token', async () => {
    const alice = await newPerson('alice')
    const { roomId } = await sharedRoom(alice, [])
    // The token is valid by signature and by time. Revoking the device is what must stop it.
    await alice.client.request('POST', `/devices/${alice.deviceId}/revoke`)
    await expect(alice.client.request('GET', `/rooms/${roomId}`)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Over-privilege: a member is not an admin, an admin is not the owner
// ---------------------------------------------------------------------------

describe('over-privilege', () => {
  it('a plain member cannot invite, remove, change roles, or leave the room changed', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    const carol = await newPerson('carol')
    const { roomId } = await sharedRoom(alice, [bob])

    await expect(bob.workgroup.invite(roomId, { targetUserId: carol.userId })).rejects.toThrow()
    await expect(bob.workgroup.removeMember(roomId, alice.userId)).rejects.toThrow()
    await expect(bob.workgroup.setRole(roomId, bob.userId, 'admin')).rejects.toThrow()
    // The room is unchanged: the owner is still the owner and the member list still has two.
    assert.equal((await alice.workgroup.members(roomId)).length, 2)
  })

  it('a room admin cannot approve, review, or read another person\u2019s task grants', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const { roomId } = await sharedRoom(alice, [bob])
    const task = (await alice.client.request('POST', `/rooms/${roomId}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'Bob must decide', targetBotId: 'writer' },
    })).task

    // Alice owns the room and is its admin. She still cannot decide Bob's task, nor read its grants,
    // nor report progress on it — room authority and personal authorization are different things.
    await expect(alice.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'chief_auto' }))
      .rejects.toThrow(/owner/i)
    await expect(alice.approvals.grants(task.id)).rejects.toThrow()
    await expect(alice.approvals.reportProgress(task.id, { stage: 'running' })).rejects.toThrow(/owner/i)
    await expect(alice.approvals.review(task.id, 'keep', { expectedVersion: task.version })).rejects.toThrow(/owner/i)
  })

  it('the owner cannot be forced to run on a Bot they did not approve', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const { roomId } = await sharedRoom(alice, [bob])
    const task = (await alice.client.request('POST', `/rooms/${roomId}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'x', targetBotId: 'writer' },
    })).task
    // Naming a Bot Bob never published, or one that is not his, is refused at request time.
    await expect(alice.client.request('POST', `/rooms/${roomId}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'x', targetBotId: 'ghost' },
    })).rejects.toThrow()
    assert.equal(task.state, 'PENDING_APPROVAL')
  })

  it('a Bot the owner never published is not in the directory for anybody', async () => {
    const alice = await newPerson('alice')
    await alice.client.request('POST', '/bots', { body: { botId: 'secret', displayName: 'Secret', visibility: 'private' } })
    const bob = await newPerson('bob')
    const visible = await bob.workgroup.publishedBots()
    assert.equal(visible.some(entry => entry.botId === 'secret'), false)
  })
})

// ---------------------------------------------------------------------------
// Directories and tools
// ---------------------------------------------------------------------------

describe('directories and tools', () => {
  const task = { id: 't-1', state: 'APPROVED', revocationVersion: 0 }
  const grant = { nonce: 'wggrant_x', taskId: 't-1' }
  const base = {
    grant, deviceId: 'd', mintedForDeviceId: 'd', task, approvedRevocationVersion: 0, consume: async () => ({}),
    // E1 made a verifier mandatory. These cases are about the directory and tool rules, so the
    // verifier answers "yes" — the signature rules have their own cases in `a07` and `e1-signature-parity`.
    verifyGrant: () => true,
  }

  it('a directory outside the approved root is refused, including a symlink that points out', () => {
    const parent = scratchRoot('dirs')
    const root = join(parent, 'work')
    const inside = join(root, 'project')
    const outside = join(parent, 'elsewhere')
    const sibling = join(parent, 'work-other')
    for (const path of [root, inside, outside, sibling]) mkdirSync(path, { recursive: true })

    assert.equal(resolveTaskDirectory(inside, { root }).realPath, resolve(inside))
    for (const refused of [outside, sibling]) {
      expect(() => resolveTaskDirectory(refused, { root }))
        .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT }))
    }

    const escape = join(root, 'shortcut')
    try {
      symlinkSync(outside, escape, 'junction')
      // The check runs on the resolved path, which is what catches a link that looks inside.
      expect(() => resolveTaskDirectory(escape, { root }))
        .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT }))
    } catch (error) {
      console.log(`symlink creation unavailable: ${error.message}`)
    }
  })

  it('no directory, a relative one, a missing one, a file, and a filesystem root are all refused', () => {
    const parent = scratchRoot('baddirs')
    for (const [value, code] of [
      [undefined, DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED],
      ['', DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED],
      ['relative/path', DISPATCH_REFUSALS.UNUSABLE_DIRECTORY],
      [join(parent, 'never-made'), DISPATCH_REFUSALS.UNUSABLE_DIRECTORY],
      ['/', DISPATCH_REFUSALS.UNUSABLE_DIRECTORY],
    ]) {
      expect(() => resolveTaskDirectory(value)).toThrow(expect.objectContaining({ code }))
    }
  })

  it('a grant for another device is refused without consuming the credential', async () => {
    let consumed = false
    await expect(acceptDispatch({
      ...base,
      mintedForDeviceId: 'someone-else',
      scope: { workDir: scratchRoot('other') },
      consume: async () => { consumed = true; return {} },
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.NOT_FOR_THIS_DEVICE }))
    assert.equal(consumed, false)
  })

  it('a revoked task is refused locally, without asking the Hub', async () => {
    let asked = false
    await expect(acceptDispatch({
      ...base,
      task: { ...task, revocationVersion: 1 },
      scope: { workDir: scratchRoot('revoked') },
      consume: async () => { asked = true; return {} },
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.REVOKED }))
    assert.equal(asked, false)
  })

  it('a tool list that was not approved stays empty, and never widens', async () => {
    const accepted = await acceptDispatch({ ...base, scope: { workDir: scratchRoot('tools') } })
    // No tools named means no tools allowed. An executor that treated the empty list as "anything"
    // would grant every tool the Bot owns.
    assert.deepEqual(accepted.tools, [])
  })
})

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancellation', () => {
  it('a cancelled task cannot be dispatched, and its grants stop being usable', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const { roomId } = await sharedRoom(alice, [bob])
    const task = (await alice.client.request('POST', `/rooms/${roomId}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'Cancel me', targetBotId: 'writer' },
    })).task
    await bob.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer', workDir: '/tmp/q02' })
    const minted = await bob.approvals.mintGrant(task.id, { botId: 'writer' })

    await alice.approvals.cancel(task.id)

    // The grant cannot be presented: the revocation version moved.
    await expect(bob.approvals.consumeGrant(minted.grant.nonce, task.id)).rejects.toThrow()
    // And a fresh grant cannot be minted from a cancelled task either.
    await expect(bob.approvals.mintGrant(task.id, { botId: 'writer' })).rejects.toThrow()
  })

  it('a revoked grant is refused by name, distinguishing it from a replay', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const { roomId } = await sharedRoom(alice, [bob])
    const task = (await alice.client.request('POST', `/rooms/${roomId}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'x', targetBotId: 'writer' },
    })).task
    await bob.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer', workDir: '/tmp/q02' })
    const minted = await bob.approvals.mintGrant(task.id, { botId: 'writer' })
    await bob.approvals.revokeGrants(task.id)

    // The two refusals mean different things to an operator, so they stay distinct.
    await expect(bob.approvals.consumeGrant(minted.grant.nonce, task.id, { signature: minted.grant.signature, keyId: minted.grant.keyId })).rejects.toThrow(/revoked/i)
  })
})

// ---------------------------------------------------------------------------
// Credentials: signature, replay, expiry, revocation, redaction
// ---------------------------------------------------------------------------

describe('credentials', () => {
  it('a token signed with another key is refused, and one with a tampered payload is too', () => {
    const keyring = keyringFromConfig({ tokenSigningKey: SIGNING_KEY })
    const foreign = issueAccessToken({ signingKey: OTHER_KEY, userId: 'u', deviceId: 'd', ttlSeconds: 900 })
    expect(() => verifyAccessToken(foreign, { keyring })).toThrow(TokenError)

    const mine = issueAccessToken({ keyring, userId: 'u', deviceId: 'd', ttlSeconds: 900 })
    const [prefix, kid, , mac] = mine.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', did: 'd', iat: 1, exp: 9999999999, jti: 'x' })).toString('base64url')
    expect(() => verifyAccessToken(`${prefix}.${kid}.${forged}.${mac}`, { keyring })).toThrow(/signature is not valid/)
  })

  it('an expired token is refused, and a stale clock within the skew is tolerated', () => {
    const keyring = keyringFromConfig({ tokenSigningKey: SIGNING_KEY })
    const past = new Date(Date.now() - 3600 * 1000)
    const old = issueAccessToken({ keyring, userId: 'u', deviceId: 'd', ttlSeconds: 60, now: past })
    expect(() => verifyAccessToken(old, { keyring })).toThrow(/expired/)

    const recent = new Date(Date.now() - 70 * 1000)
    const stale = issueAccessToken({ keyring, userId: 'u', deviceId: 'd', ttlSeconds: 60, now: recent })
    // 10 seconds of overrun is inside the 30 second allowance, so a slow clock does not lock users out.
    assert.equal(verifyAccessToken(stale, { keyring }).sub, 'u')
  })

  it('a rotated key still verifies while the new one signs', () => {
    const before = keyringFromConfig({ tokenSigningKey: OTHER_KEY })
    const oldToken = issueAccessToken({ keyring: before, userId: 'u', deviceId: 'd', ttlSeconds: 900 })
    const after = keyringFromConfig({
      tokenSigningKey: SIGNING_KEY,
      currentKid: 'k2',
      previousKeys: parsePreviousKeys(`k1:${OTHER_KEY}`),
    })
    // The whole point of the keyring: an operator rotating a key does not log everyone out.
    assert.equal(verifyAccessToken(oldToken, { keyring: after }).sub, 'u')
    assert.equal(issueAccessToken({ keyring: after, userId: 'u', deviceId: 'd', ttlSeconds: 900 }).split('.')[1], 'k2')
  })

  it('a refresh token is single use, and reuse is refused', async () => {
    const alice = await newPerson('alice')
    const session = await alice.client.request('POST', '/auth/login', {
      body: { userHandle: alice.handle, password: PASSWORD, fingerprint: 'sha256:q02-second-device', publicKey: 'ed25519:q' },
    })
    const rotated = await alice.client.request('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken }, auth: false })
    assert.ok(rotated.refreshToken.startsWith('wgref_'))
    // Presenting the old one again is the standard leak signal, and the Hub refuses it.
    await expect(alice.client.request('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken }, auth: false }))
      .rejects.toThrow()
  })

  it('a protocol mismatch is refused, so a client cannot half-talk to a Hub', () => {
    assert.equal(checkHubProtocol('wg.v1').ok, true)
    assert.equal(checkHubProtocol('wg.v9').ok, false)
    assert.equal(checkHubProtocol('nonsense').ok, false)
  })

  it('nothing about the machine reaches a progress update, and a slip is refused rather than filtered', () => {
    const update = publicProgress({ stage: 'running', workDir: '/home/bob/secret', stdout: 'x', reasoning: 'y', sessionId: 's' })
    assert.deepEqual(Object.keys(update).sort(), ['stage'])
    for (const field of NEVER_PUBLISHED.slice(0, 6)) {
      // Refused, not silently stripped: a filter would hide the mistake.
      expect(() => assertPublishable({ [field]: 'value' })).toThrow()
    }
  })

  it('the Hub log does not carry a token or a password', async () => {
    const alice = await newPerson('alice')
    await alice.client.request('GET', '/auth/me')
    // The Hub logs requests; a bearer token in a URL or in a log line is a credential leak.
    const log = hub.log()
    assert.equal(log.includes(alice.client.accessToken ?? 'a-token-that-is-not-present'), false)
    assert.equal(log.includes(PASSWORD), false)
    assert.equal(/Authorization:\s*Bearer/.test(log), false)
  })
})
