// Group memory routes.
//
// The authorization shape:
//
//  * Every route resolves the caller's membership of the entry's room first, through the store.
//    A non-member is answered as if the entry did not exist, matching the room and message
//    routes, so a guessed id cannot be confirmed.
//  * `readMemory` applies the entry's own scope on top of membership. A removed member fails the
//    membership check even for a room-scoped entry, so an old token cannot read a room's memory.
//  * Only the author may correct an entry; the author or a room admin may delete it. An admin
//    deletion is recorded as an admin action, not disguised as the author's.
//
// The store does the work; these handlers translate shapes.

import {
  MemoryError,
  createMemory, findMemory, listMemories, searchMemories, readMemory, listRevisions,
  reviseMemory, deleteMemory, publicMemory, publicRevision,
} from '../modules/memory/store.js'
import { RoomError } from '../modules/rooms/store.js'
import { makeEvent } from '../realtime/events.js'

function memoryFailure(reply, error) {
  if (error instanceof RoomError) {
    // Same rule as the other room-scoped routes: a non-member cannot confirm a room exists.
    return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
  }
  if (error instanceof MemoryError) {
    switch (error.code) {
      case 'NO_SUCH_MEMORY':
      case 'NO_SUCH_SOURCE':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      case 'NOT_THE_AUTHOR':
      case 'NOT_ALLOWED_TO_DELETE':
      case 'SOURCE_IN_ANOTHER_ROOM':
        // The caller named the entry, so hiding it would only confuse a legitimate client.
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'REVISION_CONFLICT':
      case 'MEMORY_DELETED':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  throw error
}

/** Tell the room's sockets that its memory changed. The body is not pushed: it may be scoped. */
function publishMemoryChange(fastify, roomId, reason, memoryId) {
  fastify.hub.realtime.publishToRoom(roomId, makeEvent('group_memory.changed', { roomId, reason, memoryId }, { roomId }))
}

export function makeMemoryRoutes({ requireAuth }) {
  return async function memoryRoutes(fastify) {
    const { db, config } = fastify.hub

    /** Remember something. The author is the caller; there is no parameter that names someone else. */
    fastify.post('/api/v1/rooms/:roomId/memories', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const memory = createMemory(db, {
          roomId: request.params.roomId,
          authorUserId: request.auth.user.id,
          authorDeviceId: request.auth.deviceId,
          body: body.body,
          sourceMessageId: body.sourceMessageId,
          scope: body.scope,
          expiresAt: body.expiresAt ?? null,
          // The ceiling is operator policy, so it comes from configuration rather than from the
          // request: a caller must not be able to raise its own room's limit.
          maxPerRoom: config.limits.maxMemoriesPerRoom,
        })
        publishMemoryChange(fastify, request.params.roomId, 'created', memory.id)
        return reply.code(201).send({ memory: publicMemory(memory) })
      } catch (error) {
        return memoryFailure(reply, error)
      }
    })

    /** The room's memory, as the caller may read it. */
    fastify.get('/api/v1/rooms/:roomId/memories', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      try {
        const memories = listMemories(db, {
          roomId: request.params.roomId,
          viewerUserId: request.auth.user.id,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        })
        return reply.code(200).send({ memories: memories.map(row => publicMemory(row)) })
      } catch (error) {
        return memoryFailure(reply, error)
      }
    })

    /**
     * Search the room's memory.
     *
     * A `q` that matches nothing readable returns an empty list, not a refusal: "no results" and
     * "not allowed" are different answers, and only the second should sound like a boundary.
     */
    fastify.get('/api/v1/rooms/:roomId/memories/search', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      try {
        const memories = searchMemories(db, {
          roomId: request.params.roomId,
          viewerUserId: request.auth.user.id,
          query: typeof query.q === 'string' ? query.q : '',
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        })
        return reply.code(200).send({ memories: memories.map(row => publicMemory(row)) })
      } catch (error) {
        return memoryFailure(reply, error)
      }
    })

    /** One entry with its correction trail. */
    fastify.get('/api/v1/memories/:memoryId', { preHandler: requireAuth }, async (request, reply) => {
      const memory = readMemory(db, { memoryId: request.params.memoryId, viewerUserId: request.auth.user.id })
      // An entry the caller may not read is answered as missing, so its existence is not
      // confirmed either way.
      if (memory === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_MEMORY', message: 'No such memory' } })
      const revisions = listRevisions(db, { memoryId: memory.id, viewerUserId: request.auth.user.id }) ?? []
      return reply.code(200).send({
        memory: publicMemory(memory),
        revisions: revisions.map(publicRevision),
      })
    })

    fastify.patch('/api/v1/memories/:memoryId', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const memory = reviseMemory(db, {
          memoryId: request.params.memoryId,
          editorUserId: request.auth.user.id,
          editorDeviceId: request.auth.deviceId,
          body: body.body,
          expectedRevision: body.expectedRevision,
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        })
        publishMemoryChange(fastify, memory.room_id, 'revised', memory.id)
        return reply.code(200).send({ memory: publicMemory(memory) })
      } catch (error) {
        return memoryFailure(reply, error)
      }
    })

    fastify.delete('/api/v1/memories/:memoryId', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const memory = deleteMemory(db, {
          memoryId: request.params.memoryId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        publishMemoryChange(fastify, memory.room_id, 'deleted', memory.id)
        return reply.code(200).send({ memory: publicMemory(memory) })
      } catch (error) {
        return memoryFailure(reply, error)
      }
    })

    /**
     * The correction trail alone.
     *
     * Kept as its own route because an auditor asks "what changed here" without needing the
     * current body, and because a deleted entry's trail is the record that a deletion happened.
     */
    fastify.get('/api/v1/memories/:memoryId/revisions', { preHandler: requireAuth }, async (request, reply) => {
      const memory = findMemory(db, request.params.memoryId)
      if (memory === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_MEMORY', message: 'No such memory' } })
      // A deleted entry's trail stays readable to a current member, which is the point of keeping
      // it: the group can see that something was removed and by whom.
      const membership = db.prepare('SELECT 1 AS yes FROM room_members WHERE room_id = ? AND user_id = ? AND removed_at IS NULL')
        .get(memory.room_id, request.auth.user.id)
      if (membership === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_MEMORY', message: 'No such memory' } })
      const revisions = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision').all(memory.id)
      return reply.code(200).send({ revisions: revisions.map(publicRevision) })
    })
  }
}
