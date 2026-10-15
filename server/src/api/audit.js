// Audit routes.
//
// Who may read the audit trail is the question these routes answer. The trail covers every user's
// actions, so it is not group data and membership does not grant it: reading it is an operator
// capability. V1 has no separate operator role, so the rule is the same one that guards the most
// sensitive shared state — the caller must be authenticated, and the trail is scoped to what the
// Hub already stores rather than to a new privilege level:
//
//   * a caller may always read **their own** events, which is what "what did I do" needs;
//   * `actorUserId` for anybody else is refused, because the Hub has no role that would justify it;
//   * object-scoped reads are allowed only for objects in a room the caller is a member of, so the
//     trail of a room's tasks is room data.
//
// That is deliberately narrower than a full admin API. Adding an operator role is a product
// decision with its own audit implications, and it is not invented here.

import {
  AuditError,
  listAuditEvents, countAuditEvents, auditEventTypes, findAuditEvent,
  listRetentionRuns, publicAuditEvent,
} from '../modules/audit/store.js'
import { membershipOf } from '../modules/rooms/store.js'

function auditFailure(reply, error) {
  if (error instanceof AuditError) return reply.code(400).send({ error: { code: error.code, message: error.message } })
  throw error
}

/**
 * Whether this caller may read events about this object.
 *
 * An object the caller has no relationship with is answered as missing rather than forbidden, so
 * the trail cannot be used to confirm that a room, task, or memory exists.
 */
function mayReadObject(db, request, objectType, objectId) {
  if (objectType === 'room') return membershipOf(db, { roomId: objectId, userId: request.auth.user.id }) !== undefined
  if (objectType === 'message') {
    const message = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(objectId)
    return message !== undefined && membershipOf(db, { roomId: message.room_id, userId: request.auth.user.id }) !== undefined
  }
  if (objectType === 'task') {
    const task = db.prepare('SELECT room_id FROM tasks WHERE id = ?').get(objectId)
    return task !== undefined && membershipOf(db, { roomId: task.room_id, userId: request.auth.user.id }) !== undefined
  }
  if (objectType === 'group_memory') {
    const memory = db.prepare('SELECT room_id FROM group_memories WHERE id = ?').get(objectId)
    return memory !== undefined && membershipOf(db, { roomId: memory.room_id, userId: request.auth.user.id }) !== undefined
  }
  if (objectType === 'artifact') {
    const artifact = db.prepare('SELECT room_id FROM artifacts WHERE id = ?').get(objectId)
    return artifact !== undefined && membershipOf(db, { roomId: artifact.room_id, userId: request.auth.user.id }) !== undefined
  }
  // An object type this route does not know cannot be authorized, so it is refused.
  return false
}

export function makeAuditRoutes({ requireAuth }) {
  return async function auditRoutes(fastify) {
    const { db } = fastify.hub

    /**
     * The caller's own trail, or one object's.
     *
     * Filtering by another user's id is refused: the Hub has no operator role, and pretending a
     * query parameter is one would be an authorization rule invented by a client.
     */
    fastify.get('/api/v1/audit', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      if (typeof query.actorUserId === 'string' && query.actorUserId.length > 0 && query.actorUserId !== request.auth.user.id) {
        return reply.code(403).send({
          error: { code: 'NOT_YOUR_TRAIL', message: 'This Hub has no operator role; you may read your own audit events' },
        })
      }
      const objectType = typeof query.objectType === 'string' && query.objectType.length > 0 ? query.objectType : undefined
      const objectId = typeof query.objectId === 'string' && query.objectId.length > 0 ? query.objectId : undefined
      if (objectType !== undefined && objectId !== undefined && !mayReadObject(db, request, objectType, objectId)) {
        // Answered as an empty page rather than a refusal: the caller learns nothing about whether
        // that object exists, and an operator comparing two rooms sees the same shape either way.
        return reply.code(200).send({ events: [], total: 0 })
      }
      try {
        const filters = {
          // Without an explicit object filter, a caller sees only their own events.
          actorUserId: objectId === undefined ? request.auth.user.id : undefined,
          ...(objectType === undefined ? {} : { objectType }),
          ...(objectId === undefined ? {} : { objectId }),
          ...(typeof query.outcome === 'string' && query.outcome.length > 0 ? { outcome: query.outcome } : {}),
          ...(typeof query.eventType === 'string' && query.eventType.length > 0 ? { eventType: query.eventType } : {}),
          ...(typeof query.since === 'string' && query.since.length > 0 ? { since: query.since } : {}),
          ...(typeof query.until === 'string' && query.until.length > 0 ? { until: query.until } : {}),
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }
        return reply.code(200).send({
          events: listAuditEvents(db, filters).map(publicAuditEvent),
          total: countAuditEvents(db, filters),
        })
      } catch (error) {
        return auditFailure(reply, error)
      }
    })

    /** The event types this Hub has written, so a caller can build a query. */
    fastify.get('/api/v1/audit/types', { preHandler: requireAuth }, async () => ({ types: auditEventTypes(db) }))

    /**
     * One event by id.
     *
     * Reading a single event is allowed when it is the caller's own or about an object they can
     * reach; anything else is answered as missing.
     */
    fastify.get('/api/v1/audit/:eventId', { preHandler: requireAuth }, async (request, reply) => {
      const event = findAuditEvent(db, request.params.eventId)
      if (event === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_EVENT', message: 'No such audit event' } })
      const isOwn = event.actor_user_id === request.auth.user.id
      const reachable = event.object_type !== undefined && event.object_id !== null && event.object_id !== undefined
        && mayReadObject(db, request, event.object_type, event.object_id)
      if (!isOwn && !reachable) {
        return reply.code(404).send({ error: { code: 'NO_SUCH_EVENT', message: 'No such audit event' } })
      }
      return reply.code(200).send({ event: publicAuditEvent(event) })
    })

    /** What previous retention runs did. Recorded decisions, not a silent sweep. */
    fastify.get('/api/v1/audit/retention/runs', { preHandler: requireAuth }, async (request) => {
      const query = request.query ?? {}
      return {
        runs: listRetentionRuns(db, query.limit === undefined ? undefined : Number(query.limit)),
        auditRetentionDays: fastify.hub.config.retention.auditRetentionDays,
      }
    })
  }
}
