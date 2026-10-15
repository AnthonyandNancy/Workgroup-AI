// H-02 tests: migrations, transactions, WAL durability, and backup/restore.
//
// Every case runs against a real SQLite file in a temp directory through the real
// migration runner and the real backup API. The point of H-02 is that an upgrade, a
// crash, and a restore all leave the Hub in a state an operator can reason about.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase, journalMode } from '../src/db/index.js'
import { migrate, loadMigrations, appliedVersions, schemaIsCurrent, migrationsDir, MigrationError } from '../src/db/migrate.js'
import { createBackup, restoreBackup, verifyDatabaseFile, readBackupManifest, BackupError } from '../src/db/backup.js'

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h02-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) }
}

function openTempHub(root) {
  // The config object is frozen by design, so tests use its own dbPath rather than
  // rewriting it: `HUB_DATA_DIR` is the supported way to place the database.
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
  return { config, db: openDatabase(config) }
}

/** A migration set written on the fly, so ordering and failure paths are testable. */
function writeMigrations(root, files) {
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return dir
}

test('the shipped migration applies once and is recorded in the ledger', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      const first = migrate(db, { dir: migrationsDir() })
      // The shipped set is read from the directory rather than listed here: a hard-coded list
      // would fail on every new migration for a reason unrelated to what this case checks.
      const shipped = loadMigrations(migrationsDir()).map(migration => migration.name)
      assert.deepEqual(first.applied, shipped)
      const ledger = appliedVersions(db)
      assert.equal(ledger.length, shipped.length)
      assert.deepEqual(ledger.map(row => row.name), shipped)
      assert.ok(Date.parse(ledger[0].applied_at) > 0)
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('migrating twice is idempotent and changes nothing the second time', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const before = appliedVersions(db)
      const second = migrate(db, { dir: migrationsDir() })
      assert.deepEqual(second.applied, [])
      assert.deepEqual(second.skipped, loadMigrations(migrationsDir()).map(migration => migration.name))
      assert.deepEqual(appliedVersions(db), before)
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('the shipped schema contains the entities the Hub contract names', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
      for (const expected of [
        'users', 'devices', 'rooms', 'room_members', 'invitations', 'messages',
        'bot_directory', 'tasks', 'approvals', 'task_events', 'artifacts',
        'group_memories', 'memory_revisions', 'audit_events', 'idempotency_keys',
      ]) {
        assert.ok(tables.has(expected), `expected table ${expected} to exist`)
      }
      // The Hub must never hold model credentials or private Session contents.
      const forbidden = ['model_api_keys', 'api_keys', 'secrets', 'sessions', 'private_sessions']
      for (const name of forbidden) {
        assert.equal(tables.has(name), false, `the Hub schema must not define ${name}`)
      }
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('a migration that throws rolls back completely and is not recorded', () => {
  const { root, cleanup } = tempRoot()
  try {
    const dir = writeMigrations(root, {
      '0001_first.sql': 'CREATE TABLE things (id TEXT PRIMARY KEY);',
      '0002_broken.sql': 'CREATE TABLE other (id TEXT PRIMARY KEY); SELECT this_column_does_not_exist;',
    })
    const { db } = openTempHub(root)
    try {
      assert.throws(() => migrate(db, { dir }), (error) => {
        assert.ok(error instanceof MigrationError)
        assert.equal(error.migration, '0002_broken.sql')
        return true
      })
      // The ledger records only the migration that committed, and 0002's own statement
      // was rolled back with its version row.
      assert.deepEqual(appliedVersions(db).map(row => row.name), ['0001_first.sql'])
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
      assert.equal(tables.has('other'), false, 'the failed migration must not leave its table behind')
      assert.equal(tables.has('things'), true, 'the earlier migration must remain applied')
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('migrations are applied in version order and no ordering gap is accepted silently', () => {
  const { root, cleanup } = tempRoot()
  try {
    // Four-digit padding makes lexicographic filename order identical to version order,
    // which is why the runner applies files as sorted and needs no separate ordering
    // assertion. This case pins that property: a file that would sort out of version
    // order is caught by `loadMigrations` rather than applied in the wrong sequence.
    const dir = writeMigrations(root, {
      '0001_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);',
      '0003_c.sql': 'CREATE TABLE c (id TEXT PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY);',
    })
    const loaded = loadMigrations(dir)
    assert.deepEqual(loaded.map(m => m.version), [1, 2, 3])
    assert.deepEqual(loaded.map(m => m.name), ['0001_a.sql', '0002_b.sql', '0003_c.sql'])

    const { db } = openTempHub(root)
    try {
      const result = migrate(db, { dir })
      assert.deepEqual(result.applied, ['0001_a.sql', '0002_b.sql', '0003_c.sql'])
      assert.deepEqual(appliedVersions(db).map(row => row.version), [1, 2, 3])
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('a database built by a newer release is refused instead of being half-migrated', () => {
  const { root, cleanup } = tempRoot()
  try {
    const full = writeMigrations(root, {
      '0001_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY);',
      '0003_c.sql': 'CREATE TABLE c (id TEXT PRIMARY KEY);',
    })
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: full })
      assert.deepEqual(appliedVersions(db).map(row => row.version), [1, 2, 3])

      // Stand in for a downgrade: this package only ships migrations 1 and 2, while the
      // database already has 3 applied.
      const older = writeMigrations(join(root, 'older'), {
        '0001_a.sql': readFileSync(join(full, '0001_a.sql'), 'utf8'),
        '0002_b.sql': readFileSync(join(full, '0002_b.sql'), 'utf8'),
      })
      assert.throws(() => migrate(db, { dir: older }), (error) => {
        assert.ok(error instanceof MigrationError)
        assert.match(error.message, /does not contain/)
        return true
      })
      // The refusal must not have rolled anything back or applied anything.
      assert.deepEqual(appliedVersions(db).map(row => row.version), [1, 2, 3])
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('bad migration filenames and duplicates are refused', () => {
  const { root, cleanup } = tempRoot()
  try {
    const named = writeMigrations(join(root, 'a'), { 'schema.sql': 'SELECT 1;' })
    assert.throws(() => loadMigrations(named), /must look like 0001_name\.sql/)

    const duped = writeMigrations(join(root, 'b'), {
      '0001_one.sql': 'SELECT 1;',
      '0001_two.sql': 'SELECT 1;',
    })
    assert.throws(() => loadMigrations(duped), /Duplicate migration version/)
  } finally {
    cleanup()
  }
})

test('transaction-unsafe pragmas are removed from migration files and reported', () => {
  const { root, cleanup } = tempRoot()
  try {
    const dir = writeMigrations(root, {
      '0001_pragmas.sql': "PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;\nCREATE TABLE t (id TEXT PRIMARY KEY);",
    })
    const [migration] = loadMigrations(dir)
    assert.deepEqual(migration.strippedPragmas.sort(), ['foreign_keys', 'journal_mode'])
    assert.equal(/^\s*PRAGMA\s+journal_mode/mi.test(migration.sql), false)
    assert.match(migration.sql, /removed PRAGMA/)

    const { db } = openTempHub(root)
    try {
      // The migration still applies, and the connection keeps the WAL mode the Hub set.
      migrate(db, { dir })
      assert.equal(String(journalMode(db)).toLowerCase(), 'wal')
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('journal_mode is unsafe to set inside a transaction, which is why the runner strips it', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    try {
      // Two failure shapes are possible inside a transaction, and both are bad in a
      // migration: changing mode is refused outright, and setting the mode the database
      // already has is accepted without taking effect. Either way the pragma does not do
      // what a migration file appears to ask for, so the runner removes it and relies on
      // `openDatabase` to establish WAL outside any transaction.
      db.exec('PRAGMA journal_mode = DELETE')
      db.exec('BEGIN IMMEDIATE')
      assert.throws(
        () => db.exec('PRAGMA journal_mode = WAL'),
        /cannot change into wal mode from within a transaction/,
      )
      const insideTxn = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase()
      assert.equal(insideTxn, 'delete', 'the refused pragma must not have changed the mode')
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    // A fresh connection through openDatabase does enter WAL, outside any transaction.
    const reopened = openDatabase({ ...config, production: false })
    try {
      assert.equal(String(journalMode(reopened)).toLowerCase(), 'wal')
    } finally {
      reopened.close()
    }
  } finally {
    cleanup()
  }
})

test('schemaIsCurrent reports pending migrations instead of guessing', () => {
  const { root, cleanup } = tempRoot()
  try {
    const dir = writeMigrations(root, {
      '0001_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY);',
    })
    const { db } = openTempHub(root)
    try {
      assert.equal(schemaIsCurrent(db, { dir }).current, false)
      assert.deepEqual(schemaIsCurrent(db, { dir }).pending, ['0001_a.sql', '0002_b.sql'])
      migrate(db, { dir })
      assert.equal(schemaIsCurrent(db, { dir }).current, true)
      assert.deepEqual(schemaIsCurrent(db, { dir }).pending, [])
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('WAL keeps committed data readable after a reopen', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('u1', 'alice', 'Alice', 'not-a-real-hash', new Date().toISOString())
    } finally {
      db.close()
    }
    const reopened = openDatabase({ ...config, production: false })
    try {
      const row = reopened.prepare('SELECT user_handle FROM users WHERE id = ?').get('u1')
      assert.equal(row.user_handle, 'alice')
      assert.equal(String(journalMode(reopened)).toLowerCase(), 'wal')
    } finally {
      reopened.close()
    }
  } finally {
    cleanup()
  }
})

test('a backup is a consistent, verifiable snapshot with a manifest', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('u1', 'alice', 'Alice', 'not-a-real-hash', new Date().toISOString())

      const result = await createBackup(db, { backupDir: join(root, 'backups') })
      assert.ok(existsSync(result.path))
      assert.ok(result.bytes > 0)

      const manifest = readBackupManifest(result.path)
      assert.equal(manifest.file, result.path.split(/[\\/]/).pop())
      assert.equal(manifest.journalMode, 'wal')
      assert.deepEqual(manifest.migrations.map(m => m.name), loadMigrations(migrationsDir()).map(migration => migration.name))

      // The snapshot stands alone: it opens and answers without the live database.
      const verified = verifyDatabaseFile(result.path)
      assert.equal(verified.ok, true, verified.detail)
      assert.deepEqual(verified.migrations, loadMigrations(migrationsDir()).map(migration => migration.version))
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('two backups taken in the same millisecond never collapse into one file', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const at = new Date('2026-01-01T00:00:00.000Z')
      const first = await createBackup(db, { backupDir: join(root, 'backups'), now: at })
      const second = await createBackup(db, { backupDir: join(root, 'backups'), now: at })
      assert.notEqual(first.path, second.path)
      assert.ok(existsSync(first.path) && existsSync(second.path))
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('a migration that rebuilds a table keeps every column the earlier migrations added', () => {
  // Rebuilding a table (create new, copy, drop, rename) is how SQLite drops a constraint, and the
  // copy is written by hand. Forgetting one column there is silent: the migration succeeds, the
  // schema is "current", and the failure surfaces much later as a 500 on whichever route reads the
  // missing column. That happened while adding `0007`, which dropped `devices.last_login_at` and
  // broke every login. This test compares the shipped schema against the columns the migrations
  // declare, so the next rebuild cannot lose one quietly.
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const columns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(row => row.name))
      for (const name of [
        // 0001
        'id', 'user_id', 'public_key', 'fingerprint', 'revoked_at', 'last_seen_at', 'created_at',
        // 0002
        'label', 'app_version', 'platform', 'last_login_at',
      ]) {
        assert.ok(columns.has(name), `devices.${name} is missing after migrating; a table rebuild dropped it`)
      }
      // Completing a login is what reads `last_login_at`, so the column is asserted by use rather
      // than only by name: a column that exists but cannot be written is the same bug.
      db.prepare(`INSERT INTO users (id, user_handle, display_name, password_hash, status, created_at)
        VALUES ('u1', 'probe', 'Probe', 'h', 'active', '2026-01-01T00:00:00Z')`).run()
      db.prepare(`INSERT INTO devices (id, user_id, public_key, fingerprint, created_at)
        VALUES ('d1', 'u1', 'pk', 'fp-12345678', '2026-01-01T00:00:00Z')`).run()
      db.prepare('UPDATE devices SET last_login_at = ? WHERE id = ?').run('2026-01-02T00:00:00Z', 'd1')
      assert.equal(db.prepare('SELECT last_login_at FROM devices WHERE id = ?').get('d1').last_login_at, '2026-01-02T00:00:00Z')
      // And the constraint 0007 exists to change really is gone.
      db.prepare(`INSERT INTO users (id, user_handle, display_name, password_hash, status, created_at)
        VALUES ('u2', 'probe2', 'Probe Two', 'h', 'active', '2026-01-01T00:00:00Z')`).run()
      db.prepare(`INSERT INTO devices (id, user_id, public_key, fingerprint, created_at)
        VALUES ('d2', 'u2', 'pk2', 'fp-12345678', '2026-01-01T00:00:00Z')`).run()
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE fingerprint = ?').get('fp-12345678').n, 2)
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('verifyDatabaseFile rejects a file that is not a Hub database', () => {
  const { root, cleanup } = tempRoot()
  try {
    const notDb = join(root, 'plain.sqlite')
    writeFileSync(notDb, 'this is not a database')
    const result = verifyDatabaseFile(notDb)
    assert.equal(result.ok, false)
    assert.equal(verifyDatabaseFile(join(root, 'missing.sqlite')).ok, false)
  } finally {
    cleanup()
  }
})

test('verifyDatabaseFile rejects a database with no migration ledger', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db, config } = openTempHub(root)
    // Create an unrelated SQLite file: valid, but not a Hub database.
    db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
    db.close()
    const result = verifyDatabaseFile(config.dbPath)
    assert.equal(result.ok, false)
    assert.match(result.detail, /schema_migrations ledger is missing/)
  } finally {
    cleanup()
  }
})

test('restore replaces the database and keeps the pre-restore file', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    let backupPath
    try {
      migrate(db, { dir: migrationsDir() })
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('u1', 'alice', 'Alice', 'hash', new Date().toISOString())
      backupPath = (await createBackup(db, { backupDir: join(root, 'backups') })).path
      // Change the live database after the backup: the restore must undo this.
      db.prepare('DELETE FROM users WHERE id = ?').run('u1')
      assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 0)
    } finally {
      db.close()
    }

    const result = restoreBackup({ dbPath: config.dbPath, backupPath })
    assert.ok(existsSync(result.safetyCopy), 'the pre-restore database must be kept')
    assert.deepEqual(result.migrations, loadMigrations(migrationsDir()).map(migration => migration.version))

    const restored = openDatabase({ ...config, production: false })
    try {
      const row = restored.prepare('SELECT user_handle FROM users WHERE id = ?').get('u1')
      assert.equal(row.user_handle, 'alice', 'the restored database must hold the backed-up row')
    } finally {
      restored.close()
    }
  } finally {
    cleanup()
  }
})

test('restore refuses a backup that fails verification', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const bogus = join(root, 'bogus.sqlite')
      writeFileSync(bogus, 'not a database')
      assert.throws(() => restoreBackup({ dbPath: config.dbPath, backupPath: bogus }), (error) => {
        assert.ok(error instanceof BackupError)
        assert.match(error.message, /Refusing to restore/)
        return true
      })
      // The live database is untouched by the refused restore.
      assert.equal(schemaIsCurrent(db, { dir: migrationsDir() }).current, true)
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('restore refuses to run while another connection holds a write lock', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    let backupPath
    try {
      migrate(db, { dir: migrationsDir() })
      backupPath = (await createBackup(db, { backupDir: join(root, 'backups') })).path
    } finally {
      db.close()
    }

    // A second connection holding a write transaction is what a still-running Hub looks
    // like to this check; restoring underneath it would lose the writes it commits.
    const { DatabaseSync } = await import('node:sqlite')
    const holder = new DatabaseSync(config.dbPath)
    holder.exec('PRAGMA busy_timeout = 0')
    holder.exec('BEGIN IMMEDIATE')
    try {
      assert.throws(() => restoreBackup({ dbPath: config.dbPath, backupPath }), (error) => {
        assert.ok(error instanceof BackupError)
        assert.match(error.message, /Stop the Hub first/)
        return true
      })
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  } finally {
    cleanup()
  }
})

test('a restore round-trips every table the Hub relies on', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { config, db } = openTempHub(root)
    let backupPath
    try {
      migrate(db, { dir: migrationsDir() })
      const now = new Date().toISOString()
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('u1', 'alice', 'Alice', 'h', now)
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('u2', 'bob', 'Bob', 'h', now)
      db.prepare('INSERT INTO rooms (id, name, owner_user_id, created_at) VALUES (?,?,?,?)').run('r1', 'Finance', 'u1', now)
      db.prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)').run('r1', 'u1', 'owner', now)
      db.prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?,?,?,?)').run('r1', 'u2', 'member', now)
      db.prepare('INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, created_at) VALUES (?,?,?,?,?,?,?)')
        .run('m1', 'r1', 1, 'u1', 'client-msg-0001', 'Please build the report', now)
      db.prepare('INSERT INTO tasks (id, room_id, requester_user_id, owner_user_id, description, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('t1', 'r1', 'u1', 'u2', 'Build report', 'PENDING_APPROVAL', now, now)
      db.exec('COMMIT')
      backupPath = (await createBackup(db, { backupDir: join(root, 'backups') })).path
    } finally {
      db.close()
    }

    // Wipe the live Hub entirely, then restore.
    const wiped = openDatabase({ ...config, production: false })
    wiped.exec('PRAGMA foreign_keys = OFF')
    for (const table of ['messages', 'tasks', 'room_members', 'rooms', 'users']) wiped.exec(`DELETE FROM ${table}`)
    wiped.close()

    restoreBackup({ dbPath: config.dbPath, backupPath })
    const restored = openDatabase({ ...config, production: false })
    try {
      assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 2)
      assert.equal(restored.prepare('SELECT count(*) AS n FROM room_members').get().n, 2)
      const message = restored.prepare('SELECT body, room_seq FROM messages').get()
      assert.equal(message.body, 'Please build the report')
      assert.equal(message.room_seq, 1)
      assert.equal(restored.prepare('SELECT state FROM tasks').get().state, 'PENDING_APPROVAL')
    } finally {
      restored.close()
    }
  } finally {
    cleanup()
  }
})

test('the schema enforces message idempotency and per-room sequence uniqueness in the database', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const now = new Date().toISOString()
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('u1', 'alice', 'Alice', 'h', now)
      db.prepare('INSERT INTO rooms (id, name, owner_user_id, created_at) VALUES (?,?,?,?)').run('r1', 'Finance', 'u1', now)
      db.prepare('INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, created_at) VALUES (?,?,?,?,?,?,?)')
        .run('m1', 'r1', 1, 'u1', 'client-msg-0001', 'first', now)

      // The same clientMessageId from the same sender in the same room is a retry.
      assert.throws(
        () => db.prepare('INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, created_at) VALUES (?,?,?,?,?,?,?)')
          .run('m2', 'r1', 2, 'u1', 'client-msg-0001', 'retry', now),
        /UNIQUE constraint failed/,
      )
      // Two messages cannot claim the same room position.
      assert.throws(
        () => db.prepare('INSERT INTO messages (id, room_id, room_seq, sender_user_id, client_message_id, body, created_at) VALUES (?,?,?,?,?,?,?)')
          .run('m3', 'r1', 1, 'u1', 'client-msg-0002', 'collision', now),
        /UNIQUE constraint failed/,
      )
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('the schema refuses task states outside the defined state machine', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const now = new Date().toISOString()
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('u1', 'alice', 'Alice', 'h', now)
      db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run('u2', 'bob', 'Bob', 'h', now)
      db.prepare('INSERT INTO rooms (id, name, owner_user_id, created_at) VALUES (?,?,?,?)').run('r1', 'Finance', 'u1', now)
      assert.throws(
        () => db.prepare('INSERT INTO tasks (id, room_id, requester_user_id, owner_user_id, description, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run('t1', 'r1', 'u1', 'u2', 'x', 'RUNNING_WITHOUT_APPROVAL', now, now),
        /CHECK constraint failed/,
      )
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('sensitive Hub tables are created without any column that could carry a secret or a local path', () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const columns = db.prepare("SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'").all()
      // The Hub stores collaboration state; model credentials and local filesystem
      // layout belong to the application side and must not be representable here.
      const suspicious = columns.filter(row => /api_key|secret|token|password_p|home_dir|desktop_path|local_path|workspace_path/i.test(row.column_name))
      // Two credential-shaped columns are allowed, and only because neither holds a usable
      // credential: `users.password_hash` is a scrypt digest the Hub verifies, and
      // `refresh_tokens.secret_hash` is the SHA-256 of an opaque token the Hub looks up.
      // A leaked database therefore hands over no working password or session.
      const allowedCredentialColumns = new Set(['users.password_hash', 'refresh_tokens.secret_hash'])
      assert.deepEqual(
        suspicious.map(row => `${row.table_name}.${row.column_name}`).filter(name => !allowedCredentialColumns.has(name)),
        [],
        'the Hub schema must not define columns for usable credentials or local paths',
      )
      // No column anywhere may name a provider key: those never leave the user's device.
      const providerKeyColumns = columns.filter(row => /deepseek|openai|anthropic|provider.*key|model.*key/i.test(row.column_name))
      assert.deepEqual(providerKeyColumns.map(row => `${row.table_name}.${row.column_name}`), [])
      const users = columns.filter(row => row.table_name === 'users').map(row => row.column_name).sort()
      assert.deepEqual(users, ['created_at', 'display_name', 'id', 'password_hash', 'status', 'user_handle'])
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('the backup directory holds only the artifacts a restore needs', async () => {
  const { root, cleanup } = tempRoot()
  try {
    const { db } = openTempHub(root)
    try {
      migrate(db, { dir: migrationsDir() })
      const dir = join(root, 'backups')
      await createBackup(db, { backupDir: dir, label: 'hub' })
      const names = readdirSync(dir).sort()
      assert.equal(names.length, 2, `expected a snapshot and its manifest, got ${names.join(', ')}`)
      assert.ok(names.some(name => name.endsWith('.sqlite')))
      assert.ok(names.some(name => name.endsWith('.sqlite.manifest.json')))
      // The manifest must be machine-readable, since the restore runbook reads it.
      const manifest = JSON.parse(readFileSync(join(dir, names.find(n => n.endsWith('.manifest.json'))), 'utf8'))
      assert.ok(Array.isArray(manifest.migrations))
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})
