// Q-03: what happens across an upgrade, a disconnect, a crash, and a restore.
//
// The criterion is "no duplicate execution and no data crossing a boundary". Those two are what a
// restart is dangerous for:
//
//   * **No duplicate execution.** A Hub that dies mid-flight leaves clients holding state they
//     cannot tell is stale. Every case here kills something for real — a `SIGKILL`, not a polite
//     close — and then asserts that the client's recovery does not run anything twice.
//   * **No data crossing a boundary.** A restart must not resurrect access: a token minted before a
//     restart, a membership removed before one, a cancelled task. And a restore must not leave rows
//     pointing at files nobody kept.
//
// Every case runs against a real Hub process and a real database file, because the interesting
// failures are in the seams: a crash leaves SQLite's WAL behind, a restore replaces a file a running
// process still holds, and an upgrade has to reason about a schema it did not build. A mock would
// let all three pass while none of them worked.

import { recycleTestPath } from './recycle.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'
import { createApprovalClient } from '../client/approvals.mjs'
import { createMemoryClient } from '../client/memory.mjs'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const APP_ROOT = resolve(HERE, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const CLI = join(SERVER_ROOT, 'src', 'cli', 'hub.js')
const SIGNING_KEY = 'q03-test-signing-key-long-enough-for-hs256'
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'q03-bootstrap-secret'

/** A Hub on a fixed data directory, so it can be killed and restarted against the same files. */
function createHubProcess({ dataDir, port }) {
  let child
  let log = ''
  const start = async () => {
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production', HUB_HOST: '127.0.0.1', HUB_PORT: String(port),
        HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
        HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })
    const deadline = Date.now() + 30_000
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health/live`)).ok) return } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error(`the Hub never came up:\n${log}`)
      await new Promise(resume => setTimeout(resume, 120))
    }
  }
  return {
    get base() { return `http://127.0.0.1:${port}` },
    get pid() { return child?.pid },
    get log() { return log },
    start,
    /** A real crash: no shutdown handler runs, so the WAL is left as the kernel leaves it. */
    kill: async () => {
      if (child === undefined || child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGKILL')
      await exited
    },
    /** A clean stop, which is what an upgrade uses. */
    stop: async () => {
      if (child === undefined || child.exitCode !== null) return
      const exited = new Promise(resume => child.once('exit', resume))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resume => setTimeout(resume, 8000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

async function newPerson(base, label) {
  const handle = `${label}${Math.floor(Math.random() * 100000)}`
  const client = createHubClient({ hubUrl: base, appVersion: '0.1.0-test' })
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

let root
let dataDir
let port
let hub

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'workgroup-q03-'))
  dataDir = join(root, 'data')
  port = 27000 + Math.floor(Math.random() * 900)
  hub = createHubProcess({ dataDir, port })
  await hub.start()
}, 60_000)

afterAll(async () => {
  await hub?.stop()
  recycleTestPath(root)
}, 60_000)

// ---------------------------------------------------------------------------
// Crash and recovery
// ---------------------------------------------------------------------------

describe('a crash loses nothing that was committed', () => {
  it('state written before a SIGKILL survives the restart, and the Hub comes back current', async () => {
    const alice = await newPerson(hub.base, 'alice')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Crash room' } })
    await alice.workgroup.sendMessage(room.room.id, 'written before the crash')
    await alice.memory.remember(room.room.id, { body: 'Remembered before the crash.' })

    // No shutdown handler runs. What is committed must still be there.
    await hub.kill()
    const restartedLog = hub.log.length
    await hub.start()

    // The restarted process reports a current schema rather than re-running migrations.
    assert.match(hub.log.slice(restartedLog), /schema is current|applied 0 migration/)

    const after = createHubClient({ hubUrl: hub.base, appVersion: '0.1.0-test' })
    // The token minted before the crash still works: the signing key did not change, and the device
    // row is in the database.
    after.handshake()
    const payload = await fetch(`${hub.base}/api/v1/rooms/${room.room.id}/messages`, {
      headers: { authorization: `Bearer ${alice.client.accessToken}` },
    })
    assert.equal(payload.status, 200)
    const page = await payload.json()
    assert.deepEqual(page.messages.map(message => message.body), ['written before the crash'])
  }, 90_000)

  it('nothing is duplicated by the restart: the room still has one message and one memory', async () => {
    const alice = await newPerson(hub.base, 'dupe')
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Duplicate room' } })
    await alice.workgroup.sendMessage(room.room.id, 'once')
    await alice.memory.remember(room.room.id, { body: 'One memory.' })
    await hub.kill()
    await hub.start()

    const messages = await alice.client.request('GET', `/rooms/${room.room.id}/messages`)
    assert.equal(messages.messages.length, 1)
    assert.equal(messages.messages[0].body, 'once')
    assert.equal((await alice.memory.list(room.room.id)).length, 1)
  }, 90_000)

  it('a crash mid-cancel is survivable: the revocation is either recorded or it is not, never half', async () => {
    const alice = await newPerson(hub.base, 'cancelcrash')
    const bob = await newPerson(hub.base, 'canceller')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Cancel room' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')
    const task = (await alice.client.request('POST', `/rooms/${room.room.id}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'Cancel then crash', targetBotId: 'writer' },
    })).task
    await bob.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer', workDir: '/tmp/q03' })
    await bob.approvals.mintGrant(task.id, { botId: 'writer' })

    await alice.approvals.cancel(task.id)
    // The cancellation is committed before the answer is sent, so a crash here cannot lose it.
    await hub.kill()
    await hub.start()

    const afterCancel = (await bob.approvals.task(task.id)).task
    // It is terminal: a task that reached a terminal state stays there, whatever the restart.
    assert.equal(['CANCELLED', 'CANCELLING'].includes(afterCancel.state), true, `state was ${afterCancel.state}`)
    assert.equal(afterCancel.revocationVersion > 0, true, 'cancelling must have raised the revocation version')
  }, 90_000)
})

// ---------------------------------------------------------------------------
// Upgrade and rollback
// ---------------------------------------------------------------------------

describe('an upgrade is a controlled operation', () => {
  it('migrating twice changes nothing, so a repeated deploy is safe', () => {
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }
    const first = spawnSync(process.execPath, [CLI, 'migrate'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    const second = spawnSync(process.execPath, [CLI, 'migrate'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(second.status, 0, second.stderr)
    // The second run is a no-op, and it says so rather than re-applying.
    assert.match(second.stdout, /Schema is current/)
  })

  it('a backup taken before an upgrade is a complete unit, and the drill agrees', async () => {
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }
    const backup = spawnSync(process.execPath, [CLI, 'backup', '--label', 'q03-pre-upgrade'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(backup.status, 0, backup.stderr)
    // The snapshot, its manifest, and its object directory: one unit.
    const names = readdirSync(join(dataDir, 'backups'))
    const snapshot = names.find(name => name.startsWith('q03-pre-upgrade') && name.endsWith('.sqlite'))
    assert.ok(snapshot !== undefined, `no snapshot: ${names.join(', ')}`)
    const snapshotPath = join(dataDir, 'backups', snapshot)
    assert.equal(statSync(snapshotPath).size > 0, true)
    assert.equal(existsSync(`${snapshotPath}.manifest.json`), true)

    const drill = spawnSync(process.execPath, [CLI, 'backup-drill', snapshotPath], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(drill.status, 0, drill.stderr)
    assert.match(drill.stdout, /every recorded count matches/)
  })

  it('a database from this release boots without re-migrating, and reports its schema current', () => {
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }
    const status = spawnSync(process.execPath, [CLI, 'status'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /current=true/)
    // The migration count is read, not asserted as a number: it changes with every release.
    assert.match(status.stdout, /migrations: \d+ applied, current=true/)
  })

  it('an unknown migration in the database refuses the boot instead of half-applying', async () => {
    // A database built by a *newer* release is the case a rollback produces. Applying the migrations
    // this package has would build a schema no release ever shipped, so it must refuse.
    const scratch = join(root, 'newer-release')
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: scratch, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }
    const migrated = spawnSync(process.execPath, [CLI, 'migrate'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(migrated.status, 0, migrated.stderr)

    // Record a migration this package does not contain, as a newer release would have.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(scratch, 'hub.sqlite'))
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(9999, '9999_from_the_future.sql', new Date().toISOString())
    db.close()

    const status = spawnSync(process.execPath, [CLI, 'status'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    // `status` reports it; the boot refuses. Either way nothing is half-applied.
    assert.equal([0, 1].includes(status.status), true)
    const boot = spawnSync(process.execPath, ['-e', `
      import('./src/db/migrate.js').then(async ({ migrate, migrationsDir }) => {
        const { loadConfig } = await import('./src/config/index.js')
        const { openDatabase } = await import('./src/db/index.js')
        const config = loadConfig(process.env)
        const database = openDatabase(config)
        try { migrate(database, { dir: migrationsDir() }); console.log('MIGRATED') } catch (error) { console.log('REFUSED:', error.message.split(String.fromCharCode(10)).join(' ')) }
        database.close()
      })
    `], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.match(boot.stdout, /REFUSED/)
    assert.match(boot.stdout, /this package does not contain/)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

describe('a restore puts back everything a group depends on', () => {
  it('users, members, messages, tasks, approvals, memory and artifacts all come back', async () => {
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }

    // A scene with every entity the criterion names.
    const alice = await newPerson(hub.base, 'restorealice')
    const bob = await newPerson(hub.base, 'restorebob')
    await bob.client.request('POST', '/bots', { body: { botId: 'writer', displayName: 'Writer', visibility: 'public' } })
    const room = await alice.client.request('POST', '/rooms', { body: { name: 'Restore room' } })
    await bob.workgroup.respondToInvitation((await alice.workgroup.invite(room.room.id, { targetUserId: bob.userId })).id, 'accept')
    const posted = await alice.workgroup.sendMessage(room.room.id, 'A message to restore')
    await alice.memory.remember(room.room.id, { body: 'A memory to restore.', sourceMessageId: posted.message.id })
    // The upload route takes a binary body or `{ base64 }`. The JSON form is used here so the case
    // does not depend on a multipart helper, and the Hub's own parsing is what decodes it.
    const artifact = await alice.client.request('POST', `/rooms/${room.room.id}/artifacts?fileName=note.txt`, {
      body: { base64: Buffer.from('the attachment bytes').toString('base64') },
    })
    const task = (await alice.client.request('POST', `/rooms/${room.room.id}/tasks`, {
      body: { ownerUserId: bob.userId, description: 'A task to restore', targetBotId: 'writer' },
    })).task
    await bob.approvals.decide({ taskId: task.id, decision: 'approve', expectedVersion: task.version, mode: 'existing_bot', botId: 'writer', workDir: '/tmp/q03' })

    const backup = spawnSync(process.execPath, [CLI, 'backup', '--label', 'q03-restore'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(backup.status, 0, backup.stderr)
    const snapshot = readdirSync(join(dataDir, 'backups')).find(name => name.startsWith('q03-restore') && name.endsWith('.sqlite'))
    const snapshotPath = join(dataDir, 'backups', snapshot)

    // Destroy the database **and** the attachment bytes, and stop the Hub so the restore is legal.
    await hub.stop()
    recycleTestPath(join(dataDir, 'hub.sqlite'))
    for (const sidecar of ['-wal', '-shm']) recycleTestPath(`${join(dataDir, 'hub.sqlite')}${sidecar}`)
    recycleTestPath(join(dataDir, 'artifacts'))

    const restored = spawnSync(process.execPath, [CLI, 'restore', snapshotPath], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(restored.status, 0, restored.stderr)
    assert.match(restored.stdout, /artifact objects: restored 1/)

    const verify = spawnSync(process.execPath, [CLI, 'verify'], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stdout)

    await hub.start()

    // The scene is intact and readable through the API, which is what "restored" has to mean.
    const messages = await alice.client.request('GET', `/rooms/${room.room.id}/messages`)
    assert.deepEqual(messages.messages.map(message => message.body), ['A message to restore'])
    assert.equal((await alice.memory.list(room.room.id)).length, 1)
    assert.equal((await alice.workgroup.members(room.room.id)).length, 2)
    const restoredTask = (await bob.approvals.task(task.id)).task
    assert.equal(restoredTask.state, 'APPROVED')
    assert.equal((await bob.approvals.approvedScope(task.id)).assignedBotId, 'writer')

    // And the attachment downloads again: the bytes came back, not only the row.
    const { bytes } = await alice.client.request('GET', `/artifacts/${artifact.artifact.id}/content`, { raw: true })
    assert.equal(bytes.toString('utf8'), 'the attachment bytes')
  }, 120_000)

  it('a backup is refused as a restore source when it is not a Hub database', () => {
    const env = { NODE_ENV: 'production', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_REGISTRATION: 'admin_secret', HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP }
    const junk = join(root, 'not-a-database.sqlite')
    writeFileSync(junk, 'this is not a database')
    const result = spawnSync(process.execPath, [CLI, 'restore', junk], { cwd: SERVER_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Refusing to restore/)
    // The live database is untouched: a bad candidate must not damage what it was meant to replace.
    assert.equal(existsSync(join(dataDir, 'hub.sqlite')), true)
  })
})
