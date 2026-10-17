// Local-demo Hub operator API.
//
// This is deliberately a small surface: user reads, workgroup CRUD, member add/remove, and a
// read-only message view. It does not expose user CRUD, device management, role changes, ordinary
// rooms, or physical deletion. Every workgroup path starts from `kind='workgroup'` in the store.

import { assertSameOrigin } from '../admin/auth.js'
import {
  AdminError,
  addMember,
  createWorkgroup,
  dissolveWorkgroup,
  findAdminWorkgroup,
  listMessages,
  listUsers,
  listWorkgroups,
  removeMemberAsOperator,
  renameWorkgroup,
  writeOperatorAudit,
} from '../admin/store.js'
import { RoomError } from '../modules/rooms/store.js'
import { makeEvent } from '../realtime/events.js'

function adminFailure(reply, error) {
  if (error instanceof AdminError) {
    const status = error.code === 'NO_SUCH_WORKGROUP'
      ? 404
      : error.code === 'ALREADY_A_MEMBER' || error.code === 'WORKGROUP_DISSOLVED'
        ? 409
        : 400
    return reply.code(status).send({ error: { code: error.code, message: error.message } })
  }
  if (error instanceof RoomError) {
    const status = error.code === 'NOT_A_MEMBER' || error.code === 'NO_SUCH_ROOM'
      ? 404
      : error.code === 'CANNOT_REMOVE_OWNER' || error.code === 'ROOM_DISSOLVED'
        ? 409
        : 400
    return reply.code(status).send({ error: { code: error.code, message: error.message } })
  }
  throw error
}

function limitOf(value, fallback = 50) {
  if (value === undefined) return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? Math.min(number, 100) : undefined
}

function beforeSeqOf(value) {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : undefined
}

export function makeAdminRoutes({ adminAuth, requireOperator }) {
  return async function adminRoutes(fastify) {
    const { db, realtime } = fastify.hub

    fastify.post('/api/v1/admin/login', async (request, reply) => {
      if (!assertSameOrigin(request)) {
        return reply.code(403).send({ error: { code: 'CROSS_ORIGIN_REFUSED', message: 'Cross-origin administrator login is not allowed' } })
      }
      const key = `admin-login:${request.ip}`
      const verdict = fastify.hub.adminLoginLimiter.check(key)
      if (!verdict.allowed) {
        reply.header('retry-after', String(verdict.retryAfterSeconds))
        return reply.code(429).send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many administrator login attempts' } })
      }
      const result = await adminAuth.login(request.body ?? {})
      if (result === undefined) {
        fastify.hub.adminLoginLimiter.recordFailure(key)
        return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid administrator credentials' } })
      }
      fastify.hub.adminLoginLimiter.clear(key)
      reply.header('set-cookie', adminAuth.cookie(result.sessionId))
      return reply.code(200).send({ operator: result.operator })
    })

    fastify.get('/api/v1/admin/session', { preHandler: requireOperator }, async (request) => ({
      operator: request.operator,
    }))

    fastify.post('/api/v1/admin/logout', { preHandler: requireOperator }, async (request, reply) => {
      adminAuth.logout(request.adminSessionId)
      reply.header('set-cookie', adminAuth.clearCookie())
      return reply.code(200).send({ ok: true })
    })

    fastify.get('/api/v1/admin/users', { preHandler: requireOperator }, async (request, reply) => {
      const limit = limitOf(request.query?.limit)
      if (limit === undefined) return reply.code(400).send({ error: { code: 'INVALID_LIMIT', message: 'limit must be a positive integer' } })
      return reply.code(200).send({
        users: listUsers(db, {
          query: typeof request.query?.query === 'string' ? request.query.query : '',
          limit,
        }),
      })
    })

    fastify.get('/api/v1/admin/workgroups', { preHandler: requireOperator }, async (request, reply) => {
      const limit = limitOf(request.query?.limit)
      if (limit === undefined) return reply.code(400).send({ error: { code: 'INVALID_LIMIT', message: 'limit must be a positive integer' } })
      const status = request.query?.status
      if (status !== undefined && !['live', 'dissolved', 'all'].includes(status)) {
        return reply.code(400).send({ error: { code: 'INVALID_STATUS', message: 'status must be live, dissolved, or all' } })
      }
      return reply.code(200).send({
        workgroups: listWorkgroups(db, {
          query: typeof request.query?.query === 'string' ? request.query.query : '',
          status: status ?? 'live',
          limit,
        }),
      })
    })

    fastify.post('/api/v1/admin/workgroups', { preHandler: requireOperator }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const created = createWorkgroup(db, {
          name: body.name,
          ownerUserId: body.ownerUserId,
          operatorId: request.operator.id,
        })
        return reply.code(201).send({ workgroup: findAdminWorkgroup(db, created.id) })
      } catch (error) {
        return adminFailure(reply, error)
      }
    })

    fastify.get('/api/v1/admin/workgroups/:id', { preHandler: requireOperator }, async (request, reply) => {
      const workgroup = findAdminWorkgroup(db, request.params.id)
      if (workgroup === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_WORKGROUP', message: 'No such workgroup' } })
      return reply.code(200).send({ workgroup })
    })

    fastify.patch('/api/v1/admin/workgroups/:id', { preHandler: requireOperator }, async (request, reply) => {
      try {
        const room = renameWorkgroup(db, {
          workgroupId: request.params.id,
          name: request.body?.name,
          operatorId: request.operator.id,
        })
        const workgroup = findAdminWorkgroup(db, room.id)
        realtime.publishToRoom(room.id, makeEvent('room.renamed', {
          roomId: room.id,
          name: room.name,
        }, { roomId: room.id }))
        return reply.code(200).send({ workgroup })
      } catch (error) {
        return adminFailure(reply, error)
      }
    })

    fastify.delete('/api/v1/admin/workgroups/:id', { preHandler: requireOperator }, async (request, reply) => {
      try {
        const result = dissolveWorkgroup(db, {
          workgroupId: request.params.id,
          operatorId: request.operator.id,
        })
        realtime.publishToRoom(result.roomId, makeEvent('room.dissolved', {
          roomId: result.roomId,
          dissolvedBy: null,
          pendingTasks: result.pendingTaskIds.length,
        }, { roomId: result.roomId }))
        return reply.code(200).send({ workgroup: findAdminWorkgroup(db, result.roomId) })
      } catch (error) {
        return adminFailure(reply, error)
      }
    })

    fastify.post('/api/v1/admin/workgroups/:id/members', { preHandler: requireOperator }, async (request, reply) => {
      try {
        addMember(db, {
          workgroupId: request.params.id,
          userId: request.body?.userId,
          operatorId: request.operator.id,
        })
        realtime.publishToRoom(request.params.id, makeEvent('member.changed', {
          roomId: request.params.id,
          reason: 'added',
        }, { roomId: request.params.id }))
        return reply.code(201).send({ workgroup: findAdminWorkgroup(db, request.params.id) })
      } catch (error) {
        return adminFailure(reply, error)
      }
    })

    fastify.delete('/api/v1/admin/workgroups/:id/members/:userId', { preHandler: requireOperator }, async (request, reply) => {
      try {
        removeMemberAsOperator(db, {
          workgroupId: request.params.id,
          userId: request.params.userId,
          operatorId: request.operator.id,
        })
        realtime.publishToRoom(request.params.id, makeEvent('member.changed', {
          roomId: request.params.id,
          reason: 'removed',
        }, { roomId: request.params.id }))
        return reply.code(200).send({ workgroup: findAdminWorkgroup(db, request.params.id) })
      } catch (error) {
        return adminFailure(reply, error)
      }
    })

    fastify.get('/api/v1/admin/workgroups/:id/messages', { preHandler: requireOperator }, async (request, reply) => {
      const beforeSeq = beforeSeqOf(request.query?.beforeSeq)
      if (request.query?.beforeSeq !== undefined && beforeSeq === undefined) {
        return reply.code(400).send({ error: { code: 'INVALID_CURSOR', message: 'beforeSeq must be a positive integer' } })
      }
      const limit = limitOf(request.query?.limit, 50)
      if (limit === undefined) return reply.code(400).send({ error: { code: 'INVALID_LIMIT', message: 'limit must be a positive integer' } })
      try {
        const page = listMessages(db, { workgroupId: request.params.id, beforeSeq, limit })
        writeOperatorAudit(db, {
          operatorId: request.operator.id,
          eventType: 'admin.workgroup_messages_viewed',
          objectType: 'room',
          objectId: request.params.id,
          details: { beforeSeq: beforeSeq ?? null, count: page.messages.length },
        })
        return reply.code(200).send(page)
      } catch (error) {
        return adminFailure(reply, error)
      }
    })
  }
}
