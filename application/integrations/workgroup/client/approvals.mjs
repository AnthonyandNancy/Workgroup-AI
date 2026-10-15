// Approvals: the client half of "only B decides, on B's own device".
//
// The Hub enforces that only a task's owner may decide it. This module exists because the *client*
// has to make that visible: an approval card that appears for everybody would tell a room that
// somebody else's Bot is about to run, and a UI that let a Chief approve on a colleague's behalf
// would turn the Hub's refusal into an error message instead of a design.
//
// Three ideas, all of which are the reason this is a module rather than a component:
//
//   1. **An approval is personal.** `pending()` asks for the caller's own tasks, and the card is
//      rendered only for tasks whose owner is this user. There is no "approve for someone else",
//      not even for a Chief.
//   2. **A decision carries the scope it grants.** Approving names *which* Bot, which mode, and
//      which resources — the same facts the local policy re-checks in A-07. A decision without a
//      scope would be an approval of "whatever", and "whatever" is what the gate exists to refuse.
//   3. **A stale card cannot approve.** Every decision sends the version the card was drawn from,
//      so a task that moved on (already decided, already cancelled) is refused rather than decided
//      twice. Two devices watching one task is the normal case, not the exception.
//
// The three dispatch modes the product requires are `existing_bot`, `chief_auto`, and `create_bot`.
// They are named here, not invented: the Hub validates against exactly this list.

import { MEMBER_ROLES } from './index.mjs'

/** The three ways a task may be dispatched, as the Hub names them. */
export const ASSIGNMENT_MODES = Object.freeze(['existing_bot', 'chief_auto', 'create_bot'])

/** A human-readable name for each mode, for the card's choices. */
export const ASSIGNMENT_MODE_LABELS = Object.freeze({
  existing_bot: 'Use one of my Bots',
  chief_auto: 'Let my Chief choose',
  create_bot: 'Create a new Bot for this task',
})

export class ApprovalError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
  }
}

/**
 * Whether this task is waiting on *this* user.
 *
 * The single predicate the whole feature hangs on, so it is one function rather than a condition
 * repeated in three components. A task is the viewer's to decide only when it is in the approval
 * state and they are its owner.
 */
export function isMineToDecide(task, userId) {
  return task?.state === 'PENDING_APPROVAL' && task?.ownerUserId === userId
}

/**
 * What the card may offer, given the task and the Bots this person has published.
 *
 * Returned as data rather than rendered directly, so a test can assert the *choices* without a
 * browser — the interesting behaviour in an approval card is which options exist, not their markup.
 *
 * `existing_bot` is offered only when there is at least one published Bot: an option that cannot be
 * completed is worse than an absent one, because choosing it leads to a refusal the person cannot
 * act on.
 */
export function approvalChoices(task, publishedBots = []) {
  if (task === undefined || task === null) return { modes: [], bots: [] }
  const bots = publishedBots.map(entry => ({ botId: entry.botId, displayName: entry.displayName, role: entry.role }))
  const modes = []
  if (bots.length > 0) modes.push('existing_bot')
  // The Chief is a Bot of this person's own team, so the mode is offered whenever the team has any
  // Bot at all — including the single-Bot case, where the Chief would pick itself.
  if (bots.length > 0) modes.push('chief_auto')
  // Creating one is always possible, because it needs no existing Bot.
  modes.push('create_bot')
  // A task that names a Bot up front starts on that Bot rather than asking twice.
  const suggestedMode = task.targetBotId === undefined || task.targetBotId === null ? undefined : 'existing_bot'
  return { modes, bots, ...(suggestedMode === undefined ? {} : { suggestedMode, suggestedBotId: task.targetBotId }) }
}

/**
 * Build the scope an approval grants.
 *
 * Every field is the owner's own statement about what may happen. The Hub records it verbatim and
 * the local policy re-checks it before any tool runs, so the two ends agree on the boundary rather
 * than each inventing one.
 *
 * `workDir` and `tools` are deliberately **absent** unless the caller supplied them: an executor
 * that found no directory in the scope must refuse, and a client that filled in a default would
 * turn that refusal into a silent fallback to the team directory — the exact behaviour the
 * requirement forbids.
 */
export function approvalScope({ mode, botId, workDir, tools, recipients, expiresInSeconds } = {}) {
  if (!ASSIGNMENT_MODES.includes(mode)) {
    throw new ApprovalError(`An assignment mode must be one of ${ASSIGNMENT_MODES.join(', ')}`, 'INVALID_ASSIGNMENT_MODE')
  }
  if (mode === 'existing_bot' && (botId === undefined || botId === null || botId === '')) {
    // Caught here as well as on the Hub: the person is looking at the form, and telling them now
    // costs a round trip less.
    throw new ApprovalError('Choosing an existing Bot requires picking one', 'MISSING_ASSIGNED_BOT')
  }
  const scope = { mode }
  if (mode === 'existing_bot') scope.assignedBotId = botId
  if (workDir !== undefined && workDir !== null && workDir !== '') scope.workDir = workDir
  if (Array.isArray(tools) && tools.length > 0) scope.tools = [...tools]
  if (Array.isArray(recipients) && recipients.length > 0) scope.recipients = [...recipients]
  if (typeof expiresInSeconds === 'number') scope.expiresInSeconds = expiresInSeconds
  return scope
}

/**
 * The client half of the approval flow.
 *
 * @param {{ client: object, bridge?: object, selfUserId?: string }} options
 */
export function createApprovalClient({ client, bridge, selfUserId } = {}) {
  if (client === undefined) throw new ApprovalError('A Hub client is required', 'NO_HUB_CLIENT')

  const me = () => selfUserId ?? client.identity?.userId

  /**
   * The decision call itself, as a named function.
   *
   * Named rather than an object method because `reject` delegates to it: a method calling
   * `this.decide` breaks the moment a caller destructures the returned object, which is how a UI
   * would naturally use it.
   */
  const decide = async ({ taskId, decision, expectedVersion, mode, botId, workDir, tools, recipients }) => {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ApprovalError(`A decision must be approve or reject, got ${JSON.stringify(decision)}`, 'INVALID_DECISION')
    }
    if (!Number.isInteger(expectedVersion)) {
      throw new ApprovalError('A decision must name the version it was made against', 'MISSING_VERSION')
    }
    const body = { decision, expectedVersion }
    if (decision === 'approve') {
      const scope = approvalScope({ mode, botId, workDir, tools, recipients })
      body.assignmentMode = scope.mode
      if (scope.assignedBotId !== undefined) body.assignedBotId = scope.assignedBotId
      body.approvedScope = scope
    }
    const answered = await client.request('POST', `/tasks/${taskId}/decision`, { body })
    return answered.task
  }

  return {
    /** The tasks waiting on this user, and only this user. */
    async pending() {
      const listed = await client.request('GET', '/tasks/pending')
      return listed.tasks
    },

    /**
     * One task, including the scope an approval granted.
     *
     * `includeScope` is asked for explicitly: the scope names a directory and a tool list, and a
     * response that carried it by default would put the owner's private paths into every reader's
     * view of the task.
     */
    task: taskId => client.request('GET', `/tasks/${taskId}`),

    /** The task's event history, which is the redacted progress stream (A-09 owns its contents). */
    async progress(taskId) {
      const detail = await client.request('GET', `/tasks/${taskId}`)
      return detail.events ?? detail.task?.events ?? []
    },

    /**
     * Report progress, as the task's owner.
     *
     * `state` moves the task and requires the version the reporter holds, so two reports cannot
     * both win. A stage-only report changes nothing and needs no version: it says the work is
     * still going, which is not a transition.
     *
     * The Hub refuses this from anybody but the owner: a progress line the requester could write
     * would let them claim work the owner never did.
     */
    reportProgress: (taskId, { state, expectedVersion, stage }) => client.request('POST', `/tasks/${taskId}/progress`, {
      body: {
        ...(stage === undefined ? {} : { stage }),
        ...(state === undefined ? {} : { state, expectedVersion }),
      },
    // The route answers `{ task }`; the task is what a caller wants, so the wrapper is dropped here
    // rather than at every call site.
    }).then(answered => answered.task),

    /**
     * Review a finished result.
     *
     * Three outcomes, and only one of them publishes anything: `keep` completes the task and
     * publishes nothing, `reject` fails it and publishes nothing, and `share` names who receives it.
     */
    review: (taskId, decision, { expectedVersion, recipients } = {}) => {
      if (!['keep', 'reject', 'share'].includes(decision)) {
        throw new ApprovalError(`A review decision must be keep, share, or reject, got ${JSON.stringify(decision)}`, 'INVALID_DECISION')
      }
      if (decision === 'share' && (!Array.isArray(recipients) || recipients.length === 0)) {
        // The same refusal the Hub makes, here so the person is told before a request is sent. An
        // empty recipient list is an unanswered question, not a grant to the room.
        throw new ApprovalError('Sharing a result needs at least one named recipient. Choose who receives it.', 'NO_RECIPIENTS')
      }
      return client.request('POST', `/tasks/${taskId}/${decision}`, {
        body: { expectedVersion, ...(decision === 'share' ? { recipients } : {}) },
      }).then(answered => answered.task)
    },

    /**
     * Approve or reject.
     *
     * The version is required, not optional: a decision without one would overwrite whatever the
     * task had become, and the two-device case is exactly when that matters.
     *
     * @param {{ taskId: string, decision: 'approve'|'reject', expectedVersion: number, mode?: string, botId?: string, workDir?: string, tools?: string[], recipients?: string[] }} input
     */
    decide,

    /**
     * Reject without naming a dispatch: a rejection grants nothing, so there is nothing to scope.
     *
     * Defined after `decide` and called through it directly rather than via `this`, because a
     * destructured `const { reject } = approvals` would otherwise lose `this` and throw at the
     * moment the user clicks the button.
     */
    reject: (taskId, expectedVersion) => decide({ taskId, decision: 'reject', expectedVersion }),

    /**
     * Cancel a task this user asked for, or owns.
     *
     * Cancelling is separate from rejecting: a rejection answers a request that has not run, a
     * cancellation stops work that has. The Hub decides who may do which.
     */
    cancel: taskId => client.request('POST', `/tasks/${taskId}/cancel`, { body: {} }),

    /**
     * Mint one grant for a task the owner has approved.
     *
     * Minting is a **separate step from approving**, and that separation is deliberate: the approval
     * is the owner's standing answer, while a grant is one short-lived, single-use credential bound
     * to a botId and to this device. Approving once and handing out grants on demand is what lets
     * the owner stop authorizing by revoking, without re-deciding the task.
     *
     * The nonce comes back exactly once and is never stored in readable form, so this returns it to
     * the caller that will present it — and nothing caches it.
     */
    mintGrant: (taskId, { botId, ttlSeconds } = {}) => client.request('POST', `/tasks/${taskId}/grant`, {
      body: { botId, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) },
    }),

    /**
     * Present a grant to start work.
     *
     * The body is `{ nonce, taskId }`: the Hub looks the grant up by the nonce's hash, not by id,
     * because the nonce is the secret and the id is not. The **device** is taken from the
     * authenticated session and never from the body, so a grant captured from one machine cannot be
     * presented from another.
     *
     * The answer names the approved scope, which is what the local executor must enforce; the Hub's
     * consumption is a record, not an enforcement of the scope.
     */
    consumeGrant: (nonce, taskId) => client.request('POST', '/dispatch/consume', { body: { nonce, taskId } }),

    /**
     * The grants this task has handed out, so the owner can see what is currently authorized.
     *
     * Only the task's owner may read this: the fact that a grant was minted is about the owner's
     * machine, not the room's business.
     */
    grants: taskId => client.request('GET', `/tasks/${taskId}/grants`),

    /**
     * The scope an approval granted, from the task detail.
     *
     * The Hub nests it as `task.approval.scope` and only includes it for the owner or once the task
     * is past the approval state. Reading it through one helper means a caller cannot accidentally
     * treat "the field is absent" as "no scope was granted" — those are different, and the second
     * would authorize everything.
     */
    async approvedScope(taskId) {
      const detail = await client.request('GET', `/tasks/${taskId}`)
      const scope = detail.task?.approval?.scope
      if (scope === undefined) {
        throw new ApprovalError(
          'This task has no recorded approval scope. Either it has not been decided, or this caller may not read it.',
          'NO_APPROVED_SCOPE',
        )
      }
      return scope
    },

    /**
     * Revoke every outstanding grant for a task.
     *
     * There is deliberately no single-grant revoke. The Hub's route revokes all of a task's grants
     * and bumps the task's revocation version, because a partial revocation is not a state the
     * executor can honour: it would have to decide which of several grants authorized the call it
     * is about to make, and the answer changes while it runs.
     */
    revokeGrants: taskId => client.request('POST', `/tasks/${taskId}/grants/revoke`, { body: {} }),

    /** Fix this client's notion of who it is, when the host knows better than the token. */
    get selfUserId() {
      return me()
    },
  }
}

/**
 * Apply a task event to the list a card is drawn from.
 *
 * Pure, and separate from the reducer in `client/index.mjs` because a task list has a rule a message
 * list does not: **a task that stops waiting on this user disappears from their pending list**. The
 * Hub pushes `task.approved` to the whole room, so without that rule every member would see
 * somebody else's approval as though it were still theirs to make.
 *
 * @param {object[]} pending the current pending list
 * @param {object} event a `wg.v1` envelope
 * @param {{ selfUserId?: string }} [options]
 */
export function reducePending(pending, event, { selfUserId } = {}) {
  if (!Array.isArray(pending) || event === null || typeof event !== 'object') return pending
  const task = event.payload?.task
  if (task === undefined) return pending
  const without = pending.filter(entry => entry.id !== task.id)
  // Anything that is no longer awaiting a decision leaves the list, whoever decided it.
  if (!isMineToDecide(task, selfUserId)) return without
  // A change to a still-pending task replaces the entry, so the version the card holds advances with
  // the Hub rather than drifting until the decision is refused.
  return [...without, task]
}

/**
 * The label a state shows on a task's progress line.
 *
 * Every state the Hub can be in has a label; an unknown one is named as unknown rather than
 * dropped, because a task that vanishes from the UI looks like one that never existed.
 */
export function taskStateLabel(state) {
  switch (state) {
    case 'PENDING_APPROVAL': return 'Waiting for approval'
    case 'APPROVED': return 'Approved'
    case 'QUEUED': return 'Queued'
    case 'RUNNING': return 'Running'
    case 'REVIEW_REQUIRED': return 'Waiting for review'
    case 'COMPLETED': return 'Completed'
    case 'SHARED': return 'Shared'
    case 'REJECTED': return 'Rejected'
    case 'CANCELLING': return 'Cancelling'
    case 'CANCELLED': return 'Cancelled'
    case 'EXPIRED': return 'Expired'
    case 'FAILED': return 'Failed'
    default: return `Unknown state (${String(state)})`
  }
}

export { MEMBER_ROLES }
