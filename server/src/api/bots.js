// Bot directory routes.
//
// The authorization shape:
//
//  * Write routes (`publish`, `withdraw`, `heartbeat`) always act on the **authenticated
//    owner's own** entries. There is no route that takes an owner id from the body, so a
//    user cannot publish on another's behalf even by guessing.
//  * The browse route returns only entries visible to the caller, filtered in the store.
//    A private entry is invisible to everyone but its owner, and a `room`-scoped one only to
//    someone who shares a room with the owner.
//  * Resolving one entry re-checks visibility instead of trusting a prior listing, so a
//    visibility narrowed between two requests takes effect on the second.

import {
  DirectoryError,
  publishEntry, withdrawEntry, heartbeat, browseDirectory, listOwnWithPresence,
  findEntry, isVisibleTo, publicEntry,
} from '../modules/bots/store.js'
import { heartbeatKeys } from '../security/ratelimit-store.js'

function directoryFailure(reply, error) {
  if (error instanceof DirectoryError) {
    const status = error.code === 'NO_SUCH_ENTRY' ? 404 : 400
    return reply.code(status).send({ error: { code: error.code, message: error.message } })
  }
  throw error
}

export function makeBotRoutes({ requireAuth }) {
  return async function botRoutes(fastify) {
    const { db } = fastify.hub

    /** The caller's own Bots, private ones included: this is the owner's management view. */
    fastify.get('/api/v1/bots', { preHandler: requireAuth }, async (request) => ({
      bots: listOwnWithPresence(db, request.auth.user.id).map(row => publicEntry(row)),
    }))

    fastify.post('/api/v1/bots', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const entry = publishEntry(db, {
          ownerUserId: request.auth.user.id,
          ownerDeviceId: request.auth.deviceId,
          botId: body.botId,
          displayName: body.displayName,
          visibility: body.visibility ?? 'private',
        })
        return reply.code(201).send({ bot: publicEntry(entry) })
      } catch (error) {
        return directoryFailure(reply, error)
      }
    })

    fastify.post('/api/v1/bots/:botId/withdraw', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const entry = withdrawEntry(db, {
          ownerUserId: request.auth.user.id,
          ownerDeviceId: request.auth.deviceId,
          botId: request.params.botId,
        })
        return reply.code(200).send({ bot: publicEntry(entry) })
      } catch (error) {
        return directoryFailure(reply, error)
      }
    })

    /**
     * Presence heartbeat from the owner's client.
     *
     * A Bot is reachable only while its owner's runtime is running, and only the client knows
     * that; so this is a report, and the Hub derives "online" from how fresh it is.
     */
    fastify.post('/api/v1/bots/:botId/heartbeat', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      // A heartbeat writes to the directory on every call, so it is counted before the write. Every
      // call is counted, not only failures: here the heartbeat *is* the load, and a rule that counted
      // only failures would have nothing to count, since a heartbeat has no failure path of its own.
      const keys = heartbeatKeys({ botId: request.params.botId, source: request.ip })
      for (const key of keys) {
        const verdict = fastify.hub.heartbeatLimiter.check(key)
        if (!verdict.allowed) {
          reply.header('retry-after', String(verdict.retryAfterSeconds))
          return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many heartbeats from this source.', retryAfterSeconds: verdict.retryAfterSeconds } })
        }
      }
      for (const key of keys) fastify.hub.heartbeatLimiter.recordFailure(key)
      try {
        const entry = heartbeat(db, {
          ownerUserId: request.auth.user.id,
          botId: request.params.botId,
          state: body.state,
        })
        return reply.code(200).send({ bot: publicEntry(entry) })
      } catch (error) {
        return directoryFailure(reply, error)
      }
    })

    /**
     * Browse Bots a colleague has published.
     *
     * `ownerUserId` narrows to one person's directory, which is what a workgroup invite flow
     * needs: "show me the Bots belonging to the person I am about to ask".
     */
    fastify.get('/api/v1/bots/directory', { preHandler: requireAuth }, async (request) => {
      const query = request.query ?? {}
      const rows = browseDirectory(db, {
        viewerUserId: request.auth.user.id,
        ownerUserId: typeof query.ownerUserId === 'string' && query.ownerUserId.length > 0 ? query.ownerUserId : undefined,
        query: typeof query.q === 'string' && query.q.length > 0 ? query.q : undefined,
      })
      return { bots: rows.map(row => publicEntry(row, { includeOwner: true })) }
    })

    fastify.get('/api/v1/bots/directory/:ownerUserId/:botId', { preHandler: requireAuth }, async (request, reply) => {
      const { ownerUserId, botId } = request.params
      const entry = findEntry(db, { ownerUserId, botId })
      // An entry the caller may not see is answered as missing, so the directory cannot be
      // used to confirm that a private Bot exists.
      if (entry === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_BOT', message: 'No such Bot in the directory' } })
      if (!isVisibleTo(db, { ownerUserId, botId, viewerUserId: request.auth.user.id })) {
        return reply.code(404).send({ error: { code: 'NO_SUCH_BOT', message: 'No such Bot in the directory' } })
      }
      const owner = db.prepare('SELECT user_handle, display_name FROM users WHERE id = ?').get(ownerUserId)
      return reply.code(200).send({
        bot: publicEntry({ ...entry, owner_handle: owner?.user_handle, owner_display_name: owner?.display_name }, { includeOwner: true }),
      })
    })
  }
}
