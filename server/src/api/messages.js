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
  MessageError, sendMessage, readMessages, latestSeq, publicMessage,
} from '../modules/messages/store.js'
import { RoomError } from '../modules/rooms/store.js'

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
  throw error
}

export function makeMessageRoutes({ requireAuth }) {
  return async function messageRoutes(fastify) {
    const { db } = fastify.hub

    fastify.post('/api/v1/rooms/:roomId/messages', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const result = sendMessage(db, {
          roomId: request.params.roomId,
          senderUserId: request.auth.user.id,
          senderDeviceId: request.auth.deviceId,
          clientMessageId: body.clientMessageId,
          replyToMessageId: body.replyToMessageId,
          body: body.body,
        })
        const message = { ...result.message, sender_display_name: request.auth.user.display_name }
        // A duplicate is a retry, not new information: republishing it would make every
        // client apply the same message twice.
        if (!result.duplicate) {
          fastify.hub.realtime.publishMessage(request.params.roomId, result.message.room_seq, publicMessage(message))
        }
        return reply.code(result.duplicate ? 200 : 201).send({ message: publicMessage(message), duplicate: result.duplicate })
      } catch (error) {
        return messageFailure(reply, error)
      }
    })

    fastify.get('/api/v1/rooms/:roomId/messages', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      try {
        const afterSeq = query.afterSeq === undefined ? 0 : Number(query.afterSeq)
        const limit = query.limit === undefined ? undefined : Number(query.limit)
        const page = readMessages(db, {
          roomId: request.params.roomId,
          userId: request.auth.user.id,
          afterSeq,
          ...(limit === undefined ? {} : { limit }),
        })
        return reply.code(200).send({
          messages: page.messages.map(publicMessage),
          nextAfterSeq: page.nextAfterSeq,
          hasMore: page.hasMore,
        })
      } catch (error) {
        return messageFailure(reply, error)
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
