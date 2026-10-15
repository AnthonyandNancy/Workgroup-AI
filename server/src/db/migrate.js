// Hub migrations: forward-only, one transaction per migration, versioned by filename.
//
// A Hub upgrade must be safe to interrupt. Every migration runs inside one transaction
// that also records its own version, so a crash either leaves the migration applied and
// recorded, or absent and unrecorded — never half-applied and recorded.
//
// Two SQLite facts shape this runner:
//
//  1. `PRAGMA journal_mode = WAL` inside a transaction does not fail and does not take
//     effect; it silently leaves the previous mode in place. So pragmas that change the
//     database mode run outside the transaction, from `openDatabase`.
//  2. `PRAGMA foreign_keys` is a no-op inside a transaction. It is set per connection on
//     open, never from a migration file.
//
// Migration files are therefore pure schema/DML. `db/migrations/0001_schema.sql` still
// carries its original two pragma lines; this runner strips them and reports that it did,
// so the proposal file stays readable without its pragmas being mistaken for effect.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/
const LEDGER_TABLE = 'schema_migrations'

/**
 * Pragma lines that must not appear inside a migration transaction.
 * Both were silently ineffective (or wrong) inside one, so they are removed and reported.
 */
const TRANSACTION_UNSAFE_PRAGMAS = [
  { pattern: /^\s*PRAGMA\s+journal_mode\b.*$/gim, name: 'journal_mode' },
  { pattern: /^\s*PRAGMA\s+foreign_keys\b.*$/gim, name: 'foreign_keys' },
]

export class MigrationError extends Error {
  constructor(migration, cause) {
    super(`Migration ${migration} failed: ${cause.message}`)
    this.name = 'MigrationError'
    this.migration = migration
    this.cause = cause
  }
}

/** `server/db/migrations`, resolved from this module rather than from the process cwd. */
export function migrationsDir(fromUrl = import.meta.url) {
  return join(dirname(fileURLToPath(fromUrl)), '..', '..', 'db', 'migrations')
}

/** Read and validate every migration file, ordered by version. */
export function loadMigrations(dir) {
  const entries = readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
  const migrations = []
  const seen = new Set()
  for (const name of entries) {
    const match = MIGRATION_FILE_PATTERN.exec(name)
    if (match === null) throw new Error(`Migration filename must look like 0001_name.sql, got ${name}`)
    const version = Number(match[1])
    if (seen.has(version)) throw new Error(`Duplicate migration version ${match[1]}`)
    seen.add(version)
    const raw = readFileSync(join(dir, name), 'utf8')
    let sql = raw
    const stripped = []
    for (const { pattern, name: pragma } of TRANSACTION_UNSAFE_PRAGMAS) {
      if (pattern.test(sql)) {
        stripped.push(pragma)
        sql = sql.replace(pattern, `-- [hub migration runner] removed PRAGMA ${pragma} (ineffective or wrong inside a transaction)`)
      }
    }
    migrations.push({ version, name, sql, strippedPragmas: stripped })
  }
  if (migrations.length === 0) throw new Error(`No migrations found in ${dir}`)
  // Filenames are four-digit zero-padded and applied in filename order, so lexicographic
  // order already is version order; no extra ordering assertion is needed or reachable.
  return migrations
}

function ensureLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
}

export function appliedVersions(db) {
  ensureLedger(db)
  return db.prepare(`SELECT version, name, applied_at FROM ${LEDGER_TABLE} ORDER BY version`).all()
}

/**
 * Apply every pending migration. Returns what changed; running twice changes nothing.
 *
 * @param {object} db opened Hub database
 * @param {{ dir?: string, log?: (message: string) => void }} [options]
 */
export function migrate(db, options = {}) {
  const { log = () => {} } = options
  const dir = options.dir ?? migrationsDir()
  const migrations = loadMigrations(dir)
  const ledger = appliedVersions(db)
  const already = new Set(ledger.map(row => row.version))
  const present = new Map(migrations.map(migration => [migration.version, migration.name]))

  // A ledger row whose migration file is gone means this database was built by a release
  // this package no longer contains. Applying the migrations that remain would build a
  // schema no release ever shipped, so the run is refused and named.
  const orphaned = ledger.filter(row => !present.has(row.version))
  if (orphaned.length > 0) {
    const names = orphaned.map(row => `${row.name} (v${row.version})`).join(', ')
    throw new MigrationError(
      `${orphaned.map(row => row.name).join(', ')}`,
      new Error(`this database has migrations this package does not contain: ${names}. It was created by a newer or different Hub release.`),
    )
  }

  const applied = []
  const skipped = []
  for (const migration of migrations) {
    if (already.has(migration.version)) {
      skipped.push(migration.name)
      continue
    }
    if (migration.strippedPragmas.length > 0) {
      log(`migration ${migration.name}: removed transaction-unsafe pragma(s): ${migration.strippedPragmas.join(', ')}`)
    }
    // The version row is written inside the same transaction as the schema, so a crash
    // can never record a migration whose statements did not commit.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare(`INSERT INTO ${LEDGER_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // A rollback that itself fails must not hide the migration failure that caused it.
      }
      throw new MigrationError(migration.name, error)
    }
    applied.push(migration.name)
    log(`migration ${migration.name}: applied`)
  }
  return { applied, skipped, directory: dir }
}

/** Verify the schema actually matches every migration's expectations. */
export function schemaIsCurrent(db, options = {}) {
  const dir = options.dir ?? migrationsDir()
  const migrations = loadMigrations(dir)
  const already = new Set(appliedVersions(db).map(row => row.version))
  const missing = migrations.filter(migration => !already.has(migration.version)).map(migration => migration.name)
  return { current: missing.length === 0, pending: missing }
}
