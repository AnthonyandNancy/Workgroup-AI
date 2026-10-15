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
  publicRoom, publicMember, publicInvitation,
} from '../modules/rooms/store.js'
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
      case 'NOT_ALLOWED':
      case 'ACCOUNT_DISABLED':
      case 'CANNOT_REMOVE_SELF':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'ALREADY_A_MEMBER':
      case 'CANNOT_REMOVE_OWNER':
      case 'CANNOT_CHANGE_OWNER':
      case 'OWNER_CANNOT_LEAVE':
      case 'INVITATION_NOT_PENDING':
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
    const { db } = fastify.hub

    // ---- rooms ----

    fastify.get('/api/v1/rooms', { preHandler: requireAuth }, async (request) => ({
      rooms: listRoomsFor(db, request.auth.user.id).map(publicRoom),
    }))

    fastify.post('/api/v1/rooms', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const room = createRoom(db, {
          name: body.name,
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
          members: listMembers(db, request.params.roomId).map(publicMember),
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
        return reply.code(200).send({ members: listMembers(db, request.params.roomId).map(publicMember) })
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
