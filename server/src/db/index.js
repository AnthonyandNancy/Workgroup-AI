// Hub storage: one SQLite file in WAL mode, opened by exactly one Hub process.
//
// The Hub is a single-writer deployment. WAL lets readers run while a write is in
// flight, and `busy_timeout` keeps a short contention from surfacing as a failed
// request. Opening is deliberately strict: if the data directory is not writable, the
// Hub refuses to start rather than serving health from a database it cannot persist to.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const WRITE_PROBE_KEY = '__hub_write_probe__'

export class DatabaseOpenError extends Error {
  constructor(path, cause) {
    super(`Cannot open the Hub database at ${path}: ${cause.message}`)
    this.name = 'DatabaseOpenError'
    this.cause = cause
  }
}

/**
 * @param {{ dbPath: string, production?: boolean }} config
 */
export function openDatabase(config) {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  let db
  try {
    db = new DatabaseSync(config.dbPath)
  } catch (error) {
    throw new DatabaseOpenError(config.dbPath, error)
  }
  try {
    // Order matters: these run before any transaction, because `journal_mode` and
    // `foreign_keys` are both ineffective inside one — `journal_mode` silently keeps the
    // previous mode, so a Hub that "set WAL" inside a transaction would keep rollback
    // journaling while reporting success.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    // `synchronous = NORMAL` is the documented pairing with WAL: a power loss can drop
    // the last commits but cannot corrupt the file, and the Hub can replay from the
    // durable group history instead of paying an fsync on every message.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    if (!config.production) {
      // A shorter timeout hides lock bugs during development instead of masking them.
      db.exec('PRAGMA busy_timeout = 1000')
    }
    // Read the mode back: a database on a filesystem that cannot support WAL (some
    // network mounts) keeps its old mode without error, and the Hub must not pretend
    // otherwise. This is a start-up check, not a per-request cost.
    const mode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase()
    if (mode !== 'wal') {
      throw new Error(`the database did not enter WAL mode (reported "${mode || 'nothing'}"); the Hub requires a local filesystem that supports WAL`)
    }
    const foreignKeys = db.prepare('PRAGMA foreign_keys').get()?.foreign_keys
    if (Number(foreignKeys) !== 1) {
      throw new Error('foreign key enforcement could not be enabled; the Hub relies on it for referential integrity')
    }
    db.exec(`CREATE TABLE IF NOT EXISTS hub_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
  } catch (error) {
    db.close()
    throw new DatabaseOpenError(config.dbPath, error)
  }
  return db
}

/** Readiness probe: the file must accept a real write, not just a query. */
export function probeWritable(db) {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO hub_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(WRITE_PROBE_KEY, now, now)
  const row = db.prepare('SELECT value FROM hub_meta WHERE key = ?').get(WRITE_PROBE_KEY)
  if (row === undefined || row.value !== now) throw new Error('Hub database write probe did not read back its own write')
  return { checkedAt: now }
}

export function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM hub_meta WHERE key = ?').get(key)
  return row?.value
}

export function writeMeta(db, key, value) {
  const now = new Date().toISOString()
  db.prepare('INSERT INTO hub_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, String(value), now)
}

export function journalMode(db) {
  return db.prepare('PRAGMA journal_mode').get()?.journal_mode
}
