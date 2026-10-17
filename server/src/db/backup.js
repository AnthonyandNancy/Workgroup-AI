// Hub backup and restore.
//
// Backup uses SQLite's online backup API, not a copy of the file. A file copy of a live
// WAL database can capture a torn state: the `-wal` sidecar holds committed pages that are
// not yet in the main file, and copying the two files at different instants loses or
// duplicates them. `backup()` reads through the same consistent snapshot a query sees,
// and it is safe while the Hub keeps serving.
//
// Restore is deliberately not automatic. The Hub is a single-writer deployment: replacing
// the database under a running process would leave that process writing to an unlinked
// inode while operators believe the restore took effect. `restoreBackup` therefore
// requires the caller to have stopped the Hub, and verifies the candidate file before it
// touches the live one.

import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export class BackupError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'BackupError'
    this.cause = cause
  }
}

const MANIFEST_SUFFIX = '.manifest.json'

/**
 * Row counts for every entity a group depends on.
 *
 * Read through one query per table rather than a single aggregate so a table that has been dropped
 * shows up as an error instead of a silent zero: a count of `0` and "no such table" are different
 * findings, and a restore report must be able to tell them apart.
 */
export function entityCounts(db) {
  const tables = [
    'users', 'devices', 'refresh_tokens', 'rooms', 'room_members', 'invitations', 'messages',
    'bot_directory', 'tasks', 'approvals', 'task_events', 'dispatch_grants',
    'artifacts', 'group_memories', 'memory_revisions', 'operators', 'audit_events',
  ]
  const counts = {}
  for (const table of tables) {
    try {
      counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
    } catch (error) {
      // A table this build does not have is reported, not omitted: silently dropping it would
      // make a version mismatch look like an empty entity.
      counts[table] = `unavailable: ${error.message}`
    }
  }
  return counts
}

/**
 * Copy the artifact objects that this database's rows point at.
 *
 * A database snapshot alone is incomplete: `artifacts` rows name a file under
 * `HUB_DATA_DIR/artifacts/`, and restoring the database onto a machine without those bytes leaves
 * every artifact unreadable — the row says the file is there and `readArtifact` fails with
 * `ARTIFACT_BYTES_MISSING`. So a backup that an operator might restore must carry the objects too.
 *
 * Objects are content-addressed, so the file name is the hash and a copy is verifiable on its own.
 * Only the objects this database references are copied: an unreferenced object left by an
 * interrupted upload is not part of the Hub's state.
 *
 * The destination is derived from the **snapshot path**, never from the label and a clock reading
 * taken here. Two independently generated names is how a backup ends up with its objects in a
 * directory `restore` does not look in — a backup that verifies, restores, and leaves every
 * attachment unreadable.
 *
 * @param {object} db open Hub database
 * @param {{ artifactsDir: string, snapshotPath: string }} options
 * @returns {{ directory: string, objects: number, bytes: number, missing: string[] }}
 */
export function copyArtifactObjects(db, options) {
  const { artifactsDir, snapshotPath } = options
  const rows = db.prepare('SELECT DISTINCT sha256_hex FROM artifacts').all()
  const directory = objectsDirectoryFor(snapshotPath)
  mkdirSync(directory, { recursive: true })
  let objects = 0
  let bytes = 0
  const missing = []
  for (const row of rows) {
    const source = join(artifactsDir, row.sha256_hex.slice(0, 2), row.sha256_hex.slice(2, 4), row.sha256_hex)
    if (!existsSync(source)) {
      // A row whose bytes are gone is reported rather than skipped: the operator needs to know the
      // backup cannot be complete, and which object is missing.
      missing.push(row.sha256_hex)
      continue
    }
    const target = join(directory, row.sha256_hex)
    copyFileSync(source, target)
    objects += 1
    bytes += statSync(target).size
  }
  return { directory, objects, bytes, missing }
}

/**
 * Restore artifact objects from a backup directory into the live artifacts root.
 *
 * Files are placed at the content-addressed path, so restoring is idempotent: the same object
 * written twice lands in the same place with the same bytes.
 *
 * @param {{ backupObjectsDir: string, artifactsDir: string }} options
 * @returns {{ restored: number, skipped: number }}
 */
export function restoreArtifactObjects(options) {
  const { backupObjectsDir, artifactsDir } = options
  if (!existsSync(backupObjectsDir)) throw new BackupError(`No artifact objects at ${backupObjectsDir}`)
  let restored = 0
  let skipped = 0
  for (const name of readdirSync(backupObjectsDir)) {
    // Only a 64-character hex name is an object; anything else in the directory is not ours.
    if (!/^[0-9a-f]{64}$/.test(name)) {
      skipped += 1
      continue
    }
    const target = join(artifactsDir, name.slice(0, 2), name.slice(2, 4), name)
    if (existsSync(target)) {
      skipped += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(backupObjectsDir, name), target)
    restored += 1
  }
  return { restored, skipped }
}

/**
 * Keep the newest N backup sets, and move the rest aside.
 *
 * A backup directory that only grows eventually fills the volume it protects, which turns a
 * safety measure into an outage. Retention runs against the snapshot file name, which carries the
 * timestamp, so the order is the order the backups were taken.
 *
 * Superseded backups are **moved aside rather than deleted**: the operator asked to keep N, not to
 * destroy the rest, and the one time the difference matters is the time somebody needs last
 * month's copy. The directory they move to is reported so it can be cleaned deliberately.
 *
 * @param {{ backupDir: string, keep: number, quarantineDir?: string }} options
 * @returns {{ kept: string[], removed: string[] }}
 */
export function pruneBackups(options) {
  const { backupDir, keep, quarantineDir = resolve(backupDir, 'superseded') } = options
  if (!Number.isSafeInteger(keep) || keep < 1) throw new BackupError('Backup retention must be a positive integer')
  if (!existsSync(backupDir)) return { kept: [], removed: [] }
  // A backup set is one `.sqlite` file, its manifest, and its `-objects` directory. They are
  // grouped by the stem so a set is never split: keeping the database and dropping its objects
  // would leave a backup that restores rows pointing at files nobody kept.
  const entries = readdirSync(backupDir).filter(name => name.endsWith('.sqlite'))
  const ordered = entries.sort().reverse()
  const kept = ordered.slice(0, keep)
  const removed = ordered.slice(keep)
  if (removed.length === 0) return { kept, removed: [] }
  mkdirSync(quarantineDir, { recursive: true })
  for (const name of removed) {
    const stem = name.replace(/\.sqlite$/, '')
    for (const sibling of [`${stem}.sqlite`, `${stem}.sqlite.manifest.json`, `${stem}-objects`]) {
      const source = join(backupDir, sibling)
      if (!existsSync(source)) continue
      const target = join(quarantineDir, sibling)
      if (existsSync(target)) continue
      // `renameSync` moves a directory or a file in one step on the same volume.
      renameSync(source, target)
    }
  }
  return { kept, removed }
}

/**
 * Compare two count snapshots and report every difference.
 *
 * Used by the restore drill: comparing a backup's recorded counts against the restored database is
 * what turns "the restore ran" into evidence that the data is the same.
 */
export function compareEntityCounts(before, after) {
  const differences = []
  for (const table of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const left = before?.[table]
    const right = after?.[table]
    if (left !== right) differences.push({ table, before: left ?? null, after: right ?? null })
  }
  return differences
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * The object directory that belongs to a snapshot file.
 *
 * One function, used by both the writer and the reader, because the two deriving the name
 * separately is the defect this replaces: `hub backup` wrote `label-stamp-objects` while
 * `hub restore` looked for `<snapshot>-objects`, and the two never matched except by luck.
 *
 * @param {string} snapshotPath
 */
export function objectsDirectoryFor(snapshotPath) {
  return snapshotPath.replace(/\.sqlite(\..+)?$/, '-objects')
}

/**
 * Fold a snapshot's WAL into its main file and leave it in rollback-journal mode.
 *
 * `backup()` writes the snapshot with the source's journal mode, so the artifact lands with
 * a `-wal` and `-shm` beside it. Moving only the `.sqlite` file — what an operator copying a
 * backup to another machine does — would then silently drop every change still held in that
 * WAL. Normalizing makes each snapshot one self-contained file.
 */
function normalizeSnapshot(path) {
  let db
  try {
    db = new DatabaseSync(path)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    // Switching to DELETE after the checkpoint removes the now-empty sidecars. It must run
    // outside a transaction; journal_mode inside one is refused or silently ignored.
    db.prepare('PRAGMA journal_mode = DELETE').get()
  } finally {
    db?.close()
  }
}

/** Distinguish two backups that share a timestamp, so neither overwrites the other. */
function uniqueSuffix() {
  return globalThis.crypto.randomUUID().slice(0, 8)
}

/**
 * Write a consistent snapshot of the Hub database.
 *
 * @param {object} db open Hub database
 * @param {{ backupDir: string, label?: string, now?: Date }} options
 * @returns {{ path: string, manifestPath: string, bytes: number, pages: number, createdAt: string }}
 */
export async function createBackup(db, options) {
  const { backupDir, label = 'hub', now = new Date() } = options
  mkdirSync(backupDir, { recursive: true })
  const createdAt = now.toISOString()
  const path = join(backupDir, `${label}-${stamp(now)}-${uniqueSuffix()}.sqlite`)

  let pages
  try {
    pages = await sqliteBackup(db, path)
  } catch (error) {
    throw new BackupError(`Could not back up the Hub database to ${path}: ${error.message}`, error)
  }
  normalizeSnapshot(path)

  const integrity = verifyDatabaseFile(path)
  if (!integrity.ok) {
    // A backup that fails its own integrity check must not sit in the backup directory
    // looking restorable. It is renamed rather than deleted so the failed artifact can
    // still be inspected when diagnosing why the backup was bad.
    const quarantined = `${path}.failed`
    try {
      renameSync(path, quarantined)
    } catch {
      // If it cannot even be moved, the thrown error below is what matters.
    }
    throw new BackupError(`Backup failed integrity checking (${integrity.detail}); kept for inspection at ${quarantined}`)
  }

  const stat = statSync(path)
  const manifest = {
    createdAt,
    file: basename(path),
    bytes: stat.size,
    pages: pages ?? null,
    sqliteVersion: String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown'),
    journalMode: db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null,
    migrations: db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all(),
    // Per-entity counts, so a restore is verifiable rather than merely successful. "The file
    // opened and the schema is current" does not prove the group's messages, approvals, and
    // memory came back; comparing these counts against the restored database does.
    entityCounts: entityCounts(db),
  }
  const manifestPath = `${path}${MANIFEST_SUFFIX}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, manifestPath, bytes: stat.size, pages: pages ?? null, createdAt }
}

/**
 * Open a candidate file read-only and ask SQLite whether it is a usable Hub database.
 * Purely diagnostic: it never writes to the candidate.
 */
export function verifyDatabaseFile(path) {
  if (!existsSync(path)) return { ok: false, detail: 'file does not exist' }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { ok: false, detail: `cannot open: ${error.message}` }
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    const value = integrity?.integrity_check
    if (value !== 'ok') return { ok: false, detail: `integrity_check said ${JSON.stringify(value)}` }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeys.length > 0) {
      return { ok: false, detail: `foreign_key_check found ${foreignKeys.length} violation(s)` }
    }
    const hasLedger = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get()
    if (hasLedger === undefined) return { ok: false, detail: 'schema_migrations ledger is missing' }
    const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    if (migrations.length === 0) return { ok: false, detail: 'schema_migrations ledger is empty' }
    return {
      ok: true,
      detail: 'ok',
      migrations: migrations.map(row => row.version),
      tables: db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()?.n,
    }
  } catch (error) {
    return { ok: false, detail: error.message }
  } finally {
    db.close()
  }
}

/** Read a backup's manifest, tolerating a missing one so an older backup still restores. */
export function readBackupManifest(path) {
  const manifestPath = `${path}${MANIFEST_SUFFIX}`
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

/**
 * Replace the Hub database with a verified backup.
 *
 * The caller must have stopped the Hub: this refuses while another process holds the
 * database, because a live writer would keep committing to the replaced inode.
 *
 * @param {{ dbPath: string, backupPath: string, now?: Date }} options
 */
export function restoreBackup(options) {
  const { dbPath, backupPath, now = new Date() } = options
  if (!existsSync(backupPath)) throw new BackupError(`Backup not found: ${backupPath}`)

  const candidate = verifyDatabaseFile(backupPath)
  if (!candidate.ok) throw new BackupError(`Refusing to restore ${backupPath}: ${candidate.detail}`)

  // Ownership and mode of the file being replaced, captured before anything touches it.
  //
  // A restore is usually run by the operator (often as root) while the Hub runs as a service
  // account, and SQLite needs to *write* the database it opens. A file created by root lands
  // mode 0644 root:root, so the very next start fails with "attempt to write a readonly
  // database" and systemd restarts it forever. Preserving the replaced file's ownership is what
  // makes a restore leave a deployment that can actually start.
  const previous = existsSync(dbPath) ? statSync(dbPath) : undefined

  // A sqlite3 client holding the file takes a lock the backup API honours, so a write lock here
  // is the cheap check that the Hub is not still running.
  //
  // The probe runs **only when the database exists**. `new DatabaseSync(path)` *creates* the
  // file, so probing an absent database used to bring an empty one into being and then preserve
  // that empty file as the "previous database" — a safety copy of nothing, produced by the act
  // of checking whether it was safe to proceed.
  if (previous !== undefined) {
    let probe
    try {
      probe = new DatabaseSync(dbPath)
      probe.exec('PRAGMA busy_timeout = 0')
      probe.exec('BEGIN IMMEDIATE')
      probe.exec('ROLLBACK')
    } catch (error) {
      throw new BackupError(
        `Refusing to restore into ${dbPath}: the database is in use (${error.message}). Stop the Hub first.`,
        error,
      )
    } finally {
      probe?.close()
    }
  }

  const createdAt = now.toISOString()
  mkdirSync(dirname(dbPath), { recursive: true })
  const safetyCopy = previous === undefined ? undefined : `${dbPath}.pre-restore-${stamp(now)}`
  if (safetyCopy !== undefined) {
    copyFileSync(dbPath, safetyCopy)
    // The safety copy is a backup too, so it gets the same ownership treatment.
    applyOwner(safetyCopy, previous)
  }

  // A WAL sidecar belongs to the file being replaced: leaving it in place would let the
  // old committed pages merge into the restored database. They are moved aside rather
  // than deleted, so an operator can still inspect what the Hub had committed if the
  // restore turns out to be the wrong one.
  const setAside = []
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(sidecar)) continue
    const moved = `${sidecar}.pre-restore-${stamp(now)}`
    try {
      renameSync(sidecar, moved)
    } catch (error) {
      // Put back anything already moved, so a refusal leaves the deployment exactly as it was.
      for (const already of setAside) {
        try {
          renameSync(already, already.replace(`.pre-restore-${stamp(now)}`, ''))
        } catch {
          // If it cannot be put back, the error below still names the real problem.
        }
      }
      throw new BackupError(
        `Refusing to restore into ${dbPath}: ${sidecar} cannot be moved aside (${error.message}). Stop the Hub first.`,
        error,
      )
    }
    setAside.push(moved)
  }

  const staging = `${dbPath}.restoring-${stamp(now)}`
  copyFileSync(backupPath, staging)
  renameSync(staging, dbPath)
  // When there was no previous file — the total-loss case, which is the case a restore exists
  // for — the data directory's own owner is the right owner: that is the account the deployment
  // gave the data to, and it must be able to write the database it just recovered. Without this
  // fallback a restore run as root leaves a root-owned file in a service-owned directory, and
  // the Hub answers "attempt to write a readonly database" until somebody notices.
  //
  // Reported rather than assumed: an operator who cannot have the ownership changed needs to
  // know exactly what is left to do.
  const ownership = applyOwner(dbPath, previous ?? statSync(dirname(dbPath)), previous === undefined ? 'the data directory' : 'the replaced database')
  return {
    restoredFrom: resolve(backupPath),
    dbPath: resolve(dbPath),
    safetyCopy,
    sidecarsSetAside: setAside,
    restoredAt: createdAt,
    migrations: candidate.migrations,
    ownership,
  }
}

/**
 * Give a restored file the ownership and mode of a reference entry.
 *
 * The reference is the database file that was replaced, or — when there was none — the data
 * directory, so a restore into a fresh directory still lands owned by the account that owns the
 * data rather than by whoever ran the command.
 *
 * Best effort by design, and it reports what it did. `chmod`/`chown` need privilege the caller
 * may not have, and failing the whole restore over a permission fix that is not required would be
 * worse than telling the operator what is left to do.
 *
 * @param {string} path the restored file
 * @param {{ uid: number, gid: number, mode: number }} reference
 * @returns {{ preserved: boolean, applied?: { uid: number, gid: number, mode: number }, detail?: string }}
 */
function applyOwner(path, reference, source) {
  // The directory's mode is not the file's mode: a database is not meant to be world-readable just
  // because its directory is traversable, so the file keeps a mode derived from the reference's
  // readability instead of copying it.
  const mode = reference.mode & 0o200 ? 0o644 : 0o600
  const wanted = { uid: reference.uid, gid: reference.gid, mode }
  try {
    chownSync(path, wanted.uid, wanted.gid)
    chmodSync(path, wanted.mode)
    return { preserved: true, applied: wanted, source }
  } catch (error) {
    return { preserved: false, applied: wanted, source, detail: error.message }
  }
}
