// Task routes: create, decide, cancel, read.
//
// The authorization shape, which is the whole point of these routes:
//
//  * **Create** requires membership of the room *and* that the task's owner is also a member.
//    The requester names an owner and, optionally, a Bot the owner published and the
//    requester may see.
//  * **Decide** requires the caller to be the task's owner. Not an admin, not the requester,
//    not a companion, not the owner's Chief. Everything the Hub knows about the decision
//    comes from the owner's own authenticated device.
//  * **Cancel** requires the requester, the owner, or a room admin.
//  * **Read** requires room membership; a non-member is answered as if the task did not
//    exist, matching the room routes.
//
// Creating a task performs **no** work and touches nothing of the owner's. It writes a row
// and waits.

import {
  TaskError,
  createTask, decideTask, cancelTask, transition, findTask, findApprovalForTask, listTaskEvents, recordTaskResult,
  listTasksForRoom, listPendingForOwner, listApprovedForOwner, latestProgressReason, publicTask, publicTaskEvent,
  listTaskEventsForRoom,
} from '../modules/tasks/store.js'
import { RoomError, requireMember, listMembers } from '../modules/rooms/store.js'
import { revokeGrantsForTask } from '../modules/tasks/grants.js'
import { shareTaskArtifactsWithRoom } from '../modules/artifacts/store.js'
import { makeEvent } from '../realtime/events.js'
import { publicMessage, sendMessage } from '../modules/messages/store.js'

/**
 * Map a task or room refusal to a response.
 *
 * Exported because the message route creates tasks when a Bot is mentioned, so it meets the same
 * refusals. Reusing this keeps one set of statuses for one set of rules; a second mapping would drift,
 * and it already did: the mention path answered 500 for `BOT_NOT_AVAILABLE`.
 */
export function taskFailure(reply, error) {
  if (error instanceof RoomError) {
    if (error.code === 'NOT_A_MEMBER') {
      return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
    }
    return reply.code(404).send({ error: { code: error.code, message: error.message } })
  }
  if (error instanceof TaskError) {
    switch (error.code) {
      case 'NO_SUCH_TASK':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      case 'NOT_TASK_OWNER':
      case 'NOT_ALLOWED_TO_CANCEL':
      case 'BOT_NOT_AVAILABLE':
      case 'BOT_NOT_IN_DIRECTORY':
        // A refusal is a 403 here: the caller already knows the task exists, because they
        // named it, so hiding it would only confuse a legitimate client.
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'VERSION_CONFLICT':
      case 'ALREADY_DECIDED':
      case 'ALREADY_TERMINAL':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      case 'ILLEGAL_TRANSITION':
        return reply.code(409).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  throw error
}

/** Tell the room's sockets that a task moved, without disclosing the owner's detail. */
function publishTaskEvent(fastify, task, type, payload) {
  fastify.hub.realtime.publishToRoom(task.room_id, makeEvent(type, {
    taskId: task.id,
    state: task.state,
    ...payload,
  }, { roomId: task.room_id }))
}

/**
 * Write a shared result into the room as a message from the Bot that produced it.
 *
 * @returns the public message, or `undefined` when the task recorded no result text.
 */
function publishResultMessage(fastify, { task, senderUserId, senderDeviceId }) {
  const text = typeof task.result_text === 'string' ? task.result_text.trim() : ''
  if (text === '') return undefined
  const botId = task.assigned_bot_id ?? task.target_bot_id
  const result = sendMessage(fastify.hub.db, {
    roomId: task.room_id,
    senderUserId,
    senderDeviceId,
    clientMessageId: `task-result:${task.id}`,
    body: text,
    ...(botId === undefined || botId === null ? {} : { senderBotId: botId }),
  })
  // The stored row carries database column names; readers get the wire shape. The Bot's name is read
  // back the same way a page read resolves it, so a live event and a reload agree.
  const named = fastify.hub.db.prepare(`SELECT m.*,
      u.display_name AS sender_display_name,
      d.display_name AS sender_bot_display_name
    FROM messages m
    JOIN users u ON u.id = m.sender_user_id
    LEFT JOIN bot_directory d
      ON d.owner_user_id = m.sender_user_id AND d.bot_id = m.sender_bot_id
    WHERE m.id = ?`).get(result.message.id)
  const message = publicMessage(named ?? result.message)
  // A retry of the same share finds its own message by its deterministic client id and writes
  // nothing new, so sharing twice cannot duplicate the Bot's line.
  if (result.duplicate !== true) {
    fastify.hub.realtime.publishMessage(task.room_id, result.message.room_seq, message)
  }
  return message
}

export function makeTaskRoutes({ requireAuth }) {
  return async function taskRoutes(fastify) {
    const { db } = fastify.hub

    /** Create a task waiting for its owner's decision. Nothing runs yet. */
    fastify.post('/api/v1/rooms/:roomId/tasks', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const task = createTask(db, {
          roomId: request.params.roomId,
          requesterUserId: request.auth.user.id,
          requesterDeviceId: request.auth.deviceId,
          ownerUserId: body.ownerUserId,
          targetBotId: body.targetBotId,
          description: body.description,
        })
        // The owner's client learns of the request over their own socket subscription; the
        // room learns that a request exists, which is what makes progress visible later.
        publishTaskEvent(fastify, task, 'task.approval_requested', { requesterUserId: task.requester_user_id, ownerUserId: task.owner_user_id })
        return reply.code(201).send({ task: publicTask(task) })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /**
     * The owner's decision. This route is the only way out of `PENDING_APPROVAL`.
     */
    fastify.post('/api/v1/tasks/:taskId/decision', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const task = decideTask(db, {
          taskId: request.params.taskId,
          approverUserId: request.auth.user.id,
          approverDeviceId: request.auth.deviceId,
          decision: body.decision,
          expectedVersion: body.expectedVersion,
          assignmentMode: body.assignmentMode,
          assignedBotId: body.assignedBotId,
          approvedScope: body.approvedScope,
        })
        const approval = findApprovalForTask(db, task.id)
        publishTaskEvent(fastify, task, task.state === 'APPROVED' ? 'task.approved' : 'task.cancelled', {
          decidedBy: request.auth.user.id,
        })
        return reply.code(200).send({ task: publicTask(task, { includeScope: true, includeMachine: true, approval }) })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    fastify.post('/api/v1/tasks/:taskId/cancel', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const task = cancelTask(db, {
          taskId: request.params.taskId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        // The revocation version bump already invalidates outstanding grants; marking them
        // explicitly means an operator reading the table sees the same conclusion the
        // executor reaches, instead of having to compare versions by hand.
        const revokedGrants = revokeGrantsForTask(db, { taskId: task.id })
        publishTaskEvent(fastify, task, 'task.cancelled', { cancelledBy: request.auth.user.id, revokedGrants })
        return reply.code(200).send({ task: publicTask(task) })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /** One task, visible to members of its room. */
    fastify.get('/api/v1/tasks/:taskId', { preHandler: requireAuth }, async (request, reply) => {
      const task = findTask(db, request.params.taskId)
      if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
      try {
        requireMember(db, { roomId: task.room_id, userId: request.auth.user.id })
      } catch (error) {
        if (error instanceof RoomError) {
          // A non-member cannot tell a real task from an invented one.
          return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
        }
        throw error
      }
      const approval = findApprovalForTask(db, task.id)
      const isOwner = task.owner_user_id === request.auth.user.id
      // The approved scope names resources the owner chose: a working directory and a tool list that
      // describe their machine. Only the owner reads it. A requester used to receive it as soon as
      // the task left `PENDING_APPROVAL`, which published the owner's directory and tools to anybody
      // in the room who could read the task; the share step is where a result and its provenance
      // travel instead.
      return reply.code(200).send({
        task: publicTask(task, {
          includeScope: isOwner,
          includeMachine: isOwner,
          ...(approval === undefined || !isOwner ? {} : { approval }),
        }),
        // Events are the redacted stream by construction: `publicTaskEvent` publishes only the
        // recorded public payload, which never carried the scope.
        events: listTaskEvents(db, task.id).map(publicTaskEvent),
      })
    })

    /** The room's redacted task activity stream. This is not a message log. */
    fastify.get('/api/v1/rooms/:roomId/task-events', { preHandler: requireAuth }, async (request, reply) => {
      try {
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        return reply.code(200).send({
          events: listTaskEventsForRoom(db, {
            roomId: request.params.roomId,
            limit: request.query?.limit,
            ...(request.query?.before === undefined ? {} : { before: request.query.before }),
          }),
        })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /** The task list for one room. */
    fastify.get('/api/v1/rooms/:roomId/tasks', { preHandler: requireAuth }, async (request, reply) => {
      try {
        requireMember(db, { roomId: request.params.roomId, userId: request.auth.user.id })
        return reply.code(200).send({
          tasks: listTasksForRoom(db, request.params.roomId).map((task) => {
            const lastReason = latestProgressReason(db, task.id)
            return { ...publicTask(task), ...(lastReason === undefined ? {} : { lastReason }) }
          }),
        })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /**
     * The owner's approval queue.
     *
     * This is what the owner's client shows instead of letting the Chief decide: the queue is
     * addressed to the authenticated user, so only they can see what is waiting for them.
     */
    /**
     * Report progress.
     *
     * Only the owner's device reports, because progress describes the owner's machine. The payload is
     * filtered here rather than trusted: `publicTaskEvent` is the room's view, and the fields it drops
     * are the ones that describe the machine.
     */
    fastify.post('/api/v1/tasks/:taskId/progress', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      // A failure reason is a category the room may read, never free-form text from the owner's
      // machine: an error message can carry a path, a command, or a tool's output.
      if (body.reason !== undefined && (typeof body.reason !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(body.reason))) {
        return reply.code(400).send({ error: { code: 'INVALID_REASON', message: 'A progress reason must be an upper-case category code' } })
      }
      try {
        const task = findTask(db, request.params.taskId)
        if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
        if (task.owner_user_id !== request.auth.user.id) {
          // The requester does not get to write the owner's progress either: a progress line the
          // requester could forge would let them claim work the owner never did.
          return reply.code(403).send({ error: { code: 'NOT_TASK_OWNER', message: 'Only the task owner reports its progress' } })
        }
        const publicPayload = {
          stage: body.stage,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }
        // An absent stage is a state-only report; an absent state is a stage-only one. The public
        // payload is built once so a state report and a bare event carry the same fields.
        if (body.state !== undefined) {
          const updated = transition(db, {
            taskId: task.id,
            to: body.state,
            expectedVersion: body.expectedVersion,
            actorUserId: request.auth.user.id,
            actorDeviceId: request.auth.deviceId,
            eventType: 'task.progress',
            payload: publicPayload,
          })
          publishTaskEvent(fastify, updated, 'task.progress', publicPayload)
          return reply.code(200).send({ task: publicTask(updated, { includeMachine: true }) })
        }
        // A stage-only report changes no state, so it is a bare event.
        publishTaskEvent(fastify, task, 'task.progress', publicPayload)
        return reply.code(200).send({ task: publicTask(task, { includeMachine: true }) })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /**
     * The owner reviews a finished result: keep it, share it, or reject it.
     *
     * Three routes rather than one with a mode, because the three differ in what they authorize and
     * a route is where that is visible. `keep` and `reject` publish nothing; `share` is the only one
     * that names recipients, and it keeps them.
     */
    for (const [action, to] of [['keep', 'COMPLETED'], ['reject', 'FAILED']]) {
      fastify.post(`/api/v1/tasks/:taskId/${action}`, { preHandler: requireAuth }, async (request, reply) => {
        const body = request.body ?? {}
        try {
          const task = findTask(db, request.params.taskId)
          if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
          if (task.owner_user_id !== request.auth.user.id) {
            // Only the person who ran the work can judge it: nobody else has seen the result.
            return reply.code(403).send({ error: { code: 'NOT_TASK_OWNER', message: 'Only the task owner reviews its result' } })
          }
          const updated = transition(db, {
            taskId: task.id,
            to,
            expectedVersion: body.expectedVersion,
            actorUserId: request.auth.user.id,
            actorDeviceId: request.auth.deviceId,
            eventType: `task.${action === 'keep' ? 'completed' : 'failed'}`,
          })
          publishTaskEvent(fastify, updated, action === 'keep' ? 'task.shared' : 'task.cancelled', { reason: action })
          return reply.code(200).send({ task: publicTask(updated, { includeMachine: true }) })
        } catch (error) {
          return taskFailure(reply, error)
        }
      })
    }

    /**
     * Share a result with named recipients.
     *
     * The recipients are checked against the room's membership, and the requester is always added:
     * a result shared with a third party but not with the person who asked for it would be worse than
     * not sharing.
     */
    fastify.post('/api/v1/tasks/:taskId/share', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const task = findTask(db, request.params.taskId)
        if (task === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_TASK', message: 'No such task' } })
        if (task.owner_user_id !== request.auth.user.id) {
          return reply.code(403).send({ error: { code: 'NOT_TASK_OWNER', message: 'Only the task owner shares its result' } })
        }
        const named = Array.isArray(body.recipients) ? body.recipients.filter(entry => typeof entry === 'string' && entry.length > 0) : []
        if (named.length === 0) {
          // An empty list is an unanswered question, not a grant to the room.
          return reply.code(400).send({ error: { code: 'NO_RECIPIENTS', message: 'Sharing a result needs at least one named recipient' } })
        }
        const members = new Set(listMembers(db, task.room_id).map(member => member.user_id))
        const unknown = named.filter(recipient => !members.has(recipient))
        if (unknown.length > 0) {
          return reply.code(400).send({ error: { code: 'RECIPIENT_NOT_A_MEMBER', message: 'A recipient must be a member of this room' } })
        }
        const updated = transition(db, {
          taskId: task.id,
          to: 'SHARED',
          expectedVersion: body.expectedVersion,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
          eventType: 'task.shared',
          payload: { recipients: named.length },
        })
        publishTaskEvent(fastify, updated, 'task.shared', { recipients: [...new Set([...named, task.requester_user_id])] })
        // The files that went with this result become readable by everyone the message reaches. Sharing
        // the text without the files would show a result nobody outside the recipient list could open.
        const sharedArtifacts = shareTaskArtifactsWithRoom(fastify.hub.db, { taskId: updated.id, roomId: updated.room_id })
        // Sharing is the act that publishes the result to the room, so the result becomes a message
        // here rather than in a second route: one authorized decision, one visible outcome. The Bot
        // that spoke is the one the owner approved for this task, named by the server so no client
        // can put words in another Bot's mouth.
        const spoken = publishResultMessage(fastify, {
          task: updated,
          senderUserId: request.auth.user.id,
          senderDeviceId: request.auth.deviceId,
        })
        return reply.code(200).send({
          task: publicTask(updated, { includeMachine: true }),
          ...(spoken === undefined ? {} : { message: spoken }),
          sharedArtifacts,
        })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    /**
     * Record what a finished task produced.
     *
     * Owner-only: the text describes work the owner's machine did. It is not published by this route;
     * `share` is what turns it into a room message, which keeps "the result exists" and "the room may
     * read it" as two separate, separately-authorized facts.
     */
    fastify.post('/api/v1/tasks/:taskId/result', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const updated = recordTaskResult(db, {
          taskId: request.params.taskId,
          ownerUserId: request.auth.user.id,
          text: body.text,
        })
        return reply.code(200).send({ task: publicTask(updated, { includeMachine: true, includeResult: true }) })
      } catch (error) {
        return taskFailure(reply, error)
      }
    })

    fastify.get('/api/v1/tasks/pending', { preHandler: requireAuth }, async (request) => ({
      tasks: listPendingForOwner(db, request.auth.user.id).map(task => publicTask(task)),
    }))

    /**
     * The owner's approved execution queue.
     *
     * Addressed to the authenticated owner like the pending queue, and answered with the scope they
     * themselves approved: this is the read a Host uses to find work that was approved while it was
     * offline or not watching the room. It is not a room read, and no other member may call it.
     */
    fastify.get('/api/v1/tasks/approved', { preHandler: requireAuth }, async (request) => ({
      tasks: listApprovedForOwner(db, request.auth.user.id).map((task) => {
        const approval = findApprovalForTask(db, task.id)
        return publicTask(task, { includeScope: true, includeMachine: true, ...(approval === undefined ? {} : { approval }) })
      }),
    }))
  }
}
