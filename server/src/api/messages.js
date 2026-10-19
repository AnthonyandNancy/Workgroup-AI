// Hub message routes: send (idempotent) and backfill.
//
// Two shapes matter to clients:
//
//   POST /rooms/{roomId}/messages
//     201 with the stored message on first acceptance, 200 with the *same* message when the
//     client retries an accepted `clientMessageId`. A client therefore never has to
//     distinguish "my send was lost" from "my send worked" by guessing.
//
//   GET /rooms/{roomId}/messages?afterSeq=N
//     Everything after N in sequence order, plus `nextAfterSeq` to send next time. This is
//     the reconnect path and it must not skip or duplicate.

import {
  MessageError, sendMessage, readMessages, latestSeq, publicMessage, proposeTasksForMentions,
} from '../modules/messages/store.js'
import { addReaction, removeReaction, reactionsFor } from '../modules/messages/reactions.js'
import { RoomError, requireMember } from '../modules/rooms/store.js'
import { TaskError, publicTask } from '../modules/tasks/store.js'
import { taskFailure } from './tasks.js'
import { messageKeys } from '../security/ratelimit-store.js'
import { makeEvent } from '../realtime/events.js'

function messageFailure(reply, error) {
  if (error instanceof RoomError) {
    // Same rule as the other room routes: a non-member is answered as if the room did not
    // exist, so a guessed id cannot be confirmed.
    if (error.code === 'NOT_A_MEMBER') {
      return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
    }
    return reply.code(404).send({ error: { code: error.code, message: error.message } })
  }
  if (error instanceof MessageError) {
    const status = error.code === 'NO_SUCH_ROOM' ? 404 : 400
    return reply.code(status).send({ error: { code: error.code, message: error.message } })
  }
  // A Bot mention creates a task, so a send can meet the task rules' refusals. They are answered with
  // the task route's own statuses rather than by this route's default, which would turn a refused
  // mention into a 500.
  if (error instanceof TaskError) return taskFailure(reply, error)
  throw error
}

/** Reactions reuse the message route's statuses: a bad request stays a 400, a stranger a 404. */
function reactionFailure(reply, error) {
  return messageFailure(reply, error)
}

export function makeMessageRoutes({ requireAuth }) {
  return async function messageRoutes(fastify) {
    const { db } = fastify.hub

    fastify.post('/api/v1/rooms/:roomId/messages', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      // Every send is counted, not only failures: the load here is the write itself, which allocates
      // a room sequence number inside a transaction and holds that room's single writer while it
      // runs. A rule counting only failures would count nothing, because a rejected body never
      // reaches the store and a message send has no other failure path.
      const keys = messageKeys({ roomId: request.params.roomId, source: request.ip })
      for (const key of keys) {
        const verdict = fastify.hub.messageLimiter.check(key)
        if (!verdict.allowed) {
          reply.header('retry-after', String(verdict.retryAfterSeconds))
          return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many messages from this source.', retryAfterSeconds: verdict.retryAfterSeconds } })
        }
      }
      for (const key of keys) fastify.hub.messageLimiter.recordFailure(key)
      try {
        const result = sendMessage(db, {
          roomId: request.params.roomId,
          senderUserId: request.auth.user.id,
          senderDeviceId: request.auth.deviceId,
          clientMessageId: body.clientMessageId,
          replyToMessageId: body.replyToMessageId,
          body: body.body,
          mentions: body.mentions,
          attachments: body.attachments,
        })
        // A Bot mention proposes work; it does not start any. The task is created in
        // `PENDING_APPROVAL`, which only the other person can move — the Hub has no path from a
        // mention to a running command, and a mention must not become one.
        const proposals = result.duplicate ? [] : proposeTasksForMentions(db, {
          roomId: request.params.roomId,
          requesterUserId: request.auth.user.id,
          requesterDeviceId: request.auth.deviceId,
          message: result.message,
          text: body.body,
        })
        const message = { ...result.message, sender_display_name: request.auth.user.display_name }
        // A duplicate is a retry, not new information: republishing it would make every
        // client apply the same message twice.
        if (!result.duplicate) {
          fastify.hub.realtime.publishMessage(request.params.roomId, result.message.room_seq, publicMessage(message))
        }
        return reply.code(result.duplicate ? 200 : 201).send({ message: publicMessage(message), duplicate: result.duplicate, ...(proposals.length === 0 ? {} : { proposedTasks: proposals.map(task => publicTask(task)) }) })
      } catch (error) {
        return messageFailure(reply, error)
      }
    })

    fastify.get('/api/v1/rooms/:roomId/messages', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      try {
        // `beforeSeq` is absent rather than defaulted: the store tells "read forward from 0" apart from
        // "read backwards", and passing 0 for a missing cursor would make the second request shape
        // look like the first.
        const beforeSeq = query.beforeSeq === undefined ? undefined : Number(query.beforeSeq)
        const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq)
        const limit = query.limit === undefined ? undefined : Number(query.limit)
        const page = readMessages(db, {
          roomId: request.params.roomId,
          userId: request.auth.user.id,
          afterSeq,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(limit === undefined ? {} : { limit }),
        })
        // One query for the whole page's reactions, attached before the wire projection so a reader
        // sees them beside the messages they belong to.
        const reactions = reactionsFor(db, page.messages.map(message => message.id))
        return reply.code(200).send({
          messages: page.messages.map(message => publicMessage({
            ...message,
            ...(reactions.has(message.id) ? { reactions: reactions.get(message.id) } : {}),
          })),
          ...(page.nextBeforeSeq === undefined ? { nextAfterSeq: page.nextAfterSeq } : { nextBeforeSeq: page.nextBeforeSeq }),
          hasMore: page.hasMore,
        })
      } catch (error) {
        return messageFailure(reply, error)
      }
    })

    /**
     * Add a reaction to one message.
     *
     * Membership is the gate; the message must be in the room. The answer carries the message's whole
     * reaction set so a client can render what the Hub stored rather than its own guess, and the same
     * set is published to the room — reactions are shared, so everyone sees the same result.
     */
    fastify.post('/api/v1/rooms/:roomId/messages/:messageId/reactions', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const result = addReaction(db, {
          roomId: request.params.roomId,
          messageId: request.params.messageId,
          userId: request.auth.user.id,
          emoji: body.emoji,
        })
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('message.reaction_changed', { messageId: result.messageId, reactions: result.reactions }, { roomId: request.params.roomId }))
        return reply.code(200).send({ messageId: result.messageId, reactions: result.reactions })
      } catch (error) {
        return reactionFailure(reply, error)
      }
    })

    /**
     * Withdraw one's own reaction.
     *
     * Only the caller's own row is removed; another member's reaction is left as it was. Removing a
     * reaction that is not there is a success, because the caller's intent ("my reaction is gone") is
     * already true.
     */
    fastify.delete('/api/v1/rooms/:roomId/messages/:messageId/reactions/:emoji', { preHandler: requireAuth }, async (request, reply) => {
      try {
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        const result = removeReaction(db, {
          roomId: request.params.roomId,
          messageId: request.params.messageId,
          userId: request.auth.user.id,
          emoji: decodeURIComponent(request.params.emoji),
        })
        fastify.hub.realtime.publishToRoom(request.params.roomId,
          makeEvent('message.reaction_changed', { messageId: result.messageId, reactions: result.reactions }, { roomId: request.params.roomId }))
        return reply.code(200).send({ messageId: result.messageId, reactions: result.reactions })
      } catch (error) {
        return reactionFailure(reply, error)
      }
    })

    /** The high-water sequence, so a client starting from nothing knows where the end is. */
    fastify.get('/api/v1/rooms/:roomId/messages/head', { preHandler: requireAuth }, async (request, reply) => {
      try {
        return reply.code(200).send(latestSeq(db, { roomId: request.params.roomId, userId: request.auth.user.id }))
      } catch (error) {
        return messageFailure(reply, error)
      }
    })
  }
}
