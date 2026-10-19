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
  createRoom, listRoomSummariesFor, listMembers, findRoom, requireMember, requireRoomAdmin,
  createInvitation, acceptInvitation, declineInvitation, revokeInvitation, findInvitation,
  listInvitationsFor, removeMember, leaveRoom, setMemberRole, updateRoom,
  publicRoom, publicRoomSummary, publicMember, publicInvitation, dissolveRoom,
} from '../modules/rooms/store.js'
import { cancelOpenTasksForBot, cancelTask } from '../modules/tasks/store.js'
import {
  RoomBotError, addOwnBot, inviteBot, acceptBotInvitation, declineBotInvitation,
  revokeBotInvitation, removeRoomBot, removeBotsOwnedBy, listRoomBots, listBotCandidates,
  listBotInvitationsFor,
} from '../modules/rooms/bots.js'
import { makeEvent } from '../realtime/events.js'

/** Map a domain refusal to a response, keeping the status semantics documented above. */
function roomFailure(reply, error) {
  if (error instanceof RoomBotError) {
    switch (error.code) {
      case 'ROOM_DISSOLVED':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      case 'ALREADY_IN_ROOM':
      case 'INVITATION_NOT_PENDING':
      case 'OWN_BOT_DIRECT':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      case 'INVITATION_EXPIRED':
        return reply.code(410).send({ error: { code: error.code, message: error.message } })
      case 'NOT_ALLOWED':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'NO_SUCH_ROOM':
      case 'NO_SUCH_BOT':
      case 'NO_SUCH_INVITATION':
      case 'NOT_IN_ROOM':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  if (error instanceof RoomError || error instanceof InvitationError) {
    switch (error.code) {
      case 'NOT_A_MEMBER':
        // A non-member must not be able to tell a real room id from an invented one.
        return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
      case 'NO_SUCH_ROOM':
      case 'NO_SUCH_USER':
      case 'NO_SUCH_INVITATION':
      case 'NO_SUCH_BOT':
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
      rooms: listRoomSummariesFor(db, request.auth.user.id).map(publicRoomSummary),
    }))

    fastify.post('/api/v1/rooms', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const room = createRoom(db, {
          name: body.name,
          kind: body.kind,
          ownerUserId: request.auth.user.id,
          ownerDeviceId: request.auth.deviceId,
          botIds: body.botIds,
          adminBotId: body.adminBotId,
        })
        return reply.code(201).send({
          room: publicRoom({ ...room, member_role: 'owner' }),
          bots: listRoomBots(db, room.id),
        })
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
          bots: listRoomBots(db, request.params.roomId),
        })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    /**
     * The Bots the caller may bring into this room.
     *
     * `requireMember` is the same gate the other room reads use, so a non-member receives the
     * same 404 as an unknown room and cannot use the candidate list to probe membership.
     */
    fastify.get('/api/v1/rooms/:roomId/bot-candidates', { preHandler: requireAuth }, async (request, reply) => {
      try {
        return reply.code(200).send({
          bots: listBotCandidates(db, {
            roomId: request.params.roomId,
            viewerUserId: request.auth.user.id,
          }),
        })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    /** Add one of the caller's own Bots to a workgroup. */
    fastify.post('/api/v1/rooms/:roomId/bots', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const bot = addOwnBot(db, {
          roomId: request.params.roomId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
          botId: request.body?.botId,
        })
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('room.bot_added', { roomId: request.params.roomId, ownerUserId: bot.ownerUserId, botId: bot.botId }, { roomId: request.params.roomId }))
        return reply.code(201).send({ bot })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.delete('/api/v1/rooms/:roomId/bots/:ownerUserId/:botId', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const removed = removeRoomBot(db, {
          roomId: request.params.roomId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
          ownerUserId: request.params.ownerUserId,
          botId: request.params.botId,
        })
        const cancelledTasks = cancelOpenTasksForBot(db, {
          roomId: request.params.roomId,
          ownerUserId: removed.ownerUserId,
          botId: removed.botId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('room.bot_removed', { roomId: request.params.roomId, ownerUserId: removed.ownerUserId, botId: removed.botId }, { roomId: request.params.roomId }))
        for (const taskId of cancelledTasks) {
          fastify.hub.realtime.publishToRoom(request.params.roomId,
            makeEvent('task.cancelled', { taskId, reason: 'bot_removed' }, { roomId: request.params.roomId }))
        }
        return reply.code(200).send({ ...removed, cancelledTasks })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/rooms/:roomId/bot-invitations', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const invitation = inviteBot(db, {
          roomId: request.params.roomId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
          ownerUserId: request.body?.ownerUserId,
          botId: request.body?.botId,
        })
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('bot_invitation.created', { roomId: request.params.roomId, invitation }, { roomId: request.params.roomId }))
        return reply.code(201).send({ invitation })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.get('/api/v1/bot-invitations', { preHandler: requireAuth }, async (request) => ({
      invitations: listBotInvitationsFor(db, request.auth.user.id),
    }))

    fastify.post('/api/v1/bot-invitations/:invitationId/accept', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const result = acceptBotInvitation(db, {
          invitationId: request.params.invitationId,
          ownerUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        fastify.hub.realtime.publishToRoom(result.roomId,
          makeEvent('room.bot_added', { roomId: result.roomId, ownerUserId: result.ownerUserId, botId: result.botId }, { roomId: result.roomId }))
        // The invitation is no longer pending, and every member's copy of it has to say so: the
        // requester's "waiting for the owner" and the owner's inbox both key off this event.
        fastify.hub.realtime.publishToRoom(result.roomId,
          makeEvent('bot_invitation.changed', {
            roomId: result.roomId,
            invitationId: request.params.invitationId,
            ownerUserId: result.ownerUserId,
            botId: result.botId,
            status: 'accepted',
          }, { roomId: result.roomId }))
        return reply.code(200).send(result)
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/bot-invitations/:invitationId/decline', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const published = declineBotInvitation(db, { invitationId: request.params.invitationId, actorUserId: request.auth.user.id })
        fastify.hub.realtime.publishToRoom(published.roomId,
          makeEvent('bot_invitation.changed', { roomId: published.roomId, invitation: published, status: published.status }, { roomId: published.roomId }))
        return reply.code(200).send({ invitation: published })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.post('/api/v1/bot-invitations/:invitationId/revoke', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const published = revokeBotInvitation(db, { invitationId: request.params.invitationId, actorUserId: request.auth.user.id })
        fastify.hub.realtime.publishToRoom(published.roomId,
          makeEvent('bot_invitation.changed', { roomId: published.roomId, invitation: published, status: published.status }, { roomId: published.roomId }))
        return reply.code(200).send({ invitation: published })
      } catch (error) {
        return roomFailure(reply, error)
      }
    })

    fastify.patch('/api/v1/rooms/:roomId', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        // Membership is the gate the store's own authority check then narrows; asking here keeps a
        // non-member answered exactly like an unknown room before any field is looked at.
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const before = findRoom(db, request.params.roomId)
        const { room, changes } = updateRoom(db, {
          roomId: request.params.roomId,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.notice === undefined ? {} : { notice: body.notice }),
          ...(body.replyMode === undefined ? {} : { replyMode: body.replyMode }),
          ...(body.workDir === undefined ? {} : { workDir: body.workDir }),
          ...(body.permission === undefined ? {} : { permission: body.permission }),
          ...(body.adminBot === undefined ? {} : { adminBot: body.adminBot }),
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        const published = (name, payload) => fastify.hub.realtime.publishToRoom(
          request.params.roomId,
          makeEvent(name, { roomId: request.params.roomId, ...payload }, { roomId: request.params.roomId }),
        )
        if (body.name !== undefined && room.name !== before?.name) published('room.renamed', { name: room.name })
        if (body.notice !== undefined && room.notice !== (before?.notice ?? '')) {
          published('room.notice_changed', { notice: room.notice })
        }
        // One event for the three settings that are not the profile: they change together from the
        // settings page, and a reader applies them together.
        const settings = changes.filter(change => change.replyMode !== undefined || change.workDir !== undefined || change.permission !== undefined)
        if (settings.length > 0) {
          published('room.settings_changed', {
            ...(room.reply_mode === undefined ? {} : { replyMode: room.reply_mode }),
            workDir: room.work_dir ?? null,
            permission: room.permission ?? null,
          })
        }
        if (changes.some(change => change.adminBot !== undefined)) {
          published('room.admin_bot_changed', {
            effectiveReplyMode: publicRoom(room).effectiveReplyMode,
            ...(room.admin_bot_id === null || room.admin_bot_id === undefined
              ? {}
              : { adminBotOwnerUserId: room.admin_bot_owner_user_id, adminBotId: room.admin_bot_id }),
          })
        }
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
        const removedBots = removeBotsOwnedBy(db, {
          roomId: request.params.roomId,
          ownerUserId: request.params.userId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        const cancelledTasks = []
        for (const removed of removedBots) {
          cancelledTasks.push(...cancelOpenTasksForBot(db, {
            roomId: request.params.roomId,
            ownerUserId: removed.ownerUserId,
            botId: removed.botId,
            actorUserId: request.auth.user.id,
            actorDeviceId: request.auth.deviceId,
          }))
          fastify.hub.realtime.publishToRoom(request.params.roomId,
            makeEvent('room.bot_removed', { roomId: request.params.roomId, ownerUserId: removed.ownerUserId, botId: removed.botId }, { roomId: request.params.roomId }))
        }
        for (const connection of fastify.hub.realtime.connections.values()) {
          if (connection.user.id !== request.params.userId) continue
          if (connection.rooms.has(request.params.roomId)) fastify.hub.realtime.unsubscribe(connection, request.params.roomId)
          fastify.hub.realtime.send(connection, makeEvent('member.changed', { roomId: request.params.roomId, reason: 'removed' }))
        }
        return reply.code(200).send({ ...result, removedBots, cancelledTasks })
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
        const removedBots = removeBotsOwnedBy(db, {
          roomId: request.params.roomId,
          ownerUserId: request.auth.user.id,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        const cancelledTasks = []
        for (const removed of removedBots) {
          cancelledTasks.push(...cancelOpenTasksForBot(db, {
            roomId: request.params.roomId,
            ownerUserId: removed.ownerUserId,
            botId: removed.botId,
            actorUserId: request.auth.user.id,
            actorDeviceId: request.auth.deviceId,
          }))
          fastify.hub.realtime.publishToRoom(request.params.roomId,
            makeEvent('room.bot_removed', { roomId: request.params.roomId, ownerUserId: removed.ownerUserId, botId: removed.botId }, { roomId: request.params.roomId }))
        }
        return reply.code(200).send({ ...result, removedBots, cancelledTasks })
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
