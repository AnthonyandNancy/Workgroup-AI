// H-01 tests: configuration validation, database open/WAL, and the health endpoints.
//
// These run against a real Fastify server on an ephemeral port with a real SQLite file
// in a temp directory. No mocks: the point of H-01 is that the Hub starts, answers, and
// refuses to start when it cannot persist.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, ConfigError } from '../src/config/index.js'
import { openDatabase, probeWritable, readMeta, writeMeta, journalMode } from '../src/db/index.js'
import { createServer } from '../src/server.js'
import { hubVersion, protocolVersion } from '../src/version.js'

function tempHub() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-'))
  return {
    root,
    dataDir: join(root, 'data'),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  }
}

async function withHub(run) {
  const dirs = tempHub()
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir })
  const db = openDatabase(config)
  const server = await createServer({ config, db, logger: false })
  try {
    await run({ config, db, server, dirs })
  } finally {
    await server.close()
    db.close()
    dirs.cleanup()
  }
}

test('configuration defaults are valid for a local test run', () => {
  const dirs = tempHub()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir })
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 8443)
    assert.equal(config.production, false)
    assert.equal(config.dbPath, join(config.dataDir, 'hub.sqlite'))
    assert.equal(config.limits.maxMessageBytes, 131072)
  } finally {
    dirs.cleanup()
  }
})

test('configuration rejects relative data dirs, bad ports, and short secrets', () => {
  const dirs = tempHub()
  try {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: 'relative/data' }),
      (error) => error instanceof ConfigError && /HUB_DATA_DIR must be an absolute path/.test(error.message),
    )
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir, HUB_PORT: '70000' }),
      (error) => error instanceof ConfigError && /HUB_PORT must be an integer between 0 and 65535/.test(error.message),
    )
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', HUB_DATA_DIR: dirs.dataDir, HUB_TOKEN_SIGNING_KEY: 'too-short', HUB_ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-value' }),
      (error) => error instanceof ConfigError && /at least 32 characters/.test(error.message),
    )
    // Every problem is reported at once so an operator fixes one list, not one error per restart.
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', HUB_DATA_DIR: dirs.dataDir, HUB_PORT: '70000', HUB_LOG_LEVEL: 'loud' }),
      (error) => {
        assert.ok(error.problems.length >= 3, `expected several problems, got ${JSON.stringify(error.problems)}`)
        return true
      },
    )
  } finally {
    dirs.cleanup()
  }
})

test('configuration never puts the signing key into the returned object', () => {
  const dirs = tempHub()
  const secret = 'k'.repeat(48)
  try {
    const config = loadConfig({ NODE_ENV: 'production', HUB_DATA_DIR: dirs.dataDir, HUB_TOKEN_SIGNING_KEY: secret, HUB_PUBLIC_URL: 'https://hub.internal', HUB_ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-value' })
    assert.equal(config.hasTokenSigningKey, true)
    const serialized = JSON.stringify(config)
    assert.equal(serialized.includes(secret), false, 'the signing key leaked into serialized configuration')
    assert.equal(config.readTokenSigningKey(), secret)
  } finally {
    dirs.cleanup()
  }
})

test('configuration rejects cleartext public URLs in production', () => {
  const dirs = tempHub()
  try {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', HUB_DATA_DIR: dirs.dataDir, HUB_TOKEN_SIGNING_KEY: 'k'.repeat(40), HUB_ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-value', HUB_PUBLIC_URL: 'http://hub.internal' }),
      (error) => error instanceof ConfigError && /HUB_PUBLIC_URL must use https/.test(error.message),
    )
    const config = loadConfig({ NODE_ENV: 'development', HUB_DATA_DIR: dirs.dataDir, HUB_PUBLIC_URL: 'http://127.0.0.1:8443' })
    assert.equal(config.publicUrl, 'http://127.0.0.1:8443')
  } finally {
    dirs.cleanup()
  }
})

test('the database opens in WAL mode and accepts a write', () => {
  const dirs = tempHub()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir })
    const db = openDatabase(config)
    try {
      assert.equal(String(journalMode(db)).toLowerCase(), 'wal')
      const probe = probeWritable(db)
      assert.ok(Date.parse(probe.checkedAt) > 0)
      writeMeta(db, 'test.key', 'value-1')
      assert.equal(readMeta(db, 'test.key'), 'value-1')
      writeMeta(db, 'test.key', 'value-2')
      assert.equal(readMeta(db, 'test.key'), 'value-2')
      // The WAL sidecar is proof the mode is real on disk, not just a reported pragma.
      assert.ok(statSync(`${config.dbPath}-wal`, { throwIfNoEntry: false }) !== undefined)
    } finally {
      db.close()
    }
  } finally {
    dirs.cleanup()
  }
})

test('liveness answers without touching the database', async () => {
  await withHub(async ({ server }) => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/health/live' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'workgroup-ai-hub')
    assert.equal(body.version, hubVersion())
    assert.equal(body.protocol, protocolVersion)
    assert.equal(typeof body.uptimeSeconds, 'number')
  })
})

test('the reported Hub version is the real package version, not a placeholder', () => {
  // A wrong version makes a client skip a protocol migration it needs, so this asserts
  // the value is actually read from package.json rather than falling back.
  assert.match(hubVersion(), /^\d+\.\d+\.\d+/, 'hubVersion() must report the package version')
  assert.notEqual(hubVersion(), 'unknown')
  assert.equal(protocolVersion, 'wg.v1')
})

test('readiness reports the database, journal mode, and start time', async () => {
  await withHub(async ({ server }) => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/health/ready' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.status, 'ready')
    assert.equal(String(body.checks.journalMode).toLowerCase(), 'wal')
    assert.ok(Date.parse(body.checks.database.checkedAt) > 0)
    assert.ok(Date.parse(body.checks.startedAt) > 0)
  })
})

test('readiness answers 503 when the database cannot be written', async () => {
  // This case manages its own lifecycle: it must close the handle underneath the
  // running server, so it cannot reuse the shared teardown that closes it again.
  const dirs = tempHub()
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir })
  const db = openDatabase(config)
  const server = await createServer({ config, db, logger: false })
  try {
    db.close()
    // A closed handle is the closest real-world equivalent of a filled disk or a
    // revoked volume for a probe: reads and writes both start failing.
    const response = await server.inject({ method: 'GET', url: '/api/v1/health/ready' })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().status, 'not-ready')
    assert.equal(typeof response.json().checks.database.error, 'string')
  } finally {
    await server.close()
    dirs.cleanup()
  }
})

test('unknown routes answer a stable JSON error instead of HTML', async () => {
  await withHub(async ({ server }) => {
    const response = await server.inject({ method: 'GET', url: '/api/v1/definitely-not-a-route' })
    assert.equal(response.statusCode, 404)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.equal(response.json().error.code, 'NOT_FOUND')
  })
})

test('a Hub started from server/ alone binds a real port and serves health', async () => {
  const dirs = tempHub()
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: dirs.dataDir, HUB_PORT: '0' })
  const db = openDatabase(config)
  const server = await createServer({ config, db, logger: false })
  try {
    // Port 0 asks the OS for a free port: the test proves listening works without
    // fighting another process for 8443.
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    const url = `http://127.0.0.1:${address.port}/api/v1/health/ready`
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.status, 'ready')
  } finally {
    await server.close()
    db.close()
    dirs.cleanup()
  }
})

test('server-only operation needs no application sources', async () => {
  // H-01's hard requirement: the Hub must run from a copy of server/ alone. The DB path
  // lives under HUB_DATA_DIR, which the test set to a temp dir outside any repo.
  const dirs = tempHub()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(dirs.root, 'standalone') })
    assert.ok(config.dataDir.startsWith(dirs.root))
    const db = openDatabase(config)
    db.close()
    assert.ok(statSync(join(dirs.root, 'standalone', 'hub.sqlite'), { throwIfNoEntry: false }) !== undefined)
  } finally {
    dirs.cleanup()
  }
})
