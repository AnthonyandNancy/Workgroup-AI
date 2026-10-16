// Dispatch grant routes.
//
// Three endpoints, each with one job:
//
//   POST /tasks/{taskId}/grant          the owner's own device mints one grant
//   POST /dispatch/consume              a local executor presents a grant to start work
//   GET  /tasks/{taskId}/grants         the owner inspects what has been handed out
//
// The mint route takes the owner from the authenticated session, never from the body: a
// grant is the owner's own authority, so there is no parameter that could name somebody else.

import {
  GrantError, mintGrant, consumeGrant, revokeGrantsForTask, listGrantsForTask, publicGrant,
} from '../modules/tasks/grants.js'
import { findTask } from '../modules/tasks/store.js'
import { RoomError, requireMember } from '../modules/rooms/store.js'
import { makeEvent } from '../realtime/events.js'
import { verifyGrantSignature } from '../modules/tasks/signing.js'

function grantFailure(reply, error) {
  if (error instanceof GrantError) {
    switch (error.code) {
      case 'NO_SUCH_TASK':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      case 'NOT_TASK_OWNER':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'NO_APPROVAL':
      case 'APPROVAL_EXPIRED':
      case 'GRANT_EXPIRED':
        // The approval is gone or lapsed: the executor must ask again, not retry.
        return reply.code(410).send({ error: { code: error.code, message: error.message } })
      case 'TASK_NOT_DISPATCHABLE':
      case 'TASK_TERMINAL':
      case 'GRANT_REVOKED':
      case 'GRANT_ALREADY_USED':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      // A bad or missing signature is a 403: the caller is authenticated, but the grant it
      // presented is not one this Hub issued. Distinct from the 409s, which mean the grant was
      // genuine and is no longer usable.
      case 'BAD_SIGNATURE':
      case 'SIGNING_UNAVAILABLE':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'UNKNOWN_GRANT':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  throw error
}

export function makeGrantRoutes({ requireAuth }) {
  return async function grantRoutes(fastify) {
    const { db } = fastify.hub

    /** Mint one grant. Only the task owner's live device may do this. */
    fastify.post('/api/v1/tasks/:taskId/grant', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const minted = mintGrant(db, {
          taskId: request.params.taskId,
          ownerUserId: request.auth.user.id,
          ownerDeviceId: request.auth.deviceId,
          botId: body.botId,
          ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: Number(body.ttlSeconds) }),
          // The signer comes from the process, never from the request: a caller that could supply
          // its own signer could mint a grant the Hub never issued.
          signer: fastify.hub.signing?.signer,
        })
        // The nonce is returned exactly once and never stored in readable form. The signature is
        // returned with it: the executor presents both, and neither alone is enough.
        return reply.code(201).send({
          grant: {
            id: minted.grantId, taskId: minted.taskId, botId: minted.botId, expiresAt: minted.expiresAt,
            nonce: minted.nonce, signature: minted.signature, keyId: minted.keyId,
          },
        })
      } catch (error) {
        return grantFailure(reply, error)
      }
    })

    /**
     * The public keys a dispatch signature may be verified against.
     *
     * Reachable to any authenticated user, and deliberately publishing only public halves: the
     * verifying machine is not the Hub and may never have talked to it before, so it needs a way to
     * learn the key without holding anything secret. The private key is never returned by any route.
     */
    fastify.get('/api/v1/dispatch/keys', { preHandler: requireAuth }, async () => ({
      keys: Object.fromEntries(fastify.hub.signing?.publicKeys ?? new Map()),
      currentKeyId: fastify.hub.signing?.keyId ?? null,
    }))

    /**
     * Present a grant to start work.
     *
     * The device is taken from the authenticated session, so a grant stolen from one machine
     * cannot be presented from another. The response names the approved scope, which is what
     * the executor must enforce locally — the Hub's consumption is a record, not an
     * enforcement of the scope itself.
     */
    fastify.post('/api/v1/dispatch/consume', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const result = consumeGrant(db, {
          nonce: body.nonce,
          taskId: body.taskId,
          deviceId: request.auth.deviceId,
          signature: body.signature,
          keyId: body.keyId,
          // Built from the process's key set, so the verification uses keys the Hub itself
          // published rather than anything the request carried.
          verifier: ({ payload, signature, keyId }) => verifyGrantSignature(
            { payload, signature, keyId },
            { keys: fastify.hub.signing?.publicKeys ?? new Map() },
          ),
        })
        const task = findTask(db, result.grant.task_id)
        fastify.hub.realtime.publishToRoom(task.room_id, makeEvent('task.progress', {
          taskId: task.id,
          state: task.state,
          // Progress is room-visible; the scope is not repeated here.
          stage: 'dispatched',
        }, { roomId: task.room_id }))
        return reply.code(200).send({
          taskId: task.id,
          botId: result.grant.bot_id ?? null,
          issuedAt: result.grant.issued_at,
          scope: result.scope,
        })
      } catch (error) {
        return grantFailure(reply, error)
      }
    })

    /** What the owner has handed out for one task, without any usable nonce. */
    fastify.get('/api/v1/tasks/:taskId/grants', { preHandler: requireAuth }, async (request, reply) => {
      const task = findTask(db, request.params.taskId)
      if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
      const isOwner = task.owner_user_id === request.auth.user.id
      try {
        requireMember(db, { roomId: task.room_id, userId: request.auth.user.id })
      } catch (error) {
        if (error instanceof RoomError) {
          return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
        }
        throw error
      }
      // Only the owner sees grants: the fact that a grant was minted is about the owner's
      // machine, not about the room's business.
      if (!isOwner) return reply.code(403).send({ error: { code: 'NOT_TASK_OWNER', message: 'Only the task owner may inspect its grants' } })
      return reply.code(200).send({ grants: listGrantsForTask(db, task.id).map(publicGrant) })
    })

    /** Revoke every outstanding grant for a task. The owner or a room admin may do it. */
    fastify.post('/api/v1/tasks/:taskId/grants/revoke', { preHandler: requireAuth }, async (request, reply) => {
      const task = findTask(db, request.params.taskId)
      if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
      const isOwner = task.owner_user_id === request.auth.user.id
      let isAdmin = false
      try {
        const membership = requireMember(db, { roomId: task.room_id, userId: request.auth.user.id })
        isAdmin = membership.role === 'owner' || membership.role === 'admin'
      } catch (error) {
        if (!(error instanceof RoomError)) throw error
      }
      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ error: { code: 'NOT_ALLOWED', message: 'Only the task owner or a room admin may revoke its grants' } })
      }
      const revoked = revokeGrantsForTask(db, { taskId: task.id })
      fastify.hub.realtime.publishToRoom(task.room_id, makeEvent('task.cancelled', { taskId: task.id, state: task.state, revokedGrants: revoked }, { roomId: task.room_id }))
      return reply.code(200).send({ revoked })
    })
  }
}
