#!/usr/bin/env node
// Hub operator commands: migrate, backup, restore, verify, health.
//
// These are the commands `server/deploy/` tells an operator to run, and they must work
// with nothing but this package: no application sources, no Hub process, and no network.
// `backup` and `restore` deliberately talk to the database file directly rather than
// through a running Hub, so the runbook does not depend on an HTTP endpoint that may be
// the very thing under repair.

import { loadConfig, ConfigError } from '../config/index.js'
import { openDatabase, DatabaseOpenError, probeWritable, journalMode } from '../db/index.js'
import { migrate, MigrationError, appliedVersions, schemaIsCurrent, migrationsDir } from '../db/migrate.js'
import { createBackup, restoreBackup, verifyDatabaseFile, readBackupManifest, entityCounts, compareEntityCounts, copyArtifactObjects, restoreArtifactObjects, pruneBackups, objectsDirectoryFor } from '../db/backup.js'
import { pruneAudit, cutoffForDays, listRetentionRuns } from '../modules/audit/store.js'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

/** Node's own modules are not dependencies; a specifier that names one needs no manifest entry. */
const NodeBuiltins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
import { hubVersion, protocolVersion } from '../version.js'

const USAGE = `Workgroup AI Hub — operator commands

  hub migrate            apply pending database migrations
  hub backup [--label X] write a verified snapshot and the attachment objects it needs
  hub restore <file>     replace the database and its attachment objects (Hub must be stopped)
  hub verify [file]      check a database file, by default the configured one
  hub status             print configuration, schema, and data-path facts
  hub deploy-check       verify this copy of server/ can run on its own
  hub backup-drill <f>   compare a backup against every entity count it recorded
  hub audit-prune        apply the configured audit retention (--dry-run to preview)
  hub audit-runs         show what previous retention runs did
  hub help               show this message

Environment is read from the same variables as the server (see .env.example).
Every command exits 0 on success, 1 on a failed check, or one of the sysexits codes
on a configuration (78) or I/O (74) problem.
`

function parse(argv) {
  const [command, ...rest] = argv
  const flags = {}
  const positional = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--label' || token === '--days') {
      flags[token.slice(2)] = rest[index + 1]
      index += 1
    } else if (token === '--dry-run') {
      flags['dry-run'] = true
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option ${token}`)
    } else {
      positional.push(token)
    }
  }
  return { command, flags, positional }
}

function withConfig() {
  try {
    return loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      console.error('\nSee .env.example for the supported variables.')
      process.exitCode = 78
      return undefined
    }
    throw error
  }
}

function withDatabase(config) {
  try {
    // Every command that opens the Hub database needs the same start-up guarantees the
    // server relies on (WAL established, foreign keys on), so it opens through the same
    // path rather than a second, weaker one.
    return openDatabase(config)
  } catch (error) {
    if (error instanceof DatabaseOpenError) {
      console.error(error.message)
      process.exitCode = 74
      return undefined
    }
    throw error
  }
}

async function cmdMigrate() {
  const config = withConfig()
  if (config === undefined) return
  const db = withDatabase(config)
  if (db === undefined) return
  try {
    const result = migrate(db, { log: message => console.log(message) })
    if (result.applied.length === 0) console.log(`Schema is current: ${result.skipped.length} migration(s) already applied.`)
    else console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`)
    const state = schemaIsCurrent(db)
    if (!state.current) {
      console.error(`Still pending after migrate: ${state.pending.join(', ')}`)
      process.exitCode = 1
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  } finally {
    db.close()
  }
}

async function cmdBackup(flags) {
  const config = withConfig()
  if (config === undefined) return
  const db = withDatabase(config)
  if (db === undefined) return
  try {
    const label = flags.label ?? 'hub'
    const result = await createBackup(db, { backupDir: config.backupDir, label })
    console.log(`Wrote ${result.path}`)
    console.log(`  bytes: ${result.bytes}, pages: ${result.pages}, createdAt: ${result.createdAt}`)
    console.log(`  manifest: ${result.manifestPath}`)

    // The database alone is not a complete backup: `artifacts` rows name a file under the
    // artifacts root, and restoring the database without those bytes leaves every attachment
    // unreadable. Copying them here is what makes one backup command a restorable unit.
    const objects = copyArtifactObjects(db, { artifactsDir: config.artifactsDir, snapshotPath: result.path })
    console.log(`  artifact objects: ${objects.objects} (${objects.bytes} bytes) at ${objects.directory}`)
    if (objects.missing.length > 0) {
      // Reported, not ignored: an operator must know the backup cannot be complete.
      console.error(`  WARNING: ${objects.missing.length} artifact object(s) are referenced but missing from disk:`)
      for (const hash of objects.missing.slice(0, 10)) console.error(`    ${hash}`)
      process.exitCode = 1
    }

    // Retention runs only after a successful backup, so a failed run never removes the older
    // copies an operator would fall back to.
    const pruned = pruneBackups({ backupDir: config.backupDir, keep: config.retention.backupRetentionCount })
    if (pruned.removed.length > 0) console.log(`  retention: removed ${pruned.removed.length} older backup set(s), kept ${config.retention.backupRetentionCount}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

function cmdRestore(positional) {
  const config = withConfig()
  if (config === undefined) return
  const backupPath = positional[0]
  if (backupPath === undefined) {
    console.error('hub restore needs the path of a backup file')
    process.exitCode = 64 // EX_USAGE
    return
  }
  try {
    const result = restoreBackup({ dbPath: config.dbPath, backupPath })
    console.log(`Restored ${result.dbPath} from ${result.restoredFrom}`)
    if (result.safetyCopy === undefined) {
      console.log('  there was no previous database file to keep a safety copy of')
    } else {
      console.log(`  previous database kept at ${result.safetyCopy}`)
    }
    for (const moved of result.sidecarsSetAside) console.log(`  WAL sidecar set aside at ${moved}`)
    console.log(`  migrations present in the restored file: ${result.migrations.join(', ')}`)
    // The restored file must be writable by whoever runs the Hub. Report it, because a restore
    // run as root into a service-owned directory otherwise leaves a Hub that cannot start and
    // says only "attempt to write a readonly database".
    if (result.ownership?.preserved === true) {
      const { uid, gid, mode } = result.ownership.applied
      console.log(`  ownership: uid ${uid}, gid ${gid}, mode ${mode.toString(8)} (taken from ${result.ownership.source})`)
    } else if (result.ownership?.preserved === false) {
      console.error(`  WARNING: could not set the restored database's ownership: ${result.ownership.detail}`)
      console.error(`    the Hub must be able to write ${result.dbPath}`)
      console.error(`    fix it with: chown ${result.ownership.applied.uid}:${result.ownership.applied.gid} ${result.dbPath}`)
      process.exitCode = 1
    }

    // Restore the attachment bytes beside the namesake object directory, when the backup was
    // taken by a version that copies them. An older backup has none, which is reported rather
    // than treated as an error: the database rows are still restored.
    const objectsDir = objectsDirectoryForExisting(backupPath)
    if (objectsDir === undefined) {
      console.log('  artifact objects: none beside this backup (taken before objects were copied)')
    } else {
      const restored = restoreArtifactObjects({ backupObjectsDir: objectsDir, artifactsDir: config.artifactsDir })
      console.log(`  artifact objects: restored ${restored.restored}, already present ${restored.skipped}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

function cmdVerify(positional) {
  const target = positional[0]
  let path = target
  let config
  if (path === undefined) {
    config = withConfig()
    if (config === undefined) return
    path = config.dbPath
  }
  const result = verifyDatabaseFile(path)
  if (result.ok) {
    console.log(`${path}: ok`)
    console.log(`  migrations: ${result.migrations.join(', ')}`)
    console.log(`  tables: ${result.tables}`)
    const manifest = readBackupManifest(path)
    if (manifest !== undefined) console.log(`  backup manifest: ${manifest.createdAt}, ${manifest.bytes} bytes`)
  } else {
    console.error(`${path}: ${result.detail}`)
    process.exitCode = 1
  }
}

function cmdStatus() {
  const config = withConfig()
  if (config === undefined) return
  const db = withDatabase(config)
  if (db === undefined) return
  try {
    const applied = appliedVersions(db)
    const state = schemaIsCurrent(db)
    console.log(`version:   ${hubVersion()}`)
    console.log(`protocol:  ${protocolVersion}`)
    console.log(`node:      ${process.versions.node}`)
    console.log(`nodeEnv:   ${config.nodeEnv}`)
    console.log(`listen:    ${config.host}:${config.port}`)
    console.log(`dataDir:   ${config.dataDir}`)
    console.log(`database:  ${config.dbPath}`)
    console.log(`journal:   ${journalMode(db)}`)
    console.log(`migrations: ${applied.length} applied, current=${state.current}${state.pending.length > 0 ? `, pending=${state.pending.join(', ')}` : ''}`)
    console.log(`tls:       ${config.tls === undefined ? 'off (terminate at a proxy or set HUB_TLS_CERT/HUB_TLS_KEY)' : 'configured'}`)
    console.log(`signing key present: ${config.hasTokenSigningKey}${config.hasPreviousTokenKeys ? ` (${config.security.tokenKeyIds} keys held for rotation)` : ''}`)
    // The security settings are printed because they are the ones an operator has to reason
    // about during an incident, and reading them out of a source file at that moment is not
    // reasonable. No key material or credential is ever printed.
    console.log(`login:     ${config.security.loginMaxAttempts} attempt(s) per ${config.security.loginWindowSeconds}s window, ${config.security.loginLockoutSeconds}s lockout (throttling is per process)`)
    console.log(`connections: ${config.security.maxConnectionsTotal === 0 ? 'unlimited' : `${config.security.maxConnectionsTotal} total`}, ${config.security.maxConnectionsPerUser === 0 ? 'unlimited' : `${config.security.maxConnectionsPerUser} per user`}`)
    console.log(`migrations dir: ${migrationsDir()}`)
    const probe = probeWritable(db)
    console.log(`write probe: ok at ${probe.checkedAt}`)
  } finally {
    db.close()
  }
}

/**
 * The object directory that belongs to a backup file, if this backup shipped one.
 *
 * The name comes from `objectsDirectoryFor` in the backup module — the same function the writer
 * uses — so the two cannot drift apart. An older backup has none, which is reported rather than
 * treated as an error: its database rows are still restorable.
 */
function objectsDirectoryForExisting(backupPath) {
  const candidate = objectsDirectoryFor(backupPath)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Verify that this copy of `server/` can run by itself.
 *
 * This is the check the deployment criteria ask for, and it is deliberately runnable *on the server
 * being verified* rather than only in CI: what it looks for is the ways a `server/` copy goes wrong
 * in practice — a file that was never copied, a dependency that only exists because the whole
 * repository is present, and a data directory that is not writable.
 *
 * It reports every problem it finds rather than stopping at the first, because an operator fixing a
 * deployment wants the whole list.
 */
function cmdDeployCheck() {
  const problems = []
  const notes = []
  // Hints are separated from notes because a note says "verified ok" while a hint says "the
  // failure above has a one-line fix". Printing them with the same prefix would make a failure
  // look like a pass.
  const hints = []

  // 1. Nothing may reach outside `server/`. A relative import that climbs above the package root
  //    only works while the whole repository is checked out beside it.
  const sourceRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
  const sourceFiles = []
  const escapingImports = []
  const bareImports = new Set()
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.js')) continue
      sourceFiles.push(path)
      // Only real import statements are read. Matching every quoted string would pick up the
      // sentences this codebase uses in messages and errors, which are not dependencies.
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]
        if (specifier.startsWith('.')) {
          const resolved = resolve(dirname(path), specifier)
          if (!resolved.startsWith(sourceRoot)) escapingImports.push(`${relative(sourceRoot, path)} → ${specifier}`)
          continue
        }
        if (specifier.startsWith('node:')) continue
        bareImports.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
      }
      // A dynamic `import('...')` is a real dependency too.
      for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const specifier = match[1]
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        bareImports.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
      }
    }
  }
  walk(join(sourceRoot, 'src'))
  if (escapingImports.length > 0) {
    problems.push(`source imports reach outside server/: ${escapingImports.slice(0, 5).join(', ')}`)
  }

  // 2. Every bare import must be declared, because the server installs only what package.json names
  //    and Node's own modules need no entry.
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'))
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  const undeclared = [...bareImports].filter(name => !dependencies.has(name) && !NodeBuiltins.has(name))
  if (undeclared.length > 0) problems.push(`imports not declared in dependencies: ${undeclared.join(', ')}`)

  // 3. The files a running Hub reads must be present in this copy.
  for (const required of ['src/index.js', 'db/migrations', 'package.json', 'package-lock.json']) {
    if (!existsSync(join(sourceRoot, required))) problems.push(`missing ${required}`)
  }

  // 4. It must not need anything from the application project.
  //
  //    Two shapes of the same mistake are checked. If somebody copied the whole repository, this
  //    package sits at `<root>/server` with `<root>/application` beside it — and `apps/` and
  //    `packages/` are then *inside* `application/`, not beside `server/`, so listing those alone
  //    would miss exactly the case the criterion names. If somebody copied `server/` to the
  //    repository root instead, the DSH workspace markers sit directly beside it.
  for (const marker of ['application', 'apps', 'packages', 'integrations', 'pnpm-workspace.yaml']) {
    if (existsSync(resolve(sourceRoot, '..', marker))) {
      problems.push(`a sibling ${marker} exists, so this is not a server-only copy`)
    }
  }

  // 5. The configuration must be usable as a deployment.
  //
  //    `allowMissingDataDir` on purpose: a check must not have side effects on the machine it
  //    audits, and a first deployment legitimately runs it before the data directory exists. The
  //    policy still refuses a data directory whose ancestor chain cannot be created or is not
  //    writable, so a host that would fail at first start is still reported as failing.
  let config
  try {
    config = loadConfig(
      { ...process.env, HUB_DATA_DIR: process.env.HUB_DATA_DIR ?? resolve(process.cwd(), 'data') },
      { createDataDir: false, allowMissingDataDir: true },
    )
    notes.push(`configuration valid for NODE_ENV=${config.nodeEnv}`)
    if (!existsSync(config.dataDir)) notes.push(`${config.dataDir} does not exist yet; the Hub creates it on first start`)
    else notes.push(`${config.dataDir} is readable and writable`)
    if (config.production && config.tls === undefined && config.publicUrl !== undefined && config.publicUrl.startsWith('https:')) {
      notes.push('TLS is terminated upstream; the Hub itself listens in cleartext behind it')
    }
    if (config.hasPreviousTokenKeys) notes.push(`token keyring holds ${config.security.tokenKeyIds} keys, so a rotation is in progress`)
  } catch (error) {
    // A config failure prints as several lines; the first names the group, the rest name the fields.
    problems.push(`configuration: ${error.message.split(String.fromCharCode(10)).filter(Boolean).join('; ')}`)
    // A deployment configures the Hub through `/etc/workgroup-ai/hub.env`, which only systemd
    // loads. An operator running this check by hand therefore sees "missing secret" for a host
    // that is configured perfectly well — a confusing failure, since the fix is in the shell,
    // not in the configuration. Pointing at the file turns that into a one-line fix.
    if (existsSync(DEPLOYMENT_ENV_FILE) && process.env.HUB_TOKEN_SIGNING_KEY === undefined) {
      hints.push(`this shell has not loaded ${DEPLOYMENT_ENV_FILE}; run: set -a; . ${DEPLOYMENT_ENV_FILE}; set +a`)
    }
  }

  console.log('server-only deployment check')
  if (problems.length === 0) for (const note of notes) console.log(`  ok    ${note}`)
  console.log(`  ok    ${sourceRoot} contains the Hub sources and its migrations`)
  console.log(`  ok    ${sourceFiles.length} source files import only declared packages and Node's own modules`)
  console.log(`  ok    ${dependencies.size} declared ${dependencies.size === 1 ? 'dependency' : 'dependencies'}`)
  if (problems.length === 0) {
    console.log('  ok    nothing outside server/ is required to run this copy')
    return
  }
  for (const problem of problems) console.error(`  FAIL  ${problem}`)
  for (const hint of hints) console.error(`  hint  ${hint}`)
  process.exitCode = 1
}

/** The environment file the systemd units load; named in `deploy/systemd/hub.env.example`. */
const DEPLOYMENT_ENV_FILE = '/etc/workgroup-ai/hub.env'

/** Where a sibling of `server/` would be, given a name that must not be inside it. */
function requiredParent(name) {
  return `../${name}`
}

/**
 * Restore a backup into a scratch database and compare it against what the backup recorded.
 *
 * This is the drill the acceptance criteria ask for, and it is deliberately read-only with respect
 * to the live Hub: it never touches the configured database. Comparing per-entity counts is what
 * makes it evidence — a restore that opens and reports a current schema proves nothing about
 * whether the group's messages and approvals came back.
 */
function cmdBackupDrill(positional) {
  const backupPath = positional[0]
  if (backupPath === undefined) {
    console.error('hub backup-drill needs the path of a backup file')
    process.exitCode = 64
    return
  }
  const manifest = readBackupManifest(backupPath)
  if (manifest === undefined) {
    console.error(`${backupPath} has no manifest beside it, so there is nothing to compare against`)
    process.exitCode = 1
    return
  }
  const verified = verifyDatabaseFile(backupPath)
  if (!verified.ok) {
    console.error(`${backupPath} is not a usable Hub database: ${verified.detail}`)
    process.exitCode = 1
    return
  }
  // A fresh read-only handle on the backup itself: the drill never writes to the artifact it checks.
  const scratch = new DatabaseSync(backupPath, { readOnly: true })
  let restoredCounts
  try {
    restoredCounts = entityCounts(scratch)
  } finally {
    scratch.close()
  }
  const differences = compareEntityCounts(manifest.entityCounts, restoredCounts)
  console.log(`drill of ${backupPath}`)
  console.log(`  recorded at: ${manifest.createdAt}`)
  console.log(`  migrations:  ${manifest.migrations.map(migration => migration.name).join(', ')}`)
  const total = Object.values(restoredCounts).filter(value => typeof value === 'number').reduce((sum, value) => sum + value, 0)
  console.log(`  entities:    ${Object.keys(restoredCounts).length} tables, ${total} rows`)
  if (differences.length === 0) {
    console.log('  result:      every recorded count matches; the backup is complete')
    return
  }
  console.error('  result:      MISMATCH')
  for (const difference of differences) {
    console.error(`    ${difference.table}: manifest ${String(difference.before)} vs backup ${String(difference.after)}`)
  }
  process.exitCode = 1
}

function cmdAuditRuns() {
  const config = withConfig()
  if (config === undefined) return
  const db = withDatabase(config)
  if (db === undefined) return
  try {
    const runs = listRetentionRuns(db)
    console.log(`audit retention: ${config.retention.auditRetentionDays === null ? 'keep forever (HUB_AUDIT_RETENTION_DAYS is unset)' : `${config.retention.auditRetentionDays} days`}`)
    if (runs.length === 0) {
      console.log('no retention run has been recorded')
      return
    }
    for (const run of runs) {
      console.log(`  ${run.ran_at}  deleted ${run.deleted_count}, kept ${run.kept_count}, cutoff ${run.cutoff}`)
    }
  } finally {
    db.close()
  }
}

function cmdAuditPrune(positional, flags) {
  const config = withConfig()
  if (config === undefined) return
  const dryRun = flags['dry-run'] === true || positional.includes('--dry-run')
  if (config.retention.auditRetentionDays === null && flags.days === undefined) {
    // Refusing is the right answer: the operator asked to prune with no window configured, and
    // guessing one would delete an audit trail on an assumption.
    console.error('No audit retention window is configured. Set HUB_AUDIT_RETENTION_DAYS, or pass --days N.')
    process.exitCode = 64
    return
  }
  const days = flags.days === undefined ? config.retention.auditRetentionDays : Number(flags.days)
  const db = withDatabase(config)
  if (db === undefined) return
  try {
    const cutoff = cutoffForDays(days)
    const result = pruneAudit(db, { cutoff, dryRun })
    console.log(`${dryRun ? 'would delete' : 'deleted'} ${dryRun ? result.wouldDelete : result.deleted} event(s) older than ${cutoff}`)
    console.log(`kept ${result.kept} event(s)${dryRun ? ' (dry run: nothing was deleted)' : ''}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    db.close()
  }
}

async function main() {
  const { command, flags, positional } = parse(process.argv.slice(2))
  switch (command) {
    case 'migrate': return cmdMigrate()
    case 'backup': return cmdBackup(flags)
    case 'restore': return cmdRestore(positional)
    case 'verify': return cmdVerify(positional)
    case 'status': return cmdStatus()
    case 'deploy-check': return cmdDeployCheck()
    case 'backup-drill': return cmdBackupDrill(positional)
    case 'audit-prune': return cmdAuditPrune(positional, flags)
    case 'audit-runs': return cmdAuditRuns()
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      console.error(`Unknown command: ${command}\n`)
      console.error(USAGE)
      process.exitCode = 64 // EX_USAGE
  }
}

await main()
