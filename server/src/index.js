#!/usr/bin/env node
// Workgroup AI Hub — the single process this package runs.
//
// Startup order is deliberate: validate configuration first (fail before touching
// disk), then open the database (fail before listening), then listen (fail before
// advertising readiness). Any failure exits non-zero with a diagnosable message.

import { loadConfig, ConfigError } from './config/index.js'
import { openDatabase, DatabaseOpenError, probeWritable } from './db/index.js'
import { migrate, MigrationError, schemaIsCurrent } from './db/migrate.js'
import { startHub } from './server.js'
import { hubVersion, protocolVersion } from './version.js'

async function main() {
  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      // Config problems are the operator's to fix; print them all, not just the first.
      console.error(error.message)
      console.error('\nSee server/.env.example for the supported variables.')
      process.exitCode = 78 // EX_CONFIG
      return
    }
    throw error
  }

  let db
  try {
    db = openDatabase(config)
    probeWritable(db)
  } catch (error) {
    if (error instanceof DatabaseOpenError) {
      console.error(error.message)
      process.exitCode = 74 // EX_IOERR
      return
    }
    throw error
  }

  // Migrations run before the Hub listens. Serving requests against a database whose
  // schema this release does not expect turns a start-up failure into scattered
  // per-request failures, which is much harder to diagnose than a refusal to boot.
  try {
    const result = migrate(db, { log: message => console.log(`[hub] ${message}`) })
    if (result.applied.length > 0) {
      console.log(`[hub] applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`)
    } else {
      console.log(`[hub] schema is current (${result.skipped.length} migration(s) already applied)`)
    }
    const state = schemaIsCurrent(db)
    if (!state.current) {
      console.error(`[hub] schema still has pending migrations after migrating: ${state.pending.join(', ')}`)
      db.close()
      process.exitCode = 74
      return
    }
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`[hub] ${error.message}`)
      db.close()
      process.exitCode = 74 // EX_IOERR
      return
    }
    throw error
  }

  const server = await startHub({ config, db })

  server.log.info(
    {
      version: hubVersion(),
      protocol: protocolVersion,
      node: process.versions.node,
      dataDir: config.dataDir,
      tls: config.tls === undefined ? 'off (terminate TLS at a proxy, or set HUB_TLS_CERT/HUB_TLS_KEY)' : 'on',
    },
    'Workgroup AI Hub is listening',
  )

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    server.log.info({ signal }, 'shutting down')
    try {
      await server.close()
      db.close()
      process.exitCode = 0
    } catch (error) {
      server.log.error({ err: error }, 'shutdown failed')
      process.exitCode = 1
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown(signal)
    })
  }
}

await main()
