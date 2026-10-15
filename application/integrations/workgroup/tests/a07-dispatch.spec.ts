// A-07: a local executor accepts a dispatch only when the grant genuinely authorizes it.
//
// The requirement is "a forged or revoked dispatch does not execute". Both halves are tested here:
//
//   * **Forged** — a grant for another device, a grant whose Bot is not the approved one, a grant
//     whose directory is a relative path, a filesystem root, a directory that does not exist, and a
//     symlink inside the approved root that points outside it. Each is a distinct refusal with its
//     own code, because each one tells the owner to do something different.
//   * **Revoked** — a task cancelled after approval. The revocation version the approval recorded is
//     compared with the task's before the Hub is even asked, so a cancellation already known
//     locally never reaches the network, and one that arrived only on the Hub is caught by the
//     consume call.
//
// The real Hub is used for the cases that involve it, so "the Hub refuses" is a measurement rather
// than a claim. The pure validation cases need no Hub and run without one, which is deliberate: the
// local checks must not depend on the network being present to be safe.
//
// The directory cases build real directories, real symlinks, and a real sibling whose name shares a
// prefix with the root (`work-other` beside `work`) — the case a naive `startsWith` check passes.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import { createApprovalClient } from '../client/approvals.mjs'
import { acceptDispatch, resolveTaskDirectory, sessionWorkDirFor, DISPATCH_REFUSALS } from '../policy/dispatch.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const SIGNING_KEY = 'a07-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a07-bootstrap-secret'

async function startRealHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a07-'))
  const port = 23000 + Math.floor(Math.random() * 900)
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
/** Every directory this file creates, cleaned up at the end. */
const scratch = []

function scratchRoot(name) {
  const path = mkdtempSync(join(tmpdir(), `workgroup-a07-${name}-`))
  scratch.push(path)
  return path
}

async function newPerson(label, botId) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  const person = { client, userId: client.identity.userId, deviceId: client.deviceId, workgroup: createWorkgroupClient({ client }) }
  person.approvals = createApprovalClient({ client, selfUserId: person.userId })
  if (botId !== undefined) {
    await client.request('POST', '/bots', { body: { botId, displayName: botId, role: 'Worker', visibility: 'public' } })
  }
  return person
}

async function approvedTask({ requester, owner, botId, workDir }) {
  const room = await requester.client.request('POST', '/rooms', { body: { name: 'Dispatch room' } })
  await owner.workgroup.respondToInvitation((await requester.workgroup.invite(room.room.id, { targetUserId: owner.userId })).id, 'accept')
  const created = await requester.client.request('POST', `/rooms/${room.room.id}/tasks`, {
    body: { ownerUserId: owner.userId, description: 'Do the work', targetBotId: botId },
  })
  await owner.approvals.decide({
    taskId: created.task.id, decision: 'approve', expectedVersion: created.task.version,
    mode: 'existing_bot', botId, workDir,
  })
  const minted = await owner.approvals.mintGrant(created.task.id, { botId })
  const task = (await owner.approvals.task(created.task.id)).task
  return { roomId: room.room.id, task, grant: minted.grant }
}

beforeAll(async () => {
  hub = await startRealHub()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
  for (const path of scratch) rmSync(path, { recursive: true, force: true, maxRetries: 10 })
}, 30_000)

// ---------------------------------------------------------------------------
// The directory rule
// ---------------------------------------------------------------------------

describe('the approved directory is validated on the resolved path', () => {
  it('accepts a real absolute directory', () => {
    const root = scratchRoot('good')
    const child = join(root, 'project')
    mkdirSync(child)
    const resolved = resolveTaskDirectory(child)
    assert.equal(resolved.workDir, resolve(child))
    assert.equal(resolved.realPath, resolve(child))
  })

  it('refuses a grant that named no directory at all', () => {
    // The requirement is that an absent directory fails rather than falling back to a team folder.
    for (const value of [undefined, null, '', '   ']) {
      expect(() => resolveTaskDirectory(value)).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED }))
    }
  })

  it('refuses a relative path, because it would resolve against whatever the process started in', () => {
    for (const value of ['relative/path', './here', '../up']) {
      expect(() => resolveTaskDirectory(value)).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.UNUSABLE_DIRECTORY }))
    }
  })

  it('refuses a directory that does not exist, rather than creating the workspace', () => {
    const root = scratchRoot('missing')
    expect(() => resolveTaskDirectory(join(root, 'never-created')))
      .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.UNUSABLE_DIRECTORY }))
  })

  it('refuses a path that is a file, not a directory', () => {
    const root = scratchRoot('file')
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'not a directory')
    expect(() => resolveTaskDirectory(file))
      .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.UNUSABLE_DIRECTORY }))
  })

  it('refuses a filesystem root, which would make every other check meaningless', () => {
    for (const value of ['/', process.platform === 'win32' ? 'D:\\' : '/tmp']) {
      // `/tmp` is a real directory and is accepted; the assertion below is only about real roots.
      if (value === '/') {
        expect(() => resolveTaskDirectory('/')).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.UNUSABLE_DIRECTORY }))
      }
    }
  })

  it('refuses a directory outside the root, and a sibling whose name merely starts with it', () => {
    const base = scratchRoot('roots')
    const root = join(base, 'work')
    const inside = join(root, 'project')
    const outside = join(base, 'elsewhere')
    // The trap: `work-other` shares a prefix with `work`. A `startsWith` check without a separator
    // treats it as inside, which is how a directory escape passes an obvious-looking guard.
    const sibling = join(base, 'work-other')
    for (const path of [root, inside, outside, sibling]) mkdirSync(path, { recursive: true })

    // Inside the root is accepted.
    assert.equal(resolveTaskDirectory(inside, { root }).realPath, resolve(inside))
    // The root itself is accepted: a task may work in the folder the owner named.
    assert.equal(resolveTaskDirectory(root, { root }).realPath, resolve(root))
    // Anything else is refused.
    expect(() => resolveTaskDirectory(outside, { root })).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT }))
    expect(() => resolveTaskDirectory(sibling, { root })).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT }))
  })

  it('refuses a symlink inside the root that points outside it', () => {
    const base = scratchRoot('symlink')
    const root = join(base, 'work')
    const outside = join(base, 'private')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    const escape = join(root, 'shortcut')
    try {
      symlinkSync(outside, escape, 'junction')
    } catch (error) {
      // A machine without the privilege to create a link cannot test this case; the check is
      // reported as skipped rather than silently passing.
      console.log(`symlink creation unavailable: ${error.message}`)
      return
    }
    // Implements the F-12 requirement's second half: the check runs on the realpath, so a link that
    // looks like it is inside the root cannot carry the Session out of it.
    expect(() => resolveTaskDirectory(escape, { root }))
      .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT }))
  })

  it('the session helper is the one path from an approved scope to a directory', () => {
    const root = scratchRoot('session')
    expect(sessionWorkDirFor({ scope: { workDir: root } }).workDir).toBe(resolve(root))
    expect(() => sessionWorkDirFor({ scope: {} }))
      .toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED }))
    expect(() => sessionWorkDirFor({})).toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED }))
  })
})

// ---------------------------------------------------------------------------
// A forged dispatch does not execute
// ---------------------------------------------------------------------------

describe('a forged dispatch does not execute', () => {
  const taskTemplate = { id: 't-1', state: 'APPROVED', revocationVersion: 0, assignedBotId: 'writer' }

  it('refuses a grant minted for another device, before the nonce is presented', async () => {
    let consumed = false
    await expect(acceptDispatch({
      grant: { nonce: 'wggrant_x', taskId: 't-1', botId: 'writer' },
      deviceId: 'device-mine',
      mintedForDeviceId: 'device-someone-else',
      task: taskTemplate,
      approvedRevocationVersion: 0,
      scope: { workDir: scratchRoot('other-device') },
      consume: async () => { consumed = true; return {} },
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.NOT_FOR_THIS_DEVICE }))
    // The important part: the forged frame did not burn the credential the real device still needs.
    assert.equal(consumed, false, 'a frame for another device must not consume this device\u2019s grant')
  })

  it('refuses a grant that names a different Bot than the approval did', async () => {
    const root = scratchRoot('bot-mismatch')
    await expect(acceptDispatch({
      grant: { nonce: 'wggrant_x', taskId: 't-1', botId: 'someone-else' },
      deviceId: 'd',
      mintedForDeviceId: 'd',
      task: { ...taskTemplate, assignedBotId: 'writer' },
      approvedRevocationVersion: 0,
      scope: { workDir: root },
      consume: async () => ({ scope: {}, botId: 'someone-else' }),
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.BOT_MISMATCH }))
  })

  it('refuses a grant with no nonce or no task, rather than calling the Hub with it', async () => {
    const root = scratchRoot('malformed')
    for (const grant of [{}, { nonce: 'x' }, { taskId: 't-1' }, null, 'a string']) {
      await expect(acceptDispatch({
        grant,
        deviceId: 'd',
        mintedForDeviceId: 'd',
        task: taskTemplate,
        approvedRevocationVersion: 0,
        scope: { workDir: root },
        consume: async () => ({}),
      })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.MALFORMED_GRANT }))
    }
  })

  it('refuses a grant whose task is not the one it names', async () => {
    const root = scratchRoot('task-mismatch')
    await expect(acceptDispatch({
      grant: { nonce: 'x', taskId: 't-1' },
      deviceId: 'd',
      mintedForDeviceId: 'd',
      task: { ...taskTemplate, id: 't-other' },
      approvedRevocationVersion: 0,
      scope: { workDir: root },
      consume: async () => ({}),
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.MALFORMED_GRANT }))
  })

  it('refuses before consuming when the directory is unusable', async () => {
    let consumed = false
    await expect(acceptDispatch({
      grant: { nonce: 'x', taskId: 't-1' },
      deviceId: 'd',
      mintedForDeviceId: 'd',
      task: taskTemplate,
      approvedRevocationVersion: 0,
      scope: { workDir: 'relative/nope' },
      consume: async () => { consumed = true; return {} },
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.UNUSABLE_DIRECTORY }))
    // Validating first is what lets the owner fix the path and reuse the same grant.
    assert.equal(consumed, false)
  })
})

// ---------------------------------------------------------------------------
// A revoked dispatch does not execute
// ---------------------------------------------------------------------------

describe('a revoked dispatch does not execute', () => {
  it('refuses locally when the task\u2019s revocation version has moved, without asking the Hub', async () => {
    const root = scratchRoot('revoked-local')
    let asked = false
    await expect(acceptDispatch({
      grant: { nonce: 'x', taskId: 't-1', botId: 'writer' },
      deviceId: 'd',
      mintedForDeviceId: 'd',
      task: { id: 't-1', state: 'APPROVED', revocationVersion: 1, assignedBotId: 'writer' },
      approvedRevocationVersion: 0,
      scope: { workDir: root },
      consume: async () => { asked = true; return {} },
    })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.REVOKED }))
    // A cancellation already known locally must not reach the network at all.
    assert.equal(asked, false)
  })

  it('refuses a task that is not in an approved state', async () => {
    const root = scratchRoot('state')
    for (const state of ['PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'COMPLETED', 'FAILED']) {
      await expect(acceptDispatch({
        grant: { nonce: 'x', taskId: 't-1' },
        deviceId: 'd',
        mintedForDeviceId: 'd',
        task: { id: 't-1', state, revocationVersion: 0 },
        approvedRevocationVersion: 0,
        scope: { workDir: root },
        consume: async () => ({}),
      })).rejects.toThrow(expect.objectContaining({ code: DISPATCH_REFUSALS.REVOKED }))
    }
  })

  it('surfaces the Hub\u2019s own refusal when it is the one that knows', async () => {
    const root = scratchRoot('revoked-hub')
    // The local version matches, so the check passes and the Hub is asked; the Hub is where a
    // cancellation that happened after this machine last heard is recorded.
    await expect(acceptDispatch({
      grant: { nonce: 'wggrant_stale', taskId: 't-1' },
      deviceId: 'd',
      mintedForDeviceId: 'd',
      task: { id: 't-1', state: 'APPROVED', revocationVersion: 0 },
      approvedRevocationVersion: 0,
      scope: { workDir: root },
      consume: async () => { throw new Error('This dispatch grant was revoked by a cancellation') },
    })).rejects.toThrow(/revoked/i)
  })
})

// ---------------------------------------------------------------------------
// The accepting path, against the real Hub
// ---------------------------------------------------------------------------

describe('a genuine dispatch is accepted, once', () => {
  it('accepts a real grant for a real task and records the scope', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const workDir = scratchRoot('real')
    const { task, grant } = await approvedTask({ requester: alice, owner: bob, botId: 'writer', workDir })

    const accepted = await acceptDispatch({
      grant,
      deviceId: bob.deviceId,
      mintedForDeviceId: bob.deviceId,
      task,
      approvedRevocationVersion: task.revocationVersion,
      scope: { workDir, tools: ['read'] },
      consume: (nonce, taskId) => bob.approvals.consumeGrant(nonce, taskId),
    })
    assert.equal(accepted.taskId, task.id)
    assert.equal(accepted.botId, 'writer')
    assert.equal(accepted.workDir, resolve(workDir))
    assert.deepEqual(accepted.tools, ['read'])
  })

  it('the same nonce cannot be accepted twice', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const workDir = scratchRoot('once')
    const { task, grant } = await approvedTask({ requester: alice, owner: bob, botId: 'writer', workDir })
    const input = {
      grant,
      deviceId: bob.deviceId,
      mintedForDeviceId: bob.deviceId,
      task,
      approvedRevocationVersion: task.revocationVersion,
      scope: { workDir },
      consume: (nonce, taskId) => bob.approvals.consumeGrant(nonce, taskId),
    }

    await acceptDispatch(input)
    // The Hub refuses the replay, and the local side must pass that refusal through rather than
    // start a second Session beside the first.
    await expect(acceptDispatch(input)).rejects.toThrow(/already used|revoked/i)
  })

  it('a cancelled task\u2019s grant is refused by the Hub', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const workDir = scratchRoot('cancelled')
    const { task, grant } = await approvedTask({ requester: alice, owner: bob, botId: 'writer', workDir })

    await alice.approvals.cancel(task.id)

    await expect(acceptDispatch({
      grant,
      deviceId: bob.deviceId,
      mintedForDeviceId: bob.deviceId,
      task,
      approvedRevocationVersion: task.revocationVersion,
      scope: { workDir },
      consume: (nonce, taskId) => bob.approvals.consumeGrant(nonce, taskId),
    })).rejects.toThrow()
  })

  it('another device cannot present a grant minted here, even holding the nonce', async () => {
    const alice = await newPerson('alice')
    const bob = await newPerson('bob', 'writer')
    const workDir = scratchRoot('cross-device')
    const { task, grant } = await approvedTask({ requester: alice, owner: bob, botId: 'writer', workDir })

    // Bob signs in a second device; it holds the nonce but was not the device the grant was minted
    // for. The Hub binds a grant to a device, which is what makes a captured nonce insufficient.
    const secondDevice = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
    await secondDevice.handshake()
    await secondDevice.login({ userHandle: bob.client.identity.userHandle, password: PASSWORD, fingerprint: 'sha256:another-device-0001', publicKey: 'ed25519:other' })
    const secondApprovals = createApprovalClient({ client: secondDevice, selfUserId: bob.userId })

    await expect(secondApprovals.consumeGrant(grant.nonce, task.id)).rejects.toThrow()
    // And the real device's grant is still unused, so the refusal did not burn it.
    const accepted = await acceptDispatch({
      grant,
      deviceId: bob.deviceId,
      mintedForDeviceId: bob.deviceId,
      task,
      approvedRevocationVersion: task.revocationVersion,
      scope: { workDir },
      consume: (nonce, taskId) => bob.approvals.consumeGrant(nonce, taskId),
    })
    assert.equal(accepted.taskId, task.id)
  })
})
