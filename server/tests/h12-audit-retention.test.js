// H-12 tests: audit reading, retention, and a restore that is verified across entities.
//
// The completion condition is "a restore reproduces real rooms and state". The cases below build a
// Hub with every entity a group produces — users, members, messages, tasks, approvals, memory,
// artifacts, audit — back it up, destroy it, restore it, and compare. Comparing per-entity counts is
// what makes that evidence: a restore that merely opens proves nothing about the data.
//
// Retention gets its own group because it is the one operation that destroys the audit trail. Its
// cases check that it refuses to run without a configured window, that a dry run changes nothing,
// and that the run is recorded.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { createBackup, restoreBackup, verifyDatabaseFile, readBackupManifest, entityCounts, compareEntityCounts } from '../src/db/backup.js'
import { pruneAudit, cutoffForDays, listRetentionRuns, listAuditEvents, countAuditEvents, auditEventTypes } from '../src/modules/audit/store.js'

const SIGNING_KEY = 'h12-test-signing-key-long-enough-for-hs256'

/** A Hub with a real group scene: every entity the criteria name, in one database. */
async function withPopulatedHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h12-'))
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token, binary = false) => {
    const headers = {}
    let payload
    if (body !== undefined) {
      if (binary) { headers['content-type'] = 'application/octet-stream'; payload = body }
      else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({ method, url: `/api/v1${path}`, headers, payload })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  const person = async (handle, displayName) => {
    const password = `${handle}-password-long-enough`
    await call('POST', '/auth/register', { userHandle: handle, displayName: displayName ?? handle, password })
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  /** Build the whole scene, so a backup has every entity to lose. */
  const buildScene = async () => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: bob.userId }, alice.token)
    await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, bob.token)
    await call('POST', '/bots', { botId: 'chief', displayName: 'Chief', visibility: 'public' }, bob.token)
    const message = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'client-msg-000001', body: '请制作季度报表' }, alice.token)
    const memory = await call('POST', `/rooms/${roomId}/memories`, { body: '季度报表以开票日为准', sourceMessageId: message.body.message.id }, alice.token)
    const task = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: bob.userId, targetBotId: 'chief', description: '制作报表' }, alice.token)
    const decided = await call('POST', `/tasks/${task.body.task.id}/decision`, {
      decision: 'approve', expectedVersion: 0, assignmentMode: 'existing_bot', assignedBotId: 'chief',
      approvedScope: { allowedTools: ['read_file'], workDir: 'reports' },
    }, bob.token)
    assert.equal(decided.status, 200, decided.raw)
    const grant = await call('POST', `/tasks/${task.body.task.id}/grant`, {}, bob.token)
    assert.equal(grant.status, 201, grant.raw)
    const artifact = await call('POST', `/rooms/${roomId}/artifacts?fileName=report.csv&recipients=${bob.userId}`,
      Buffer.from('quarterly'), alice.token, true)
    assert.equal(artifact.status, 201, artifact.raw)
    return { alice, bob, roomId, messageId: message.body.message.id, memoryId: memory.body.memory.id, taskId: task.body.task.id, artifactId: artifact.body.artifact.id }
  }
  try {
    await run({ root, config, db, server, call, person, buildScene })
  } finally {
    await server.close()
    // A restore case must close the handle to replace the file underneath it, so the teardown
    // cannot assume the handle is still open.
    try {
      db.close()
    } catch {
      // Already closed by the case.
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ---------------------------------------------------------------- the restore drill

test('a backup is a complete snapshot of every entity a group produces', async (t) => {
  await withPopulatedHub(async ({ config, db, buildScene }) => {
    await buildScene()
    const backup = await createBackup(db, { backupDir: config.backupDir })
    const manifest = readBackupManifest(backup.path)

    // Every entity the acceptance criteria name has at least one row in the snapshot.
    const counts = manifest.entityCounts
    assert.equal(counts.users, 2)
    assert.equal(counts.devices, 2)
    assert.equal(counts.rooms, 1)
    assert.equal(counts.room_members, 2)
    assert.equal(counts.messages, 1)
    assert.equal(counts.bot_directory, 1)
    assert.equal(counts.tasks, 1)
    assert.equal(counts.approvals, 1)
    assert.equal(counts.dispatch_grants, 1)
    assert.equal(counts.artifacts, 1)
    assert.equal(counts.group_memories, 1)
    assert.ok(counts.audit_events > 0, 'the audit trail must be in the snapshot too')
    // A count that could not be read is reported rather than zero, so a missing table is visible.
    for (const [table, value] of Object.entries(counts)) {
      assert.equal(typeof value, 'number', `${table} should have a numeric count, got ${String(value)}`)
    }
  })
})

test('restoring reproduces every entity, and the drill finds no differences', async (t) => {
  await withPopulatedHub(async ({ config, db, buildScene }) => {
    const scene = await buildScene()
    const backup = await createBackup(db, { backupDir: config.backupDir })
    const manifest = readBackupManifest(backup.path)
    const before = entityCounts(db)
    assert.deepEqual(compareEntityCounts(manifest.entityCounts, before), [], 'the manifest must describe the live database')

    // Destroy the live data the way a failed upgrade or an operator mistake would.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['memory_revisions', 'group_memories', 'artifacts', 'dispatch_grants', 'approvals', 'task_events', 'tasks', 'messages', 'bot_directory', 'room_members', 'rooms', 'refresh_tokens', 'devices', 'users', 'audit_events']) {
      db.exec(`DELETE FROM ${table}`)
    }
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
    db.close()

    restoreBackup({ dbPath: config.dbPath, backupPath: backup.path })
    const restored = openDatabase({ ...config, production: false })
    try {
      // The comparison the acceptance criteria ask for: same rows in every entity.
      assert.deepEqual(compareEntityCounts(manifest.entityCounts, entityCounts(restored)), [])
      // And the restored rows are the real ones, not placeholders.
      assert.equal(restored.prepare('SELECT state FROM tasks').get().state, 'APPROVED')
      assert.equal(restored.prepare('SELECT decision FROM approvals').get().decision, 'approve')
      assert.equal(restored.prepare('SELECT body FROM group_memories').get().body, '季度报表以开票日为准')
      assert.equal(restored.prepare('SELECT file_name FROM artifacts').get().file_name, 'report.csv')
      assert.equal(restored.prepare('SELECT name FROM rooms').get().name, 'Finance')
      assert.ok(restored.prepare('SELECT count(*) AS n FROM audit_events').get().n > 0)
    } finally {
      restored.close()
    }
    assert.ok(scene.taskId.length > 0)
  })
})

test('a restored database serves the same API results as the original', async (t) => {
  await withPopulatedHub(async ({ config, db, call, buildScene }) => {
    const scene = await buildScene()
    const backup = await createBackup(db, { backupDir: config.backupDir })
    // Read one result through the live API before the restore.
    const beforeTasks = (await call('GET', `/rooms/${scene.roomId}/tasks`, undefined, scene.alice.token)).body.tasks.length
    const beforeMemory = (await call('GET', `/rooms/${scene.roomId}/memories`, undefined, scene.alice.token)).body.memories.length

    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['group_memories', 'tasks', 'messages', 'rooms']) db.exec(`DELETE FROM ${table}`)
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
    db.close()

    restoreBackup({ dbPath: config.dbPath, backupPath: backup.path })
    const restored = openDatabase({ ...config, production: false })
    const restoredServer = await createServer({ config, db: restored, logger: false })
    try {
      // The same call against the restored database must answer the same way.
      const headers = { authorization: `Bearer ${scene.alice.token}` }
      const tasks = await restoredServer.inject({ method: 'GET', url: `/api/v1/rooms/${scene.roomId}/tasks`, headers })
      const memory = await restoredServer.inject({ method: 'GET', url: `/api/v1/rooms/${scene.roomId}/memories`, headers })
      assert.equal(tasks.json().tasks.length, beforeTasks)
      assert.equal(memory.json().memories.length, beforeMemory)
    } finally {
      await restoredServer.close()
      restored.close()
    }
  })
})

test('a drill reports a mismatch rather than passing when a table is missing from the snapshot', () => {
  // A backup taken by an older build lacks a table this build expects. The comparison must name it
  // instead of treating the absence as an empty entity.
  const differences = compareEntityCounts({ users: 2, rooms: 1, approvals: 1 }, { users: 2, rooms: 1 })
  assert.deepEqual(differences, [{ table: 'approvals', before: 1, after: null }])
  // And a table the snapshot does not know about is reported the other way round.
  assert.deepEqual(compareEntityCounts({ users: 1 }, { users: 1, dispatch_grants: 3 }), [
    { table: 'dispatch_grants', before: null, after: 3 },
  ])
})

test('entityCounts names a table it cannot read instead of reporting zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h12-counts-'))
  const db = openDatabase({ dbPath: join(dir, 'x.sqlite'), production: false })
  try {
    const counts = entityCounts(db)
    // Nothing migrated: every table is unavailable, and none of them reads as `0`.
    assert.equal(typeof counts.users, 'string')
    assert.match(counts.users, /unavailable/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})

// ---------------------------------------------------------------- audit reading

test('the audit trail is queryable by object, outcome, and window, and always bounded', async (t) => {
  await withPopulatedHub(async ({ db, buildScene }) => {
    const scene = await buildScene()
    // Object-scoped: every event about one task, newest first.
    const taskEvents = listAuditEvents(db, { objectType: 'task', objectId: scene.taskId })
    assert.ok(taskEvents.length >= 2, `expected task events, got ${taskEvents.length}`)
    assert.ok(taskEvents.every(event => event.object_type === 'task' && event.object_id === scene.taskId))
    assert.equal(countAuditEvents(db, { objectType: 'task', objectId: scene.taskId }), taskEvents.length)

    // Outcome-scoped: the first question after a security report.
    const refusals = listAuditEvents(db, { outcome: 'refused' })
    assert.ok(Array.isArray(refusals))

    // A window that excludes everything returns nothing rather than the whole trail.
    assert.deepEqual(listAuditEvents(db, { since: '2999-01-01T00:00:00.000Z' }), [])
    // An unbounded request is still bounded.
    assert.ok(listAuditEvents(db, { limit: 1_000_000 }).length <= 500)
    assert.ok(listAuditEvents(db, { limit: 0 }).length >= 1)
    // The types the Hub has written are discoverable.
    const types = auditEventTypes(db)
    for (const expected of ['room.created', 'message.created', 'task.created', 'memory.created', 'artifact.uploaded', 'user.created']) {
      assert.ok(types.includes(expected), `expected ${expected} in ${types.join(', ')}`)
    }
  })
})

test('reading the audit trail over HTTP is scoped to the caller and bounded', async (t) => {
  await withPopulatedHub(async ({ call, person, buildScene }) => {
    const scene = await buildScene()
    // A caller sees their own events by default.
    const mine = await call('GET', '/audit', undefined, scene.alice.token)
    assert.equal(mine.status, 200)
    assert.ok(mine.body.events.length > 0)
    assert.ok(mine.body.events.every(event => event.actorUserId === scene.alice.userId))

    // Asking for somebody else's trail is refused: this Hub has no operator role, and a query
    // parameter must not become one.
    const theirs = await call('GET', `/audit?actorUserId=${scene.bob.userId}`, undefined, scene.alice.token)
    assert.equal(theirs.status, 403)
    assert.equal(theirs.body.error.code, 'NOT_YOUR_TRAIL')

    // An object in a room the caller is in is readable through the object filter.
    const forTask = await call('GET', `/audit?objectType=task&objectId=${scene.taskId}`, undefined, scene.alice.token)
    assert.equal(forTask.status, 200)
    assert.ok(forTask.body.events.length >= 2)

    // An object in a room they are not in is answered as an empty page, not as an error.
    const outsider = await person('outsider', 'Out')
    const outside = await call('GET', `/audit?objectType=task&objectId=${scene.taskId}`, undefined, outsider.token)
    assert.equal(outside.status, 200)
    assert.deepEqual(outside.body.events, [])
    assert.equal(outside.body.total, 0)
  })
})

test("one audit event is readable by its actor and by a member of the object's room, and not otherwise", async (t) => {
  await withPopulatedHub(async ({ db, call, buildScene }) => {
    const scene = await buildScene()
    const event = listAuditEvents(db, { objectType: 'room', objectId: scene.roomId })[0]
    // Its actor sees it.
    assert.equal((await call('GET', `/audit/${event.id}`, undefined, scene.alice.token)).status, 200)
    // A member of the room sees it too, because the trail of a room is room data.
    assert.equal((await call('GET', `/audit/${event.id}`, undefined, scene.bob.token)).status, 200)
    // An unknown id is answered as missing.
    const missing = await call('GET', '/audit/00000000-0000-4000-8000-000000000000', undefined, scene.alice.token)
    assert.equal(missing.status, 404)
  })
})

test('an unauthenticated caller cannot read the audit trail', async (t) => {
  await withPopulatedHub(async ({ call }) => {
    assert.equal((await call('GET', '/audit')).status, 401)
    assert.equal((await call('GET', '/audit/types')).status, 401)
    assert.equal((await call('GET', '/audit/retention/runs')).status, 401)
  })
})

// ---------------------------------------------------------------- retention

test('retention is off by default, because an audit trail is not ordinary data', async (t) => {
  await withPopulatedHub(async ({ config }) => {
    // The trail records the decisions the Hub enforced, so "keep forever" is the default and an
    // operator has to opt into a window.
    assert.equal(config.retention.auditRetentionDays, null)
    assert.equal(config.retention.backupRetentionCount, 30)
  })
})

test('a retention dry run reports what would go and deletes nothing', async (t) => {
  await withPopulatedHub(async ({ db, buildScene }) => {
    await buildScene()
    const total = countAuditEvents(db)
    // A cutoff in the future would remove everything, which is exactly the mistake a dry run exists
    // to catch before it is made.
    const result = pruneAudit(db, { cutoff: '2999-01-01T00:00:00.000Z', dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.wouldDelete, total)
    assert.equal(result.deleted, 0)
    assert.equal(countAuditEvents(db), total, 'a dry run must not delete anything')
    assert.deepEqual(listRetentionRuns(db), [], 'a dry run is not a run')
  })
})

test('a retention run deletes only what is older than the cutoff, and records itself', async (t) => {
  await withPopulatedHub(async ({ db, buildScene }) => {
    await buildScene()
    const now = new Date()
    // Move half the events into the past so the cutoff has something to find.
    const events = listAuditEvents(db, { limit: 500 })
    const half = Math.floor(events.length / 2)
    for (const event of events.slice(0, half)) {
      db.prepare('UPDATE audit_events SET occurred_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', event.id)
    }
    const cutoff = cutoffForDays(30, now)
    const result = pruneAudit(db, { cutoff, now })
    assert.equal(result.deleted, half)
    assert.equal(result.kept, events.length - half)
    assert.equal(countAuditEvents(db), events.length - half)

    // The run is recorded, so "why is this event gone" has an answer.
    const runs = listRetentionRuns(db)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].scope, 'audit')
    assert.equal(runs[0].deleted_count, half)
    assert.equal(runs[0].cutoff, cutoff)
  })
})

test("retention never touches the room's state, only its older trail", async (t) => {
  await withPopulatedHub(async ({ db, buildScene }) => {
    const scene = await buildScene()
    // Aggressive retention: every event older than a day goes.
    pruneAudit(db, { cutoff: cutoffForDays(1) })
    // The entities themselves are untouched: retention governs the trail, not the data.
    assert.equal(db.prepare('SELECT count(*) AS n FROM rooms').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 1)
    assert.equal(db.prepare('SELECT count(*) AS n FROM group_memories').get().n, 1)
    assert.equal(db.prepare('SELECT state FROM tasks').get().state, 'APPROVED')
    assert.equal(db.prepare('SELECT decision FROM approvals').get().decision, 'approve')
    assert.ok(scene.memoryId.length > 0)
  })
})

test('retention needs a cutoff and rejects an unusable age', async (t) => {
  await withPopulatedHub(async ({ db }) => {
    assert.throws(() => pruneAudit(db, {}), /cutoff is required/)
    assert.throws(() => cutoffForDays(0), /positive integer/)
    assert.throws(() => cutoffForDays(-1), /positive integer/)
    assert.throws(() => cutoffForDays(1.5), /positive integer/)
  })
})

test('the retention run log is readable over HTTP with the configured window', async (t) => {
  await withPopulatedHub(async ({ call, db, person: makePerson, buildScene }) => {
    await buildScene()
    const alice = await makePerson('alice2', 'Alice Two')
    pruneAudit(db, { cutoff: cutoffForDays(1) })
    const response = await call('GET', '/audit/retention/runs', undefined, alice.token)
    assert.equal(response.status, 200)
    assert.equal(response.body.auditRetentionDays, null)
    assert.equal(response.body.runs.length, 1)
  })
})
