// Hub configuration: read once from the environment, validate, then freeze.
//
// The Hub must start from a copy of `server/` alone, so nothing in here may import
// from `application/`, assume a DSH install, or reach outside `HUB_DATA_DIR` for
// state. Validation collects every problem instead of failing on the first one, and
// it never echoes a secret value: problems name the variable, never its content.

import { accessSync, constants, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { parsePreviousKeys, keyringFromConfig } from '../auth/tokens.js'

export class ConfigError extends Error {
  constructor(problems) {
    super(`Hub configuration is invalid:\n- ${problems.join('\n- ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']

function readString(env, name) {
  const raw = env[name]
  if (raw === undefined || raw === null) return undefined
  const trimmed = String(raw).trim()
  return trimmed === '' ? undefined : trimmed
}

function readInteger(env, name, problems, { min, max }) {
  const raw = readString(env, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`)
    return undefined
  }
  return value
}

// `readInteger` reports the full accepted range so an operator sees the real bound
// (including that HUB_PORT accepts 0) instead of a number that looks like a typo fix.
/**
 * Resolve and validate a directory-shaped setting.
 *
 * Three policies, because three callers need three different answers:
 *   `create`        make it if absent — the Hub at start-up, which wants to work on a fresh host.
 *   `fail`          refuse if absent — a command that reads an existing deployment.
 *   `allowMissing`  accept if absent, but check the nearest existing ancestor — `deploy-check`,
 *                   which audits a host *before* the first start and must not fail a correct
 *                   deployment just because the data directory has not been created yet.
 *
 * @param {string | undefined} value
 * @param {string} name
 * @param {string[]} problems
 * @param {{ create?: boolean, allowMissing?: boolean }} policy
 */
function requireAbsoluteDirectory(value, name, problems, { create, allowMissing = false }) {
  if (value === undefined) return undefined
  if (!isAbsolute(value)) {
    problems.push(`${name} must be an absolute path`)
    return undefined
  }
  const path = resolve(value)
  if (!existsSync(path)) {
    if (allowMissing) {
      // The path is accepted, but it cannot be accepted blindly: if the parent chain is also
      // missing (or is a file), the Hub's own `mkdir` at start-up would fail, and a check that
      // passed that host would have been worthless.
      let ancestor = resolve(path, '..')
      while (!existsSync(ancestor) && resolve(ancestor, '..') !== ancestor) ancestor = resolve(ancestor, '..')
      if (!existsSync(ancestor)) {
        problems.push(`${name} cannot be created: no existing ancestor directory for ${path}`)
        return undefined
      }
      try {
        if (!statSync(ancestor).isDirectory()) {
          problems.push(`${name} cannot be created: ${ancestor} is not a directory`)
          return undefined
        }
        accessSync(ancestor, constants.R_OK | constants.W_OK)
      } catch (error) {
        problems.push(`${name} cannot be created under ${ancestor}: ${error.message}`)
        return undefined
      }
      return path
    }
    if (!create) {
      problems.push(`${name} does not exist: ${path}`)
      return undefined
    }
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    } catch (error) {
      problems.push(`${name} cannot be created (${path}): ${error.message}`)
      return undefined
    }
  }
  try {
    if (!statSync(path).isDirectory()) {
      problems.push(`${name} must be a directory: ${path}`)
      return undefined
    }
    accessSync(path, constants.R_OK | constants.W_OK)
  } catch (error) {
    problems.push(`${name} is not readable and writable (${path}): ${error.message}`)
    return undefined
  }
  return path
}

function checkReadableFile(value, name, problems) {
  if (value === undefined) return undefined
  if (!isAbsolute(value)) {
    problems.push(`${name} must be an absolute path`)
    return undefined
  }
  try {
    accessSync(value, constants.R_OK)
    if (!statSync(value).isFile()) {
      problems.push(`${name} must be a regular file: ${value}`)
      return undefined
    }
  } catch (error) {
    problems.push(`${name} is not readable (${value}): ${error.message}`)
    return undefined
  }
  return resolve(value)
}

function readPublicUrl(env, problems) {
  const raw = readString(env, 'HUB_PUBLIC_URL')
  if (raw === undefined) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    problems.push('HUB_PUBLIC_URL must be an absolute URL')
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push('HUB_PUBLIC_URL must use http or https')
    return undefined
  }
  // Production tokens must never travel over cleartext; the Hub refuses to advertise
  // an http origin there instead of silently downgrading.
  if (url.protocol === 'http:') return { origin: url.origin, insecure: true }
  return { origin: url.origin, insecure: false }
}

/**
 * Validate the Hub environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string, createDataDir?: boolean, allowMissingDataDir?: boolean }} [options]
 */
export function loadConfig(env = process.env, options = {}) {
  const { cwd = process.cwd(), createDataDir = true } = options
  const problems = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
    problems.push(`Node.js 24 or newer is required (running ${process.versions.node})`)
  }

  const nodeEnv = readString(env, 'NODE_ENV') ?? 'production'
  if (!['production', 'development', 'test'].includes(nodeEnv)) {
    problems.push('NODE_ENV must be one of production, development, test')
  }
  const production = nodeEnv === 'production'

  const host = readString(env, 'HUB_HOST') ?? '127.0.0.1'
  // Port 0 is accepted on purpose: it asks the OS for a free port, which is how the
  // test suite and a port-conflicted operator bring the Hub up without guessing.
  const port = readInteger(env, 'HUB_PORT', problems, { min: 0, max: 65535 }) ?? 8443

  const dataDirRaw = readString(env, 'HUB_DATA_DIR')
  const dataDir = requireAbsoluteDirectory(
    dataDirRaw === undefined ? resolve(cwd, 'data') : dataDirRaw,
    'HUB_DATA_DIR',
    problems,
    { create: createDataDir, allowMissing: options.allowMissingDataDir === true },
  )

  const publicUrl = readPublicUrl(env, problems)

  const tlsCert = checkReadableFile(readString(env, 'HUB_TLS_CERT'), 'HUB_TLS_CERT', problems)
  const tlsKey = checkReadableFile(readString(env, 'HUB_TLS_KEY'), 'HUB_TLS_KEY', problems)
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    problems.push('HUB_TLS_CERT and HUB_TLS_KEY must be set together')
  }

  const tokenSigningKey = readString(env, 'HUB_TOKEN_SIGNING_KEY')
  if (production) {
    // Required in production only; tests and local runs may inject their own key so a
    // developer never has to keep one on disk.
    if (tokenSigningKey === undefined) problems.push('HUB_TOKEN_SIGNING_KEY is required when NODE_ENV=production')
    else if (tokenSigningKey.length < 32) problems.push('HUB_TOKEN_SIGNING_KEY must be at least 32 characters')
  }

  // Key rotation. `HUB_TOKEN_SIGNING_KEY_PREVIOUS` holds keys that may still *verify* but no
  // longer sign, which is what lets an operator change the signing key without invalidating the
  // tokens already in users' hands. A parse failure is reported like any other config problem
  // rather than dropped: a silently discarded previous key locks users out with no diagnostic.
  const currentKid = readString(env, 'HUB_TOKEN_SIGNING_KEY_CURRENT_KID') ?? 'k1'
  let previousKeys
  try {
    previousKeys = parsePreviousKeys(readString(env, 'HUB_TOKEN_SIGNING_KEY_PREVIOUS'))
  } catch (error) {
    problems.push(error.message)
    previousKeys = new Map()
  }
  let tokenKeyring
  try {
    tokenKeyring = keyringFromConfig({ tokenSigningKey, currentKid, previousKeys })
  } catch (error) {
    problems.push(error.message)
    tokenKeyring = undefined
  }

  // Login throttling. These are configuration because the right numbers depend on the site: a
  // small office and an internet-facing Hub do not share a sensible budget.
  const loginMaxAttempts = readInteger(env, 'HUB_LOGIN_MAX_ATTEMPTS', problems, { min: 1, max: 1000 }) ?? 10
  const loginWindowSeconds = readInteger(env, 'HUB_LOGIN_WINDOW_SECONDS', problems, { min: 10, max: 86400 }) ?? 300
  const loginLockoutSeconds = readInteger(env, 'HUB_LOGIN_LOCKOUT_SECONDS', problems, { min: 0, max: 86400 }) ?? 300
  // Socket ceilings. `0` disables the cap, which is the right choice for a self-hosted Hub with
  // a handful of users and an operator who would rather not discover a wrong number in an
  // outage; the default is generous but finite.
  const maxConnectionsPerUser = readInteger(env, 'HUB_MAX_CONNECTIONS_PER_USER', problems, { min: 0, max: 1000 }) ?? 8
  const maxConnectionsTotal = readInteger(env, 'HUB_MAX_CONNECTIONS', problems, { min: 0, max: 100000 }) ?? 2000

  // Registration is the front door to a company Hub, so the default depends on the
  // environment rather than being uniformly open: production requires an operator
  // bootstrap secret, while tests and local runs admit anyone so a developer can create
  // the first account without ceremony.
  const registrationMode = readString(env, 'HUB_REGISTRATION') ?? (production ? 'admin_secret' : 'open')
  if (!['open', 'admin_secret', 'closed'].includes(registrationMode)) {
    problems.push('HUB_REGISTRATION must be one of open, admin_secret, closed')
  }
  const adminBootstrapSecret = readString(env, 'HUB_ADMIN_BOOTSTRAP_SECRET')
  if (registrationMode === 'admin_secret') {
    if (adminBootstrapSecret === undefined) problems.push('HUB_ADMIN_BOOTSTRAP_SECRET is required when HUB_REGISTRATION=admin_secret')
    else if (adminBootstrapSecret.length < 16) problems.push('HUB_ADMIN_BOOTSTRAP_SECRET must be at least 16 characters')
  }

  // Token lifetimes are configuration, not constants: a company that wants short-lived
  // access tokens with long refresh windows must not need a code change.
  const accessTokenTtlSeconds = readInteger(env, 'HUB_ACCESS_TOKEN_TTL_SECONDS', problems, { min: 60, max: 86400 }) ?? 900
  const refreshTokenTtlSeconds = readInteger(env, 'HUB_REFRESH_TOKEN_TTL_SECONDS', problems, { min: 3600, max: 60 * 60 * 24 * 90 }) ?? 60 * 60 * 24 * 14
  if (refreshTokenTtlSeconds <= accessTokenTtlSeconds) {
    problems.push('HUB_REFRESH_TOKEN_TTL_SECONDS must be greater than HUB_ACCESS_TOKEN_TTL_SECONDS')
  }
  const deviceKeyTtlSeconds = readInteger(env, 'HUB_DEVICE_KEY_TTL_SECONDS', problems, { min: 60, max: 60 * 60 * 24 * 365 }) ?? 60 * 60 * 24 * 30

  const maxMessageBytes = readInteger(env, 'HUB_MAX_MESSAGE_BYTES', problems, { min: 1024, max: 8 * 1024 * 1024 }) ?? 131072
  const maxUploadBytes = readInteger(env, 'HUB_MAX_UPLOAD_BYTES', problems, { min: 1024, max: 1024 * 1024 * 1024 }) ?? 10485760
  if (maxUploadBytes < maxMessageBytes) {
    // An upload ceiling below the message ceiling would reject message bodies that the
    // message limit already accepted, so the two limits must not contradict each other.
    problems.push('HUB_MAX_UPLOAD_BYTES must be greater than or equal to HUB_MAX_MESSAGE_BYTES')
  }

  // Retention is configuration because it is a policy decision, not a technical one: how long a
  // company keeps its audit trail and its backups depends on what it must be able to prove.
  // A `null` value means "keep forever", which is the safe default for an audit trail.
  const auditRetentionDays = readInteger(env, 'HUB_AUDIT_RETENTION_DAYS', problems, { min: 1, max: 36500 }) ?? null
  const backupRetentionCount = readInteger(env, 'HUB_BACKUP_RETENTION_COUNT', problems, { min: 1, max: 1000 }) ?? 30

  const logLevel = readString(env, 'HUB_LOG_LEVEL') ?? 'info'
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`HUB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`)

  if (publicUrl !== undefined && publicUrl.insecure && production) {
    problems.push('HUB_PUBLIC_URL must use https when NODE_ENV=production')
  }
  if (production && tlsCert === undefined && publicUrl !== undefined && publicUrl.origin.startsWith('https:')) {
    // Terminating TLS at a reverse proxy is supported, so this stays a warning-level
    // fact rather than an error; it is reported at startup instead of hidden here.
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return Object.freeze({
    nodeEnv,
    production,
    host,
    port,
    dataDir,
    dbPath: resolve(dataDir, 'hub.sqlite'),
    artifactsDir: resolve(dataDir, 'artifacts'),
    logsDir: resolve(dataDir, 'logs'),
    backupDir: resolve(dataDir, 'backups'),
    publicUrl: publicUrl?.origin,
    tls: tlsCert === undefined ? undefined : Object.freeze({ certPath: tlsCert, keyPath: tlsKey }),
    hasTokenSigningKey: tokenSigningKey !== undefined,
    // The key itself is never part of the frozen config; only a derived fact is.
    readTokenSigningKey: () => {
      if (tokenSigningKey === undefined) throw new Error('HUB_TOKEN_SIGNING_KEY is not configured')
      return tokenSigningKey
    },
    // The keyring is exposed as one object so signing and verifying cannot drift apart: a
    // route that verified with a different key set than the one that signed would be a bug
    // no test could see without deliberately constructing it.
    tokenKeyring,
    hasPreviousTokenKeys: previousKeys.size > 0,
    registration: Object.freeze({
      mode: registrationMode,
      // A comparison secret is exposed as a checker, not a value, so it cannot be logged
      // or serialized by accident anywhere the config object travels.
      acceptsBootstrapSecret: (candidate) => {
        if (adminBootstrapSecret === undefined || typeof candidate !== 'string') return false
        const expected = Buffer.from(adminBootstrapSecret, 'utf8')
        const actual = Buffer.from(candidate, 'utf8')
        // timingSafeEqual requires equal lengths; comparing lengths first leaks only the
        // secret's length, which is already public in .env.example.
        if (expected.length !== actual.length) return false
        return timingSafeEqual(expected, actual)
      },
    }),
    tokens: Object.freeze({ accessTokenTtlSeconds, refreshTokenTtlSeconds, deviceKeyTtlSeconds }),
    retention: Object.freeze({ auditRetentionDays, backupRetentionCount }),
    limits: Object.freeze({ maxMessageBytes, maxUploadBytes }),
    security: Object.freeze({
      loginMaxAttempts,
      loginWindowSeconds,
      loginLockoutSeconds,
      maxConnectionsPerUser,
      maxConnectionsTotal,
      /** How many keys the keyring holds, never which they are. */
      tokenKeyIds: tokenKeyring?.kids.length ?? 0,
    }),
    logLevel,
  })
}

/**
 * Minimal TLS material loader used only when TLS is configured in-process.
 * A reverse proxy deployment leaves these unset and the Hub stays plain HTTP behind it.
 */
export function loadTlsOptions(config) {
  if (config.tls === undefined) return undefined
  return { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath) }
}

export const configInternals = { LOG_LEVELS }
