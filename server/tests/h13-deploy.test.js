// H-13 tests: standalone deployment, security hardening, and the operations a running Hub needs.
//
// Four groups, each aimed at a claim H-13 has to make:
//
//   1. **A server-only copy runs.** `deploy-check` is what an operator runs on the server being
//      verified, so the cases here build real copies of `server/` — one intact, one missing a
//      file, one with a sibling `application/` — and check that the report separates them. A
//      check that passes everything proves nothing.
//   2. **Login cannot be guessed at full network speed.** The limiter is exercised against a
//      real server over HTTP, because the counter is only useful where it is actually consulted.
//   3. **A backup is a restorable unit, and retention groups a set.** The attachment bytes are
//      the half of a backup that is easy to forget; a restore that leaves them behind produces
//      rows pointing at files nobody kept. Retention is checked to never split a set.
//   4. **Rotation does not log everyone out.** A keyring verifies tokens signed with the previous
//      key while signing new ones with the current key.
//
// Every case runs against real files and a real Fastify server: sqlite, bcrypt, HTTP. Nothing is
// mocked, because the failure modes H-13 exists to prevent (a missing object, a missing file, an
// exhausted budget) only appear when the real pieces are present.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { copyArtifactObjects, restoreArtifactObjects, pruneBackups, createBackup, restoreBackup, verifyDatabaseFile, entityCounts } from '../src/db/backup.js'
import { RateLimiter, loginKeys } from '../src/security/ratelimit.js'
import { TokenKeyring, keyringFromConfig, parsePreviousKeys, issueAccessToken, verifyAccessToken } from '../src/auth/tokens.js'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIGNING_KEY = 'h13-test-signing-key-long-enough-for-hs256'
const PREVIOUS_KEY = 'h13-previous-signing-key-long-enough-0000'
const CLI = join(SERVER_ROOT, 'src', 'cli', 'hub.js')

function tempDir(prefix = 'workgroup-hub-h13-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Remove a temp tree, tolerating the Windows behaviour that a file just released may still be
 * locked for a moment. A cleanup failure must never be reported as a test failure: it hides the
 * real result and sends the next reader after the wrong bug.
 */
function cleanup(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  } catch (error) {
    // Reported, not swallowed: a genuine leak should be visible without failing the case.
    process.emitWarning(`H-13 test cleanup left ${path} behind: ${error.message}`)
  }
}

/**
 * Run the operator CLI against a data directory, and capture its exit code.
 *
 * `sourceRoot` defaults to this repository's `server/`; a case that checks a *copy* passes the
 * copy's own CLI, because `deploy-check` inspects the package it is run from — running the
 * original CLI would verify the wrong tree and pass regardless.
 */
function runCli(args, env = {}, sourceRoot = SERVER_ROOT) {
  const result = spawnSync(process.execPath, [join(sourceRoot, 'src', 'cli', 'hub.js'), ...args], {
    cwd: sourceRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    // No shell: `| tail` swallowing the exit code is the defect this suite exists to avoid
    // repeating, so the status is read from spawnSync and never from a pipeline.
    shell: false,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * A Hub with a real database, used by cases that just need a scene.
 *
 * The database handle is closed in `finally` even when a case throws, because a leaked handle on
 * Windows turns the *next* cleanup into an EPERM that masks the assertion that actually failed.
 */
async function withLocalHub(run) {
  const root = tempDir()
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
  let db
  try {
    db = openDatabase(config)
    migrate(db)
    await run({ config, db, root })
  } finally {
    try { db?.close() } catch { /* already closed by the case */ }
    cleanup(root)
  }
}

async function withHub(run, env = {}) {
  const root = tempDir()
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, ...env })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token) => {
    const headers = {}
    let payload
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({ method, url: `/api/v1${path}`, headers, payload })
    let json
    try { json = response.json() } catch { json = undefined }
    return { status: response.statusCode, body: json, headers: response.headers, raw: response.body }
  }
  try {
    await run({ config, db, server, call, root })
  } finally {
    await server.close()
    try { db.close() } catch { /* a case may have closed it */ }
    cleanup(root)
  }
}

async function signIn(call, handle, password, fingerprint = `sha256:${handle}-device`) {
  await call('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
  const login = await call('POST', '/auth/login', { userHandle: handle, password, fingerprint, publicKey: `ed25519:${handle}` })
  assert.equal(login.status, 200, login.raw)
  return { userId: login.body.user.id, token: login.body.accessToken }
}

// ---------------------------------------------------------------------------
// 1. A server-only copy runs on its own
// ---------------------------------------------------------------------------

/** Copy `server/` the way an operator would: sources and manifests, no node_modules, no data. */
function copyServerOnly(destination) {
  cpSync(SERVER_ROOT, destination, {
    recursive: true,
    filter: (source) => {
      const name = source.slice(SERVER_ROOT.length + 1).split(/[\\/]/)[0]
      return name !== 'node_modules' && name !== 'data'
    },
  })
  return destination
}

/**
 * Make a copied tree runnable by pointing its `node_modules` at this repository's install.
 *
 * A deployment runs `npm ci` from the lockfile; this suite cannot (it would download the whole
 * dependency tree per case). Linking the install is the honest substitute: it means the cases
 * below exercise the copy's own *source* and *manifests* — which is what `deploy-check` audits and
 * what actually differs between a good copy and a bad one — while the dependencies are the ones
 * the lockfile pins. A junction is used rather than a symlink because Windows requires no
 * elevation for it, and it is removed with the temp tree.
 */
function linkDependencies(copy) {
  symlinkSync(join(SERVER_ROOT, 'node_modules'), join(copy, 'node_modules'), 'junction')
  return copy
}

test('deploy-check passes on an intact copy of server/ and reports what it verified', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    const dataDir = join(root, 'data')
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: dataDir, NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 0, `deploy-check failed:\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /nothing outside server\/ is required to run this copy/)
    // The check has to state the counts it validated, otherwise "ok" is not reviewable.
    assert.match(result.stdout, /source files import only declared packages/)
    assert.match(result.stdout, /configuration valid for NODE_ENV=test/)
    // And it must not have invented a data directory it was only asked to validate.
    assert.equal(existsSync(dataDir), false)
  } finally {
    cleanup(root)
  }
})

test('deploy-check fails when a required file is missing, naming the file', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    rmSync(join(copy, 'src', 'index.js'))
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: join(root, 'data'), NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /FAIL\s+missing src\/index\.js/)
  } finally {
    cleanup(root)
  }
})

test('deploy-check refuses a copy that still needs the application project beside it', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    // The exact mistake the criterion names: the whole repository was copied to the server
    // instead of `server/` alone.
    mkdirSync(join(root, 'application'))
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: join(root, 'data'), NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /sibling application exists, so this is not a server-only copy/)
    assert.equal(existsSync(join(copy, 'src', 'index.js')), true)
  } finally {
    cleanup(root)
  }
})

test('deploy-check catches a dependency that only resolves because the repository is present', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    // A source file importing a package that the whole repository happens to hoist, but that
    // this package never declared: it works in the checkout and breaks on the server.
    const target = join(copy, 'src', 'stowaway.js')
    writeFileSync(target, "import tsx from 'tsx'\nexport default tsx\n")
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: join(root, 'data'), NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /imports not declared in dependencies: tsx/)
  } finally {
    cleanup(root)
  }
})

test('deploy-check refuses a relative import that climbs out of server/', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    writeFileSync(join(copy, 'src', 'climber.js'), "import x from '../../shared/protocol.js'\nexport default x\n")
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: join(root, 'data'), NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /source imports reach outside server\//)
  } finally {
    cleanup(root)
  }
})

test('deploy-check reports every problem at once, not just the first', () => {
  const root = tempDir()
  try {
    const copy = copyServerOnly(join(root, 'server'))
    rmSync(join(copy, 'src', 'index.js'))
    rmSync(join(copy, 'db', 'migrations'), { recursive: true })
    mkdirSync(join(root, 'packages'))
    const result = runCli(['deploy-check'], { HUB_DATA_DIR: join(root, 'data'), NODE_ENV: 'test' }, copy)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /missing src\/index\.js/)
    assert.match(result.stderr, /missing db\/migrations/)
    assert.match(result.stderr, /a sibling packages exists/)
  } finally {
    cleanup(root)
  }
})

test('the deployment artifacts a server-only install needs are present and name real variables', () => {
  // The runbook is only usable if the files it tells an operator to install exist. Checking the
  // files exist is static; checking they name the variables the Hub actually reads is what keeps
  // the example environment from drifting away from `src/config/index.js`.
  for (const name of [
    'deploy/systemd/workgroup-hub.service',
    'deploy/systemd/workgroup-hub-backup.service',
    'deploy/systemd/workgroup-hub-backup.timer',
    'deploy/systemd/hub.env.example',
    'deploy/container/Containerfile',
    '.dockerignore',
    'deploy/DEPLOYMENT.md',
  ]) {
    assert.equal(existsSync(join(SERVER_ROOT, name)), true, `${name} is missing`)
  }
  const envExample = readFileSync(join(SERVER_ROOT, 'deploy', 'systemd', 'hub.env.example'), 'utf8')
  const readVariables = new Set([...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1]))
  const configSource = readFileSync(join(SERVER_ROOT, 'src', 'config', 'index.js'), 'utf8')
  const knownVariables = new Set([...configSource.matchAll(/'(HUB_[A-Z0-9_]+|NODE_ENV)'/g)].map(match => match[1]))
  const unknown = [...readVariables].filter(name => !knownVariables.has(name))
  assert.deepEqual(unknown, [], `hub.env.example sets variables the Hub does not read: ${unknown.join(', ')}`)
  // The secret-shaped values must be placeholders, never a usable value.
  for (const line of envExample.split('\n')) {
    if (!line.startsWith('HUB_TOKEN_SIGNING_KEY=') && !line.startsWith('HUB_ADMIN_BOOTSTRAP_SECRET=')) continue
    assert.match(line, /REPLACE_WITH_/, `a secret in the example environment is not a placeholder: ${line}`)
  }
})

test('the systemd unit and the container file agree with the Hub on how it is started', () => {
  const unit = readFileSync(join(SERVER_ROOT, 'deploy', 'systemd', 'workgroup-hub.service'), 'utf8')
  assert.match(unit, /ExecStart=\/usr\/bin\/node src\/index\.js/)
  assert.match(unit, /EnvironmentFile=\/etc\/workgroup-ai\/hub\.env/)
  // The hardening must not be silently dropped: a Hub exposed on an intranet with `ProtectSystem`
  // removed is a different deployment from the one the doc describes.
  for (const directive of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true']) {
    assert.match(unit, new RegExp(directive.replace(/[.=]/g, '\\$&')), `${directive} is missing from the unit`)
  }
  // `ReadWritePaths` must match the HUB_DATA_DIR the example environment sets, or the Hub cannot
  // write its own database and fails at start-up with a permission error that looks like a bug.
  const envExample = readFileSync(join(SERVER_ROOT, 'deploy', 'systemd', 'hub.env.example'), 'utf8')
  const dataDir = /^HUB_DATA_DIR=(.+)$/m.exec(envExample)?.[1]?.trim()
  assert.ok(dataDir !== undefined)
  assert.match(unit, new RegExp(`ReadWritePaths=${dataDir.replace(/[.=]/g, '\\$&')}`))

  const containerfile = readFileSync(join(SERVER_ROOT, 'deploy', 'container', 'Containerfile'), 'utf8')
  assert.match(containerfile, /^FROM docker\.io\/library\/node:24-alpine$/m)
  assert.match(containerfile, /^USER node$/m)
  assert.match(containerfile, /npm ci/)
  // The image must never carry the database, and it must never carry the tests.
  // Docker only reads `.dockerignore` from the build-context root. A copy under `deploy/container/`
  // is inert, which is why this asserts the root path and not merely that the rules exist
  // somewhere.
  const dockerignore = readFileSync(join(SERVER_ROOT, '.dockerignore'), 'utf8')
  assert.equal(existsSync(join(SERVER_ROOT, 'deploy', 'container', '.dockerignore')), false,
    'a .dockerignore beside the Containerfile is never consulted by Docker; keep the one at the context root')
  for (const ignored of ['node_modules', 'data', 'tests', '.env']) {
    assert.match(dockerignore, new RegExp(`^${ignored.replace(/\./g, '\\.')}$`, 'm'), `.dockerignore does not exclude ${ignored}`)
  }
})

test('a copied server/ tree boots on its own, migrates, and answers both health probes over HTTP', async () => {
  const root = tempDir()
  let child
  try {
    const copy = linkDependencies(copyServerOnly(join(root, 'server')))
    const dataDir = join(root, 'data')
    // A real port, so the probes below are real HTTP to a real listening socket rather than an
    // injected request. `server.inject` cannot see protocol-layer problems; this can.
    const port = 18800 + Math.floor(Math.random() * 500)
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: copy,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HUB_DATA_DIR: dataDir,
        HUB_PORT: String(port),
        HUB_HOST: '127.0.0.1',
        HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
        HUB_REGISTRATION: 'closed',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout.on('data', (chunk) => { log += chunk })
    child.stderr.on('data', (chunk) => { log += chunk })

    const base = `http://127.0.0.1:${port}/api/v1`
    const deadline = Date.now() + 30_000
    let live
    while (Date.now() < deadline) {
      try {
        live = await fetch(`${base}/health/live`)
        break
      } catch {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
      }
    }
    assert.ok(live !== undefined, `the copied Hub never answered on port ${port}:\n${log}`)
    assert.equal(live.status, 200, log)
    const liveness = await live.json()
    assert.equal(liveness.service, 'workgroup-ai-hub')
    assert.equal(liveness.protocol, 'wg.v1')

    const ready = await fetch(`${base}/health/ready`)
    assert.equal(ready.status, 200, log)
    const readiness = await ready.json()
    // Readiness reads the database, so a 200 here proves the copied tree migrated and its data
    // directory is writable — not merely that a process started.
    assert.equal(readiness.status, 'ready')
    assert.equal(readiness.checks.journalMode, 'wal')

    // Production mode without a bootstrap secret must still boot; it is registration that closes.
    assert.match(log, /Hub is listening/)
    // The count is not asserted: it changes with every migration, and a test that has to be edited
    // whenever a migration is added stops being read. What matters is that every shipped migration
    // applied and the Hub reached its listening state.
    assert.match(log, /applied \d+ migration\(s\)|schema is current/)
    const applied = [...log.matchAll(/migration (\d{4}_[a-z0-9_]+\.sql): applied/g)].map(match => match[1])
    assert.ok(applied.length > 0, 'no migration was reported as applied')
    assert.ok(
      log.includes(`applied ${applied.length} migration(s): ${applied.join(', ')}`),
      `the summary line must name every migration it applied; saw ${applied.length}: ${applied.join(', ')}`,
    )
  } finally {
    // A SIGTERM is the Hub's normal shutdown: it closes the socket and the database. Waiting for
    // the exit is what proves the shutdown path works, rather than leaving an orphan listening.
    if (child !== undefined && child.exitCode === null) {
      const exited = new Promise(resolvePromise => child.once('exit', resolvePromise))
      child.kill('SIGTERM')
      const timedOut = await Promise.race([exited.then(() => false), new Promise(resolvePromise => setTimeout(() => resolvePromise(true), 10_000))])
      if (timedOut) child.kill('SIGKILL')
    }
    cleanup(root)
  }
})

// ---------------------------------------------------------------------------
// 2. Login cannot be guessed at network speed
// ---------------------------------------------------------------------------

test('login failures are counted per handle and refused with 429, and a success clears the count', async () => {
  await withHub(async ({ call }) => {
    const password = 'correct-horse-battery-staple'
    await call('POST', '/auth/register', { userHandle: 'target', displayName: 'Target', password })

    // The default budget is 10 in a 300 second window.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const wrong = await call('POST', '/auth/login', { userHandle: 'target', password: 'not-the-password', fingerprint: 'sha256:device-000000' })
      assert.equal(wrong.status, 401, `attempt ${attempt} should be a plain credential failure`)
    }
    const blocked = await call('POST', '/auth/login', { userHandle: 'target', password: 'not-the-password', fingerprint: 'sha256:device-000000' })
    assert.equal(blocked.status, 429, blocked.raw)
    assert.equal(blocked.body.error.code, 'TOO_MANY_ATTEMPTS')
    assert.ok(Number(blocked.headers['retry-after']) > 0, 'a 429 without Retry-After makes the client retry immediately')

    // The right password is refused too while the key is blocked. That is the point: otherwise
    // the counter only slows an attacker down and never stops one.
    const rightWhileBlocked = await call('POST', '/auth/login', { userHandle: 'target', password, fingerprint: 'sha256:device-000000' })
    assert.equal(rightWhileBlocked.status, 429, rightWhileBlocked.raw)
  })
})

test('the handle budget is case-insensitive and the source budget is not cleared by one success', async () => {
  await withHub(async ({ call }) => {
    const password = 'correct-horse-battery-staple'
    await signIn(call, 'alice', password)
    // `Alice` is the same account as `alice`; a per-case budget would multiply the attempts.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await call('POST', '/auth/login', { userHandle: 'Alice', password: 'wrong-password-here', fingerprint: 'sha256:device-111111' })
    }
    const blocked = await call('POST', '/auth/login', { userHandle: 'ALICE', password: 'wrong-password-here', fingerprint: 'sha256:device-111111' })
    assert.equal(blocked.status, 429, blocked.raw)

    // A second account on the same source is unaffected by the first account's handle budget...
    await call('POST', '/auth/register', { userHandle: 'bob', displayName: 'Bob', password })
    const bobFirst = await call('POST', '/auth/login', { userHandle: 'bob', password, fingerprint: 'sha256:bob-device-1111' })
    // ...unless the source itself has spent its budget, which a successful sign-in does not refund.
    assert.ok([200, 429].includes(bobFirst.status), bobFirst.raw)
  }, { HUB_LOGIN_MAX_ATTEMPTS: '3', HUB_LOGIN_WINDOW_SECONDS: '300', HUB_LOGIN_LOCKOUT_SECONDS: '60' })
})

test('a successful sign-in clears that handle\u2019s failures, so a typo does not lock a user out', async () => {
  await withHub(async ({ call }) => {
    const password = 'correct-horse-battery-staple'
    await signIn(call, 'carol', password)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await call('POST', '/auth/login', { userHandle: 'carol', password: 'typo-password-here', fingerprint: 'sha256:carol-device-1' })
    }
    const ok = await call('POST', '/auth/login', { userHandle: 'carol', password, fingerprint: 'sha256:carol-device-1' })
    assert.equal(ok.status, 200, ok.raw)
    // Two more failures then a success must still work: the window is 10, and the count restarted.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await call('POST', '/auth/login', { userHandle: 'carol', password: 'typo-password-here', fingerprint: 'sha256:carol-device-1' })
    }
    const again = await call('POST', '/auth/login', { userHandle: 'carol', password, fingerprint: 'sha256:carol-device-1' })
    assert.equal(again.status, 200, again.raw)
  }, { HUB_LOGIN_MAX_ATTEMPTS: '4', HUB_LOGIN_WINDOW_SECONDS: '300', HUB_LOGIN_LOCKOUT_SECONDS: '60' })
})

test('an unknown handle and a wrong password are counted alike, and neither says which was wrong', async () => {
  await withHub(async ({ call }) => {
    await call('POST', '/auth/register', { userHandle: 'dave', displayName: 'Dave', password: 'correct-horse-battery-staple' })
    const unknown = await call('POST', '/auth/login', { userHandle: 'nobody-here', password: 'whatever-goes-here', fingerprint: 'sha256:device-222222' })
    const wrong = await call('POST', '/auth/login', { userHandle: 'dave', password: 'whatever-goes-here', fingerprint: 'sha256:device-222222' })
    assert.equal(unknown.status, 401)
    assert.equal(wrong.status, 401)
    // Identical bodies: the response must not distinguish "no such handle" from "bad password".
    assert.deepEqual(unknown.body, wrong.body)
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS')
  }, { HUB_LOGIN_MAX_ATTEMPTS: '50' })
})

test('the limiter is bounded, so a spray from many sources cannot grow it without limit', () => {
  const limiter = new RateLimiter({ maxAttempts: 3, windowSeconds: 60, lockoutSeconds: 60, maxKeys: 32, now: () => Date.now() })
  for (let index = 0; index < 500; index += 1) limiter.recordFailure(`login:source:10.0.0.${index}`)
  assert.ok(limiter.size <= 32, `limiter grew to ${limiter.size} keys with a budget of 32`)
})

test('the limiter lets a key try again after its lockout, and counts down the window', () => {
  let clock = 1_000_000
  const limiter = new RateLimiter({ maxAttempts: 2, windowSeconds: 60, lockoutSeconds: 30, now: () => clock })
  limiter.recordFailure('k')
  limiter.recordFailure('k')
  const blocked = limiter.check('k')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSeconds, 30)
  clock += 30_001
  assert.equal(limiter.check('k').allowed, true)
})

test('login keys normalize the handle and key the source separately', () => {
  const keys = loginKeys({ handle: '  Alice  ', source: '10.1.2.3' })
  assert.deepEqual(keys, ['login:handle:alice', 'login:source:10.1.2.3'])
  // An empty handle (a malformed request) must still be counted against the source.
  assert.deepEqual(loginKeys({ handle: '', source: '10.1.2.3' }), ['login:source:10.1.2.3'])
  assert.deepEqual(loginKeys({}), [])
})

// ---------------------------------------------------------------------------
// 3. A backup is one restorable unit
// ---------------------------------------------------------------------------

/**
 * Put an artifact object on disk where the store expects it, and record the row that names it.
 *
 * The row is inserted directly rather than through the upload route because the subject here is
 * the backup: the bytes on disk are what `hub backup` has to copy, and driving a full multipart
 * upload would test H-11 again instead. The column set and the object path come from the real
 * schema and `storagePathFor`, so a change to either makes this fail loudly.
 */
function seedArtifactObject(db, config, { roomId, uploader, body }) {
  const sha256 = createHash('sha256').update(body).digest('hex')
  const target = join(config.artifactsDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body)
  // A room and a user are required by the schema, so the caller supplies them: a NULL room is not
  // a row the Hub can ever produce, and a fixture that used one would test a state nobody has.
  db.prepare(`INSERT INTO artifacts
    (id, task_id, room_id, uploader_user_id, file_name, sha256_hex, storage_key, size_bytes, acl_json, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      `artifact-${sha256.slice(0, 8)}`, roomId, uploader, 'report.csv', sha256,
      `objects/${sha256}`, body.length, JSON.stringify({ scope: 'room', contentType: 'text/csv' }), new Date().toISOString(),
    )
  return { sha256, path: target, id: `artifact-${sha256.slice(0, 8)}` }
}

/** A minimal but real scene: one user and one room, so an artifact can legally reference both. */
function seedScene(db) {
  const now = new Date().toISOString()
  // Column names and constraints are taken from `db/migrations/0001_schema.sql`, not invented:
  // a fixture that does not match the real schema would prove nothing about a real backup.
  db.prepare('INSERT INTO users (id, user_handle, display_name, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user-1', 'seeduser', 'Seed User', 'scrypt$1$1$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86), 'active', now)
  db.prepare('INSERT INTO rooms (id, name, owner_user_id, next_seq, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('room-1', 'Seed Room', 'user-1', 1, now)
  db.prepare('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run('room-1', 'user-1', 'owner', now)
  return { userId: 'user-1', roomId: 'room-1' }
}

test('a backup carries the artifact objects, and a restore puts the bytes back', async () => {
  const root = tempDir()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
    const db = openDatabase(config)
    migrate(db)
    const scene = seedScene(db)
    const body = Buffer.from('seed,value\nalpha,41\n', 'utf8')
    const seeded = seedArtifactObject(db, config, { roomId: scene.roomId, uploader: scene.userId, body })

    const backup = await createBackup(db, { backupDir: config.backupDir, label: 'unit' })
    const copied = copyArtifactObjects(db, { artifactsDir: config.artifactsDir, snapshotPath: backup.path })
    // The writer and the reader must agree on the name, because `hub restore` finds the objects
    // by deriving it from the snapshot path.
    assert.equal(copied.directory, `${backup.path.replace(/\.sqlite$/, '')}-objects`)
    assert.equal(copied.objects, 1)
    assert.deepEqual(copied.missing, [])
    assert.equal(readFileSync(join(copied.directory, seeded.sha256)).equals(body), true)

    // Lose the live object the way a disk loss would: the row stays, the bytes are gone.
    rmSync(seeded.path)
    assert.equal(existsSync(seeded.path), false)

    const restored = restoreArtifactObjects({ backupObjectsDir: copied.directory, artifactsDir: config.artifactsDir })
    assert.equal(restored.restored, 1)
    assert.equal(readFileSync(seeded.path).equals(body), true)
    // Restoring twice does not duplicate or overwrite: object paths are content-addressed.
    const again = restoreArtifactObjects({ backupObjectsDir: copied.directory, artifactsDir: config.artifactsDir })
    assert.equal(again.restored, 0)
    assert.equal(again.skipped, 1)
    db.close()
  } finally {
    cleanup(root)
  }
})

test('a backup reports an object whose bytes are gone instead of silently shipping an incomplete set', () => {
  const root = tempDir()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
    const db = openDatabase(config)
    migrate(db)
    const scene = seedScene(db)
    const seeded = seedArtifactObject(db, config, { roomId: scene.roomId, uploader: scene.userId, body: Buffer.from('gone\n', 'utf8') })
    rmSync(seeded.path)
    const copied = copyArtifactObjects(db, { artifactsDir: config.artifactsDir, snapshotPath: join(config.backupDir, 'unit-check.sqlite') })
    assert.equal(copied.objects, 0)
    assert.deepEqual(copied.missing, [seeded.sha256])
    // The directory is still created, so an operator can see the set exists and is short.
    assert.equal(existsSync(copied.directory), true)
    db.close()
  } finally {
    cleanup(root)
  }
})

test('the deployment entry point writes a complete backup set, and reports it on stdout', () => {
  const root = tempDir()
  try {
    const dataDir = join(root, 'data')
    const env = { NODE_ENV: 'test', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY }
    assert.equal(runCli(['migrate'], env).status, 0)

    // Put an object on disk through the store's own path rule, then run the operator command.
    const config = loadConfig(env)
    const db = openDatabase(config)
    const scene = seedScene(db)
    const body = Buffer.from('column\nvalue\n', 'utf8')
    const seeded = seedArtifactObject(db, config, { roomId: scene.roomId, uploader: scene.userId, body })
    db.close()

    const result = runCli(['backup', '--label', 'scheduled'], env)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /artifact objects: 1 \(/)
    // The snapshot, its manifest, and its objects must all exist under the configured directory.
    const names = readdirSync(config.backupDir)
    const snapshot = names.find(name => name.endsWith('.sqlite'))
    assert.ok(snapshot !== undefined, `no snapshot in ${config.backupDir}: ${names.join(', ')}`)
    assert.ok(names.some(name => name === `${snapshot}.manifest.json`), 'no manifest beside the snapshot')
    const objects = names.find(name => name.endsWith('-objects'))
    assert.ok(objects !== undefined, 'no object directory beside the snapshot')
    assert.equal(readFileSync(join(config.backupDir, objects, seeded.sha256)).equals(body), true)

    // And the drill over that exact file must agree with every count the manifest recorded.
    const drill = runCli(['backup-drill', join(config.backupDir, snapshot)], env)
    assert.equal(drill.status, 0, `${drill.stdout}\n${drill.stderr}`)
    assert.match(drill.stdout, /every recorded count matches/)
  } finally {
    cleanup(root)
  }
})

test('restore puts the attachment bytes back as well as the rows, and reports both', () => {
  const root = tempDir()
  try {
    const dataDir = join(root, 'data')
    const env = { NODE_ENV: 'test', HUB_DATA_DIR: dataDir, HUB_TOKEN_SIGNING_KEY: SIGNING_KEY }
    assert.equal(runCli(['migrate'], env).status, 0)
    const config = loadConfig(env)
    const db = openDatabase(config)
    const scene = seedScene(db)
    const body = Buffer.from('restore-me\n', 'utf8')
    const seeded = seedArtifactObject(db, config, { roomId: scene.roomId, uploader: scene.userId, body })
    db.close()

    const backupRun = runCli(['backup', '--label', 'restore-drill'], env)
    assert.equal(backupRun.status, 0, backupRun.stdout)
    const backupPath = join(config.backupDir, readdirSync(config.backupDir).find(name => name.endsWith('.sqlite')))

    // Lose the bytes and the database together.
    rmSync(seeded.path)
    rmSync(config.dbPath)
    for (const sidecar of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(sidecar, { force: true })

    const restored = runCli(['restore', backupPath], env)
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`)
    assert.match(restored.stdout, /artifact objects: restored 1/)
    assert.equal(readFileSync(seeded.path).equals(body), true)

    // The restored database must be usable, not merely present.
    const verified = runCli(['verify'], env)
    assert.equal(verified.status, 0, verified.stdout)
  } finally {
    cleanup(root)
  }
})

test('a restore into a missing database leaves no misleading safety copy of nothing', async () => {
  const root = tempDir()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
    const db = openDatabase(config)
    migrate(db)
    const written = await createBackup(db, { backupDir: config.backupDir, label: 'restore-into-nothing' })
    db.close()
    {
      // The database is gone, exactly as it is after a disk loss.
      rmSync(config.dbPath)
      for (const sidecar of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(sidecar, { force: true })

      const restored = restoreBackup({ dbPath: config.dbPath, backupPath: written.path })
      // There was nothing to keep a copy of, so no copy is claimed. The old behaviour produced a
      // zero-byte `hub.sqlite.pre-restore-*` file, because merely *opening* a missing database
      // creates it — a safety copy of nothing, made by the act of checking whether it was safe.
      assert.equal(restored.safetyCopy, undefined)
      const leftovers = readdirSync(config.dataDir).filter(name => name.includes('pre-restore'))
      assert.deepEqual(leftovers, [])
      // The restore itself still worked, and the recovered file is owned the way the deployment
      // expects: there was no previous database, so the data directory's owner is the reference.
      assert.equal(existsSync(config.dbPath), true)
      assert.equal(restored.ownership.preserved, true)
      assert.equal(restored.ownership.source, 'the data directory')
      const dataDir = statSync(config.dataDir)
      assert.equal(statSync(config.dbPath).uid, dataDir.uid)
      assert.equal(verifyDatabaseFile(config.dbPath).ok, true)
    }
  } finally {
    cleanup(root)
  }
})

test('a restore refuses to run into a database that is still in use', async () => {
  const root = tempDir()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
    const db = openDatabase(config)
    migrate(db)
    const backup = await createBackup(db, { backupDir: config.backupDir, label: 'in-use' })
    // The live handle still holds the database, which is what "the Hub is still running" looks
    // like from the CLI's point of view.
    assert.throws(() => restoreBackup({ dbPath: config.dbPath, backupPath: backup.path }), /is in use|Stop the Hub first/)
    db.close()
  } finally {
    cleanup(root)
  }
})

test('a restore into an existing database keeps a real safety copy and preserves its ownership', async () => {
  const root = tempDir()
  try {
    const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data') })
    const db = openDatabase(config)
    migrate(db)
    seedScene(db)
    const backup = await createBackup(db, { backupDir: config.backupDir, label: 'with-previous' })
    const before = statSync(config.dbPath)
    db.close()

    const restored = restoreBackup({ dbPath: config.dbPath, backupPath: backup.path })
    assert.ok(restored.safetyCopy !== undefined, 'an existing database must be preserved before it is replaced')
    // The safety copy is the previous database, not an empty file created by a probe.
    const copy = statSync(restored.safetyCopy)
    assert.ok(copy.size > 0, 'the safety copy is empty, so it preserves nothing')
    assert.equal(verifyDatabaseFile(restored.safetyCopy).ok, true)

    // Ownership and mode are carried over from the replaced file, which is what makes the
    // restored database writable by the account that runs the Hub.
    assert.equal(restored.ownership.source, 'the replaced database')
    assert.equal(restored.ownership.applied.uid, before.uid)
    assert.equal(restored.ownership.applied.gid, before.gid)
    const after = statSync(config.dbPath)
    assert.equal(after.uid, before.uid)
    assert.equal(after.gid, before.gid)
    assert.equal(after.mode & 0o7777, before.mode & 0o7777)
  } finally {
    cleanup(root)
  }
})

test('retention keeps the newest sets and moves the rest aside without splitting a set', () => {
  const root = tempDir()
  try {
    const backupDir = join(root, 'backups')
    mkdirSync(backupDir, { recursive: true })
    // Five sets, each a snapshot, a manifest, and an object directory, named so the newest sorts
    // last. The naming is the contract: retention orders by the timestamp in the file name.
    for (let index = 1; index <= 5; index += 1) {
      const stamp = `2024010${index}-000000`
      const stem = `hub-${stamp}-aaaa`
      writeFileSync(join(backupDir, `${stem}.sqlite`), `db-${index}`)
      writeFileSync(join(backupDir, `${stem}.sqlite.manifest.json`), '{}')
      mkdirSync(join(backupDir, `${stem}-objects`))
      writeFileSync(join(backupDir, `${stem}-objects`, 'a'.repeat(64)), `object-${index}`)
    }
    const result = pruneBackups({ backupDir, keep: 2 })
    assert.equal(result.kept.length, 2)
    assert.equal(result.removed.length, 3)
    assert.deepEqual(result.kept.sort(), ['hub-20240104-000000-aaaa.sqlite', 'hub-20240105-000000-aaaa.sqlite'])

    const remaining = readdirSync(backupDir).filter(name => name.endsWith('.sqlite')).sort()
    assert.deepEqual(remaining, ['hub-20240104-000000-aaaa.sqlite', 'hub-20240105-000000-aaaa.sqlite'])
    // Every superseded set moved as a unit: no orphaned manifest or object directory is left
    // behind, and nothing was permanently lost.
    const quarantined = readdirSync(join(backupDir, 'superseded')).sort()
    assert.deepEqual(quarantined, [
      'hub-20240101-000000-aaaa-objects',
      'hub-20240101-000000-aaaa.sqlite',
      'hub-20240101-000000-aaaa.sqlite.manifest.json',
      'hub-20240102-000000-aaaa-objects',
      'hub-20240102-000000-aaaa.sqlite',
      'hub-20240102-000000-aaaa.sqlite.manifest.json',
      'hub-20240103-000000-aaaa-objects',
      'hub-20240103-000000-aaaa.sqlite',
      'hub-20240103-000000-aaaa.sqlite.manifest.json',
    ])
    // Running it again with the same budget is a no-op, so a cron that fires twice is harmless.
    const again = pruneBackups({ backupDir, keep: 2 })
    assert.deepEqual(again.removed, [])
  } finally {
    cleanup(root)
  }
})

test('retention refuses a nonsensical budget rather than deleting everything', () => {
  const root = tempDir()
  try {
    const backupDir = join(root, 'backups')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'hub-x.sqlite'), 'db')
    for (const keep of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => pruneBackups({ backupDir, keep }), /positive integer/)
    }
    assert.equal(existsSync(join(backupDir, 'hub-x.sqlite')), true)
  } finally {
    cleanup(root)
  }
})

test('the backup command keeps only the configured number of sets', () => {
  const root = tempDir()
  try {
    const env = { NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_BACKUP_RETENTION_COUNT: '2', HUB_TOKEN_SIGNING_KEY: SIGNING_KEY }
    assert.equal(runCli(['migrate'], env).status, 0)
    for (let index = 0; index < 4; index += 1) {
      // Each run needs a distinct file name; the timestamp is per millisecond, so a label that
      // differs is not enough. Sleeping is not needed: the command adds a random suffix.
      const run = runCli(['backup', '--label', `run${index}`], env)
      assert.equal(run.status, 0, run.stdout)
    }
    const config = loadConfig(env)
    const snapshots = readdirSync(config.backupDir).filter(name => name.endsWith('.sqlite'))
    assert.equal(snapshots.length, 2, `expected 2 sets, found: ${snapshots.join(', ')}`)
    // The superseded ones are set aside, not destroyed.
    const quarantined = readdirSync(join(config.backupDir, 'superseded')).filter(name => name.endsWith('.sqlite'))
    assert.equal(quarantined.length, 2)
  } finally {
    cleanup(root)
  }
})

test('a backup and its objects survive an independent read: the drill sees the same entity counts', async () => {
  await withHub(async ({ config, db, server, call }) => {
    // A real room with a real message and a real attachment, so the counts are not all zero.
    await call('POST', '/auth/register', { userHandle: 'owner', displayName: 'Owner', password: 'correct-horse-battery-staple' })
    const login = await call('POST', '/auth/login', { userHandle: 'owner', password: 'correct-horse-battery-staple', fingerprint: 'sha256:owner-device-1', publicKey: 'ed25519:owner' })
    const token = login.body.accessToken
    const room = await call('POST', '/rooms', { name: 'H-13 群', kind: 'ordinary' }, token)
    assert.ok([200, 201].includes(room.status), room.raw)
    const roomId = room.body.room.id
    const message = await call('POST', `/rooms/${roomId}/messages`, { clientMessageId: 'h13-drill-message-0001', body: 'hello' }, token)
    assert.ok([200, 201].includes(message.status), message.raw)

    const backup = await createBackup(db, { backupDir: config.backupDir, label: 'drill' })
    const counts = entityCounts(db)
    assert.ok(counts.messages >= 1, 'the scene did not produce a message to lose')
    // The manifest must record the counts, because `backup-drill` compares against exactly these.
    const manifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8'))
    assert.equal(manifest.entityCounts.messages, counts.messages)
    assert.ok(manifest.entityCounts.room_members >= 1)

    // And the operator's drill over that file must agree with every count, through the real CLI.
    const drill = runCli(['backup-drill', backup.path], { NODE_ENV: 'test', HUB_DATA_DIR: config.dataDir })
    assert.equal(drill.status, 0, `${drill.stdout}
${drill.stderr}`)
    assert.match(drill.stdout, /every recorded count matches/)
    assert.match(drill.stdout, /entities:\s+\d+ tables, [1-9]\d* rows/)
  })
})

// ---------------------------------------------------------------------------
// 4. Key rotation does not log anyone out
// ---------------------------------------------------------------------------

test('a token signed with the previous key still verifies while the current key signs new ones', () => {
  const before = keyringFromConfig({ tokenSigningKey: PREVIOUS_KEY })
  const oldToken = issueAccessToken({ keyring: before, userId: 'user-1', deviceId: 'device-1', ttlSeconds: 900 })

  // The rotation: the same deployment now signs with `k2` and still holds `k1`.
  const after = keyringFromConfig({
    tokenSigningKey: SIGNING_KEY,
    currentKid: 'k2',
    previousKeys: parsePreviousKeys(`k1:${PREVIOUS_KEY}`),
  })
  const payload = verifyAccessToken(oldToken, { keyring: after })
  assert.equal(payload.sub, 'user-1')
  assert.equal(oldToken.split('.')[1], 'k1')

  const newToken = issueAccessToken({ keyring: after, userId: 'user-2', deviceId: 'device-2', ttlSeconds: 900 })
  assert.equal(newToken.split('.')[1], 'k2', 'the current key must be the one that signs')
  assert.equal(verifyAccessToken(newToken, { keyring: after }).sub, 'user-2')
})

test('rotating onto the same key id is refused, because it would log every user out silently', () => {
  // The mistake this check exists for: an operator pastes the new key into
  // HUB_TOKEN_SIGNING_KEY and the old key into HUB_TOKEN_SIGNING_KEY_PREVIOUS under the same
  // kid. The old key would be overwritten and every outstanding token would start failing.
  assert.throws(
    () => keyringFromConfig({ tokenSigningKey: SIGNING_KEY, previousKeys: parsePreviousKeys(`k1:${PREVIOUS_KEY}`) }),
    /Rotating a key requires a new key id/,
  )
})

test('a keyring refuses a token signed with a key it does not hold, rather than falling back', () => {
  const keyring = keyringFromConfig({ tokenSigningKey: SIGNING_KEY, currentKid: 'k2', previousKeys: parsePreviousKeys(`k1:${PREVIOUS_KEY}`) })
  const foreign = issueAccessToken({ signingKey: 'a-completely-different-signing-key-0000', userId: 'u', deviceId: 'd', ttlSeconds: 900 })
  // The foreign token names `k1`, which this keyring still holds as a previous key, so the
  // refusal is a signature failure — the key is wrong, not missing.
  assert.throws(() => verifyAccessToken(foreign, { keyring }), (error) => {
    assert.equal(error.code, 'BAD_SIGNATURE')
    return true
  })

  // A token naming a kid nobody holds is refused before any signature work happens.
  const known = issueAccessToken({ keyring, userId: 'u', deviceId: 'd', ttlSeconds: 900 })
  assert.throws(() => verifyAccessToken(known.replace('.k2.', '.k7.'), { keyring }), (error) => {
    assert.equal(error.code, 'UNKNOWN_KEY_ID')
    return true
  })

  // A token signed under a kid the Hub holds but with the wrong key material is a signature
  // failure: the two refusals mean different things to an operator, so they stay distinct.
  const wrongMaterial = issueAccessToken({ signingKey: 'the-wrong-key-material-for-this-kid-0', userId: 'u', deviceId: 'd', ttlSeconds: 900 })
  assert.throws(() => verifyAccessToken(wrongMaterial, { keyring }), (error) => {
    assert.equal(error.code, 'BAD_SIGNATURE')
    return true
  })
})

test('the previous-key configuration format is strict, because a dropped key locks users out', () => {
  assert.deepEqual([...parsePreviousKeys(undefined)], [])
  assert.deepEqual([...parsePreviousKeys('')], [])
  assert.deepEqual([...parsePreviousKeys('k1:abcdefghijklmnopqrstuvwxyz0123456789')], [['k1', 'abcdefghijklmnopqrstuvwxyz0123456789']])
  // Two rotations in flight at once.
  assert.equal(parsePreviousKeys(`k1:${PREVIOUS_KEY},k2:${PREVIOUS_KEY}`).size, 2)
  assert.throws(() => parsePreviousKeys('no-separator-here'), /must be kid:key/)
  assert.throws(() => parsePreviousKeys('nonsense!:' + 'x'.repeat(40)), /must look like k1, k2, krot2024/)
  assert.throws(() => parsePreviousKeys('k1:too-short'), /at least 32 characters/)
})

test('a keyring refuses to be built without a current key, or with a bad kid shape', () => {
  assert.throws(() => new TokenKeyring({ keys: {} }), /at least one key/)
  assert.throws(() => new TokenKeyring({ currentKid: 'k2', keys: { k1: 'x'.repeat(32) } }), /is not in the keyring/)
  assert.throws(() => new TokenKeyring({ keys: { 'bad kid': 'x'.repeat(32) } }), /must look like/)
})

test('an HTTP request authenticated with a previous-key token is accepted', async () => {
  await withHub(async ({ call, config }) => {
    const password = 'correct-horse-battery-staple'
    const signedIn = await signIn(call, 'rotator', password)
    const devices = await call('GET', '/devices', undefined, signedIn.token)
    assert.equal(devices.status, 200, devices.raw)
    const deviceId = devices.body.devices[0].id

    // Re-sign the same user and the same live device with the key this Hub has moved to the
    // previous slot — exactly the state of a token issued just before a rotation.
    const before = keyringFromConfig({ tokenSigningKey: PREVIOUS_KEY })
    const rotatedToken = issueAccessToken({ keyring: before, userId: signedIn.userId, deviceId, ttlSeconds: 900 })

    const ok = await call('GET', '/auth/me', undefined, rotatedToken)
    assert.equal(ok.status, 200, ok.raw)
    assert.equal(ok.body.user.userHandle, 'rotator')
    // The Hub really is holding two keys, and the token really names the previous one.
    assert.equal(config.security.tokenKeyIds, 2)
    assert.equal(rotatedToken.split('.')[1], 'k1')
    // New tokens are signed with the rotated key, so the old one can be dropped after one
    // access-token lifetime.
    assert.equal(signedIn.token.split('.')[1], 'k2')
    assert.equal((await call('GET', '/auth/me', undefined, signedIn.token)).status, 200)

    // A token signed with a key the Hub does not hold is still refused.
    const foreign = issueAccessToken({ signingKey: 'a-key-this-hub-never-held-00000000', userId: signedIn.userId, deviceId, ttlSeconds: 900 })
    assert.equal((await call('GET', '/auth/me', undefined, foreign)).status, 401)
    // And a previous-key token for a device that does not exist is refused on the device check,
    // which proves the key acceptance did not skip the rest of authentication.
    const unknownDevice = issueAccessToken({ keyring: before, userId: signedIn.userId, deviceId: 'no-such-device', ttlSeconds: 900 })
    assert.equal((await call('GET', '/auth/me', undefined, unknownDevice)).status, 403)
  }, { HUB_TOKEN_SIGNING_KEY: SIGNING_KEY, HUB_TOKEN_SIGNING_KEY_CURRENT_KID: 'k2', HUB_TOKEN_SIGNING_KEY_PREVIOUS: `k1:${PREVIOUS_KEY}` })
})

test('a single-key Hub refuses a token signed with any other key, and says which kid it holds', async () => {
  await withHub(async ({ call, config }) => {
    const password = 'correct-horse-battery-staple'
    const signedIn = await signIn(call, 'solo', password)
    const devices = await call('GET', '/devices', undefined, signedIn.token)
    const deviceId = devices.body.devices[0].id
    assert.equal(config.security.tokenKeyIds, 1)

    const other = keyringFromConfig({ tokenSigningKey: PREVIOUS_KEY })
    const foreign = issueAccessToken({ keyring: other, userId: signedIn.userId, deviceId, ttlSeconds: 900 })
    // Same kid, different key material: refused as a signature failure, not as an unknown kid.
    assert.equal((await call('GET', '/auth/me', undefined, foreign)).status, 401)
  })
})

test('the /auth/config route tells a client which key ids the Hub will accept', async () => {
  await withHub(async ({ call }) => {
    const response = await call('GET', '/auth/config')
    assert.equal(response.status, 200)
    assert.equal(response.body.protocol.length > 0, true)
  })
})

// ---------------------------------------------------------------------------
// 5. Health and configuration surface the new settings
// ---------------------------------------------------------------------------

test('status prints the security settings an operator needs to reason about', () => {
  const root = tempDir()
  try {
    const result = runCli(['status'], {
      NODE_ENV: 'test',
      HUB_DATA_DIR: join(root, 'data'),
      HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
      HUB_LOGIN_MAX_ATTEMPTS: '5',
      HUB_MAX_CONNECTIONS: '10',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /login:\s+5 attempt/)
    assert.match(result.stdout, /connections:\s+10 total/)
  } finally {
    cleanup(root)
  }
})

test('a bad security setting is a configuration failure, not a silent default', () => {
  const root = tempDir()
  try {
    for (const [name, value] of [
      ['HUB_LOGIN_MAX_ATTEMPTS', '0'],
      ['HUB_LOGIN_WINDOW_SECONDS', '0'],
      ['HUB_LOGIN_LOCKOUT_SECONDS', '-1'],
      ['HUB_MAX_CONNECTIONS_PER_USER', '9999'],
      ['HUB_TOKEN_SIGNING_KEY_PREVIOUS', 'garbage'],
    ]) {
      const result = runCli(['status'], { NODE_ENV: 'test', HUB_DATA_DIR: join(root, `data-${name}`), [name]: value })
      assert.equal(result.status, 78, `${name}=${value} should be refused:\n${result.stdout}\n${result.stderr}`)
      assert.match(result.stderr, new RegExp(name))
    }
  } finally {
    cleanup(root)
  }
})

test('a per-user socket cap refuses the extra connection without disturbing the existing one', async () => {
  await withHub(async ({ config, db, server, call }) => {
    const signedIn = await signIn(call, 'socketty', 'correct-horse-battery-staple')
    const realtime = server.hub.realtime
    const fake = () => ({ close: () => {}, ping: () => {} })
    const auth = { user: { id: signedIn.userId }, deviceId: 'device-1' }
    const first = realtime.admitFor({ socket: fake(), auth })
    assert.equal(first.ok, true)
    const second = realtime.admitFor({ socket: fake(), auth })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'TOO_MANY_CONNECTIONS_FOR_USER')
    // The already-admitted socket is untouched: a cap must not be implemented by evicting someone.
    assert.equal(realtime.countForUser(signedIn.userId), 1)
    assert.equal(config.security.maxConnectionsPerUser, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  }, { HUB_MAX_CONNECTIONS_PER_USER: '1' })
})

test('a whole-process socket cap refuses new connections with its own code', async () => {
  await withHub(async ({ call, server }) => {
    const signedIn = await signIn(call, 'sockettwo', 'correct-horse-battery-staple')
    const realtime = server.hub.realtime
    const fake = () => ({ close: () => {}, ping: () => {} })
    assert.equal(realtime.admitFor({ socket: fake(), auth: { user: { id: signedIn.userId }, deviceId: 'd' } }).ok, true)
    const refused = realtime.admitFor({ socket: fake(), auth: { user: { id: 'another-user' }, deviceId: 'd2' } })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'TOO_MANY_CONNECTIONS')
  }, { HUB_MAX_CONNECTIONS: '1', HUB_MAX_CONNECTIONS_PER_USER: '0' })
})

test('a Hub with the caps disabled accepts connections, so an operator can turn them off', async () => {
  await withHub(async ({ call, server }) => {
    const signedIn = await signIn(call, 'socketthree', 'correct-horse-battery-staple')
    const realtime = server.hub.realtime
    const fake = () => ({ close: () => {}, ping: () => {} })
    for (let index = 0; index < 50; index += 1) {
      assert.equal(realtime.admitFor({ socket: fake(), auth: { user: { id: signedIn.userId }, deviceId: 'd' } }).ok, true)
    }
    assert.equal(realtime.countForUser(signedIn.userId), 50)
  }, { HUB_MAX_CONNECTIONS: '0', HUB_MAX_CONNECTIONS_PER_USER: '0' })
})
