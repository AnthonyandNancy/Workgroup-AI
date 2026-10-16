// Hub room routes: create, list, membership, invitations.
//
// The authorization shape every route here follows:
//
//  * A room-scoped route resolves the caller's membership first. A non-member is answered
//    as if the room did not exist (404), because a 403 would confirm that a guessed room id
//    is real.
//  * A destructive or administrative route additionally requires owner/admin.
//  * An invitation route checks the *recipient*, not merely the invitation id, so holding an
//    id is not authority to accept someone else's offer.
//
// Routes only translate shapes; every rule lives in the store, where the tests can drive it
// without HTTP.

import {
  RoomError, InvitationError,
  createRoom, listRoomsFor, listMembers, findRoom, requireMember, requireRoomAdmin,
  createInvitation, acceptInvitation, declineInvitation, revokeInvitation, findInvitation,
  listInvitationsFor, removeMember, leaveRoom, setMemberRole, renameRoom,
  publicRoom, publicMember, publicInvitation, dissolveRoom,
} from '../modules/rooms/store.js'
import { cancelTask } from '../modules/tasks/store.js'
import { makeEvent } from '../realtime/events.js'

/** Map a domain refusal to a response, keeping the status semantics documented above. */
function roomFailure(reply, error) {
  if (error instanceof RoomError || error instanceof InvitationError) {
    switch (error.code) {
      case 'NOT_A_MEMBER':
        // A non-member must not be able to tell a real room id from an invented one.
        return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
      case 'NO_SUCH_ROOM':
      case 'NO_SUCH_USER':
      case 'NO_SUCH_INVITATION':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      case 'NOT_A_ROOM_ADMIN':
      case 'ROOM_OWNER_REQUIRED':
      case 'NOT_ALLOWED':
      case 'ACCOUNT_DISABLED':
      case 'CANNOT_REMOVE_SELF':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'ALREADY_A_MEMBER':
      case 'CANNOT_REMOVE_OWNER':
      case 'CANNOT_CHANGE_OWNER':
      case 'OWNER_CANNOT_LEAVE':
      case 'INVITATION_NOT_PENDING':
      // A second dissolution is a conflict, not a failure: the room is already in the state the
      // caller asked for, and saying 200 would hide that somebody else got there first.
      case 'ROOM_DISSOLVED':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      case 'INVITATION_EXPIRED':
        return reply.code(410).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  throw error
}

/**
 * Fastify plugin holding the H-04 routes.
 *
 * `requireAuth` is passed in rather than rebuilt here so exactly one authentication rule
 * serves every protected route in the Hub.
 */
export function makeRoomRoutes({ requireAuth }) {
  return async function roomRoutes(fastify) {
    const { db, realtime } = fastify.hub

    /**
     * Members with their momentary connection state.
     *
     * `online` is computed per read from the live socket table rather than stored, because a stored
     * flag would survive a restart and keep claiming somebody is reachable when no socket exists.
     * This runs only after `requireMember` has passed, so presence is never an anonymous read.
     */
    const membersWithPresence = roomId => listMembers(db, roomId)
      .map(member => publicMember({ ...member, online: realtime.isUserOnline(member.user_id) }))

    // ---- rooms ----

    fastify.get('/api/v1/rooms', { preHandler: requireAuth }, async (request) => ({
      rooms: listRoomsFor(db, request.auth.user.id).map(publicRoom),
    }))

    fastify.post('/api/v1/rooms', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const room = createRoom(db, {
          name: body.name,
          kind: body.kind,
          ownerUserId: request.auth.user.id,
          ownerDeviceId: request.auth.deviceId,
        })
        return reply.code(201).send({ room: publicRoom({ ...room, member_role: 'owner' }) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.get('/api/v1/rooms/:roomId', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const room = requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        return reply.code(200).send({
          room: publicRoom({ ...findRoom(db, request.params.roomId), member_role: room.role }),
          members: membersWithPresence(request.params.roomId),
        })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.patch('/api/v1/rooms/:roomId', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        requireRoomAdmin(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const room = renameRoom(db, {
          roomId: request.params.roomId,
          name: body.name,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        return reply.code(200).send({ room: publicRoom(room) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.get('/api/v1/rooms/:roomId/members', { preHandler: requireAuth }, async (request, reply) => {
      try {
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        return reply.code(200).send({ members: membersWithPresence(request.params.roomId) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/rooms/:roomId/members/:userId/remove', { preHandler: requireAuth }, async (request, reply) => {
      try {
        requireRoomAdmin(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const result = removeMember(db, {
          roomId: request.params.roomId,
          userId: request.params.userId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        // The subscription check happens at subscribe time, so an open socket would keep
        // receiving this room's events after the member was removed unless it is revoked here.
        for (const connection of fastify.hub.realtime.connections.values()) {
          if (connection.user.id !== request.params.userId) continue
          if (connection.rooms.has(request.params.roomId)) fastify.hub.realtime.unsubscribe(connection, request.params.roomId)
          fastify.hub.realtime.send(connection, makeEvent('member.changed', { roomId: request.params.roomId, reason: 'removed' }))
        }
        return reply.code(200).send(result)
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/rooms/:roomId/members/:userId/role', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        requireRoomAdmin(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const membership = setMemberRole(db, {
          roomId: request.params.roomId,
          userId: request.params.userId,
          role: body.role,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        return reply.code(200).send({ member: publicMember(membership) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/rooms/:roomId/leave', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const result = leaveRoom(db, {
          roomId: request.params.roomId,
          userId: request.auth.user.id,
          deviceId: request.auth.deviceId,
        })
        return reply.code(200).send(result)
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    /**
     * End a workgroup.
     *
     * Not a `DELETE`, and not spelled like one: the verb is `dissolve` because what happens is a state
     * change that leaves the history readable, and a client author reading `DELETE /rooms/{id}` would
     * reasonably expect the room to be gone afterwards.
     *
     * The announcement goes to the room's current members. A member whose socket is down learns the
     * state from the next read, which is why every read carries `dissolvedAt`.
     */
    fastify.post('/api/v1/rooms/:roomId/dissolve', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const result = dissolveRoom(db, {
          roomId: request.params.roomId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        // Announced rather than implied: an online member must not keep typing into a workgroup that
        // has ended and find out only when their next send is refused.
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('room.dissolved', { roomId: request.params.roomId, dissolvedBy: request.auth.user.id, pendingTasks: result.pendingTaskIds.length }, { roomId: request.params.roomId }))
        // The tasks that were stopped are cancelled through their own transition, so the state
        // machine and its events remain the single source of truth for what happened to them.
        for (const taskId of result.pendingTaskIds) {
          try {
            cancelTask(db, { taskId, actorUserId: request.auth.user.id, actorDeviceId: request.auth.deviceId })
          } catch (error) {
            // A task that another request cancelled between the two steps is not an error: the goal
            // is that nothing is left approvable, and it already is not.
            request.log.warn({ err: error, taskId }, 'dissolve: task was already settled')
          }
        }
        const room = findRoom(db, request.params.roomId)
        return reply.code(200).send({ room: publicRoom(room), cancelledTasks: result.pendingTaskIds.length })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    // ---- invitations ----

    fastify.post('/api/v1/rooms/:roomId/invitations', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        requireRoomAdmin(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const invitation = createInvitation(db, {
          roomId: request.params.roomId,
          inviterUserId: request.auth.user.id,
          inviterDeviceId: request.auth.deviceId,
          targetUserId: body.targetUserId,
          role: body.role ?? 'member',
        })
        return reply.code(201).send({ invitation: publicInvitation(invitation) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    /** The caller's own incoming invitations, so the client can offer accept or decline. */
    fastify.get('/api/v1/invitations', { preHandler: requireAuth }, async (request) => ({
      invitations: listInvitationsFor(db, request.auth.user.id).map(publicInvitation),
    }))

    fastify.post('/api/v1/invitations/:invitationId/accept', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const result = acceptInvitation(db, {
          invitationId: request.params.invitationId,
          userId: request.auth.user.id,
          deviceId: request.auth.deviceId,
        })
        return reply.code(200).send({ room: publicRoom(result.room), membership: publicMember({ ...result.membership, user_handle: request.auth.user.user_handle, display_name: request.auth.user.display_name }) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/invitations/:invitationId/decline', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const invitation = declineInvitation(db, {
          invitationId: request.params.invitationId,
          userId: request.auth.user.id,
        })
        return reply.code(200).send({ invitation: publicInvitation(invitation) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/invitations/:invitationId/revoke', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const invitation = revokeInvitation(db, {
          invitationId: request.params.invitationId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        return reply.code(200).send({ invitation: publicInvitation(invitation) })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })
  }
}

export const roomRouteInternals = { roomFailure, findInvitation }
