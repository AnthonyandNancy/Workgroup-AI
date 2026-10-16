// Hub HTTP server: health endpoints plus a strict JSON error shape.
//
// `createServer` is separate from `startHub` so tests can build a Hub on an ephemeral
// port, exercise it, and close it without touching process-wide state. Nothing here
// listens until `startHub` is called.

import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { loadTlsOptions } from './config/index.js'
import { probeWritable, readMeta, writeMeta } from './db/index.js'
import { buildRoutePlugins } from './api/index.js'
import { makeAuthenticator, makeRequireAuth } from './auth/request.js'
import { PersistentLimiter } from './security/ratelimit-store.js'
import { createSigningKeySet } from './modules/tasks/signing.js'
import { RealtimeHub } from './realtime/hub.js'
import { registerRealtimeRoute } from './realtime/route.js'
import { hubVersion, protocolVersion } from './version.js'

const STARTED_AT_KEY = 'hub.startedAt'

/**
 * @param {{ config: object, db: object, logger?: boolean }} deps
 */
export async function createServer({ config, db, logger }) {
  const server = Fastify({
    logger: logger === false ? false : { level: config.logLevel },
    // The Hub is a JSON API. Fastify's default 1 MiB body cap is replaced by the
    // configured message ceiling so the limit is one number, declared in one place.
    bodyLimit: config.limits.maxMessageBytes,
    // Never trust a client-supplied request id as an audit fact; generate our own.
    genReqId: () => globalThis.crypto.randomUUID(),
    // `false` unless an operator names a reverse proxy. A Hub reached directly must not believe a
    // forwarding header: `request.ip` feeds the per-source throttle key, so a spoofable source is a
    // throttle an attacker can reset at will.
    trustProxy: config.security.trustedProxies ?? false,
  })

  // The authenticator is part of the hub decoration so every route module reads the same
  // one instead of constructing its own.
  const requireAuth = makeRequireAuth({ config, db })
  // One login limiter for the process, shared by every attempt. Built here rather than in the
  // route module so a second identity route cannot accidentally get a second, empty counter.
  //
  // Persisted rather than in-memory: a restart used to clear every counter, which handed an
  // attacker a one-deploy reprieve from any lockout they had earned. Registration is counted by a
  // second instance with the same rule, because until now the route that mints identities was the
  // only one with no ceiling at all.
  const loginLimiter = new PersistentLimiter({
    db,
    maxAttempts: config.security.loginMaxAttempts,
    windowSeconds: config.security.loginWindowSeconds,
    lockoutSeconds: config.security.loginLockoutSeconds,
  })
  const registerLimiter = new PersistentLimiter({
    db,
    maxAttempts: config.security.loginMaxAttempts,
    windowSeconds: config.security.loginWindowSeconds,
    lockoutSeconds: config.security.loginLockoutSeconds,
  })
  // The remaining write endpoints, each in its own namespace so their budgets do not interfere: a
  // room busy enough to trip the message limit must not also refuse its members' logins. Separate
  // instances rather than shared keys, because the limits differ — a heartbeat is emitted on a timer
  // by the owner's runtime while a message is typed by a person, so one ceiling cannot serve both
  // without being either too strict for typing or too loose for a flood.
  const heartbeatLimiter = new PersistentLimiter({
    db,
    maxAttempts: config.security.heartbeatMaxAttempts ?? config.security.loginMaxAttempts * 4,
    windowSeconds: config.security.loginWindowSeconds,
    lockoutSeconds: config.security.loginLockoutSeconds,
  })
  // The dispatch signing key set. Built once at startup so a malformed key stops the Hub here
  // rather than at the first dispatch, and so the public half can be published without touching the
  // private one again. Absent means "refuse every dispatch", which `consumeGrant` enforces.
  const signing = createSigningKeySet({
    privateKey: config.signing?.grant?.privateKey,
    keyId: config.signing?.grant?.keyId,
    previous: config.signing?.grant?.previous,
  })
  const messageLimiter = new PersistentLimiter({
    db,
    maxAttempts: config.security.messageMaxAttempts ?? config.security.loginMaxAttempts * 5,
    windowSeconds: config.security.loginWindowSeconds,
    lockoutSeconds: config.security.loginLockoutSeconds,
  })
  // The realtime hub authenticates a socket with the same function the HTTP routes use, so
  // an upgrade cannot be a weaker door than a request.
  const realtime = new RealtimeHub({
    db,
    config,
    authenticate: makeAuthenticator({ config, db }),
    log: server.log,
  })
  server.decorate('hub', { config, db, version: hubVersion(), requireAuth, realtime, loginLimiter, registerLimiter, heartbeatLimiter, messageLimiter, signing })

  server.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    else request.log.warn({ err: error }, 'request rejected')
    // Messages from our own validation errors are safe to return; anything unexpected
    // returns a stable code so internal details never reach the caller.
    const code = error.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST')
    const message = status >= 500 ? 'The Hub could not process the request' : error.message
    reply.code(status).send({ error: { code, message } })
  })

  server.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No Hub route for ${request.method} ${request.url}` } })
  })

  // The decorator is declared once, before any plugin can read `request.auth`.
  server.decorateRequest('auth', null)
  // WebSocket support is registered before the route that declares the websocket handler.
  await server.register(fastifyWebsocket)
  for (const plugin of buildRoutePlugins({ requireAuth })) await server.register(plugin)
  // `/api/v1/realtime` is a route on the root instance, not a plugin: it needs the hub the
  // handler below closes over, and keeping it beside the health routes makes the socket
  // surface visible in one place.
  registerRealtimeRoute({ fastify: server, hub: realtime })

  server.get('/api/v1/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    service: 'workgroup-ai-hub',
    version: hubVersion(),
    protocol: protocolVersion,
    uptimeSeconds: Math.round(process.uptime()),
  }))

  server.get('/api/v1/health/ready', async (request, reply) => {
    // Every readiness fact is gathered inside one guard: a Hub whose database handle
    // died must answer 503, not 500, so an orchestrator restarts it instead of treating
    // the probe itself as broken.
    const checks = {}
    let ready = true
    try {
      checks.database = probeWritable(db)
      let startedAt = readMeta(db, STARTED_AT_KEY)
      if (startedAt === undefined) {
        startedAt = new Date().toISOString()
        writeMeta(db, STARTED_AT_KEY, startedAt)
      }
      checks.startedAt = startedAt
      checks.journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode
    } catch (error) {
      ready = false
      checks.database = checks.database ?? {}
      checks.database.error = error.message
      request.log.error({ err: error }, 'readiness probe failed')
    }
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready', checks })
  })

  return server
}

export async function startHub({ config, db, logger }) {
  const server = await createServer({ config, db, logger })
  const tls = loadTlsOptions(config)
  await server.listen({ host: config.host, port: config.port, ...(tls === undefined ? {} : { https: tls }) })
  // The heartbeat only runs while the server is actually listening.
  server.hub.realtime.start()
  const closeServer = server.close.bind(server)
  server.close = async (...args) => {
    server.hub.realtime.stop()
    return closeServer(...args)
  }
  return server
}
