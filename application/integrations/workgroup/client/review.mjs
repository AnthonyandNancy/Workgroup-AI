// Task progress: what the owner reports, and what the room may read.
//
// The requirement is "private intermediate data is not published automatically", and the shape of
// the failure it prevents is specific: a task runs on B's machine, in B's folder, using B's model
// and B's files. The room asked for a result. It did not ask for — and must not receive — the
// model's reasoning, the shell output, the file paths, or the intermediate drafts.
//
// This module is the boundary, written as one filter with a positive field list. Two deliberate
// consequences:
//
//   * **A new field is private by default.** A filter that removes known-bad names leaks the first
//     time somebody adds a field; a filter that admits known-good names refuses to publish until
//     the field is added here, which is a decision somebody makes on purpose.
//   * **Nothing here publishes a result.** Progress describes *state*. A result leaves the owner's
//     machine only through `review`, which is a person's decision.
//
// The redaction is applied where the update is *produced* rather than where it is sent. A filter on
// the way out is one refactor away from being bypassed by a second send path; a filter at the source
// means the private value never enters the object that travels.

/** The stages a room may be told about. Anything else is reported as unreported. */
export const PROGRESS_STAGES = Object.freeze(['queued', 'running', 'review_required', 'completed', 'shared', 'cancelled', 'failed'])

/** The only payload fields a progress event may carry into a room. */
export const PUBLIC_PROGRESS_FIELDS = Object.freeze(['stage', 'state', 'reason', 'hasResult'])

export class ProgressError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ProgressError'
    this.code = code
  }
}

/**
 * Build the progress update a room may see.
 *
 * @param {{ stage: string, state?: string, reason?: string, hasResult?: boolean, detail?: object }} input
 * @returns {{ stage: string, state?: string, reason?: string, hasResult?: boolean }}
 */
export function publicProgress(input) {
  if (input === null || typeof input !== 'object') return { stage: 'failed', reason: 'unknown' }
  const stage = PROGRESS_STAGES.includes(input.stage) ? input.stage : 'failed'
  const update = { stage }
  // A stage the client does not know is reported as a failure rather than dropped: a room that
  // silently stops hearing about a task cannot tell that from one that stopped moving.
  if (stage === 'failed' && input.stage !== 'failed') update.reason = 'unrecognised stage'
  if (typeof input.state === 'string') update.state = input.state
  if (typeof input.reason === 'string') update.reason = input.reason
  // `hasResult` is a boolean, never the result: it lets the room know something is waiting for the
  // owner's review without saying what.
  if (typeof input.hasResult === 'boolean') update.hasResult = input.hasResult
  return update
}

/**
 * Strip an event's payload down to the public fields.
 *
 * Separate from `publicProgress` because a task *event* carries a payload the executor wrote, and
 * that payload is the thing most likely to contain a shell line or a path.
 */
export function publicEventPayload(payload) {
  if (payload === null || typeof payload !== 'object') return {}
  const visible = {}
  for (const field of PUBLIC_PROGRESS_FIELDS) {
    if (payload[field] !== undefined && (typeof payload[field] === 'string' || typeof payload[field] === 'boolean')) {
      visible[field] = payload[field]
    }
  }
  return visible
}

/**
 * The redaction rule, named once so a reader can find it.
 *
 * Every field below is a fact about the owner's machine. The list exists because "redact the paths"
 * is not enough: the model's reasoning, the tool's stdout, the Bot's instructions, and the memory an
 * entry came from are all private, and each of them has been the leak in some other product.
 */
export const NEVER_PUBLISHED = Object.freeze([
  'workDir', 'cwd', 'path', 'filePath', 'paths',
  'stdout', 'stderr', 'output', 'transcript', 'reasoning',
  'model', 'modelRef', 'systemPrompt', 'instructions', 'prompt',
  'sessionId', 'botId', 'assignedBotId', 'tools', 'capabilities',
  'memory', 'memoryId', 'memoryEntry', 'context',
  'approval', 'approvedScope', 'scope', 'grantNonce', 'nonce',
])

/**
 * An audit-style check that a value about to be published carries none of the private fields.
 *
 * Used by tests and by the publish path as a last line: if a field from `NEVER_PUBLISHED` appears at
 * any depth, publishing is refused rather than filtered. Refusing is the right answer here — a
 * filter would silently strip it and the leak would be invisible, whereas a refusal names the field
 * and whoever added it fixes it.
 *
 * @throws {ProgressError} when a private field is present
 */
export function assertPublishable(value, { path = 'payload' } = {}) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublishable(item, { path: `${path}[${index}]` }))
    return value
  }
  if (typeof value !== 'object') return value
  for (const [key, child] of Object.entries(value)) {
    if (NEVER_PUBLISHED.includes(key)) {
      throw new ProgressError(`${path}.${key} must never be published to a room`, 'PRIVATE_FIELD')
    }
    assertPublishable(child, { path: `${path}.${key}` })
  }
  return value
}

/**
 * The review decision a person makes about finished work.
 *
 * Three answers, and the difference between them is who else sees the result:
 *
 *   `keep`      the work is done; the result stays on the owner's machine
 *   `share`     the owner names who receives it; the Hub records exactly that list
 *   `reject`    the work is not acceptable; the task fails and nothing is published
 *
 * @param {{ task: object, decision: string, recipients?: string[], roomMembers?: string[], actorUserId: string }} input
 */
export function reviewDecision(input) {
  const { task, decision, recipients = [], roomMembers = [], actorUserId } = input
  if (task === null || typeof task !== 'object') throw new ProgressError('A review needs a task', 'NO_TASK')
  // The owner reviews their own work: nobody else can see the result, so nobody else can judge it.
  if (task.ownerUserId !== actorUserId) {
    throw new ProgressError('Only the person who ran this task may review its result', 'NOT_THE_OWNER')
  }
  if (task.state !== 'REVIEW_REQUIRED') {
    throw new ProgressError(
      `This task is ${task.state}, so there is no result waiting for review.`,
      'NOT_AWAITING_REVIEW',
    )
  }
  if (!['keep', 'share', 'reject'].includes(decision)) {
    throw new ProgressError(`A review decision must be keep, share, or reject, got ${JSON.stringify(decision)}`, 'INVALID_DECISION')
  }

  if (decision === 'keep') {
    // Kept work is still finished. The task completes; nothing leaves the machine.
    return { decision, recipients: [], transitionsTo: 'COMPLETED', publishes: false }
  }
  if (decision === 'reject') {
    return { decision, recipients: [], transitionsTo: 'FAILED', publishes: false }
  }

  // `share` requires naming at least one recipient. Sharing to "everybody" because nobody was named
  // is the mistake this refuses: an empty list is an unanswered question, not a grant to the room.
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new ProgressError(
      'Sharing a result needs at least one named recipient. Choose who receives it.',
      'NO_RECIPIENTS',
    )
  }
  const unknown = recipients.filter(recipient => !roomMembers.includes(recipient))
  if (unknown.length > 0) {
    // The same rule the Hub applies to an artifact share: a recipient must be in the room. Naming
    // somebody outside it would publish work to a person with no standing to see it.
    throw new ProgressError(
      `A recipient must be a member of this room; not a member: ${unknown.join(', ')}.`,
      'RECIPIENT_NOT_A_MEMBER',
    )
  }
  // The requester is always told: they asked for the work, and a result shared with a third party
  // but not with them would be worse than not sharing at all.
  const withRequester = [...new Set([...recipients, task.requesterUserId])]
  return { decision, recipients: withRequester, transitionsTo: 'SHARED', publishes: true }
}

/**
 * Whether publishing this text is allowed by the content policy.
 *
 * The recipient rules decide *who* may see a result and never look at what it says, so a summary the
 * owner pasted a credential into travelled to the room because the recipient list was correct. This
 * is the missing half: the content itself, checked before the payload is built.
 *
 * A missing policy allows everything. That is not a weaker rule but the same rule as before this
 * check existed — a deployment that has configured no policy keeps publishing exactly what it
 * published yesterday, and inventing a default would refuse work for a reason nobody set.
 *
 * @param text - the content about to be published.
 * @param policy - `{ patterns }`, literal substrings to refuse.
 * @throws {ProgressError} naming the matched pattern, never the whole policy: the author needs to
 *   find the text, and reciting every rule teaches what the filter looks for.
 */
function assertContentPolicy(text, policy) {
  if (typeof text !== 'string' || text === '') return
  const patterns = policy?.patterns
  if (!Array.isArray(patterns) || patterns.length === 0) return
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue
    if (text.includes(pattern)) {
      throw new ProgressError(
        `This result contains something the content policy refuses to publish (matched ${JSON.stringify(pattern)}). Remove it, or keep the result instead of sharing it.`,
        'CONTENT_REFUSED',
      )
    }
  }
}

/**
 * What a share publishes, and what it does not.
 *
 * Separated from `reviewDecision` so the two questions stay distinct: *who* may see it (the
 * decision) and *what* they see (this). A share that carried the working directory would give the
 * recipient a map of the owner's machine.
 *
 * The content policy runs here because this function is the single point where the published text
 * is assembled: a caller that checked somewhere else could still build a payload without checking,
 * and the refusal has to stop the publish rather than annotate it.
 *
 * @param {{ task: object, artifact?: object, summary?: string }} input
 * @param policy - `{ patterns }`; absent means the deployment configured none.
 */
export function sharedPayload({ task, artifact, summary }, policy) {
  const payload = {
    taskId: task?.id,
    roomId: task?.roomId,
    // The description is what the room already saw when the task was requested, so repeating it
    // publishes nothing new.
    description: task?.description,
    sharedBy: task?.ownerUserId,
  }
  if (typeof summary === 'string' && summary.trim() !== '') {
    // A summary is written for the room by the owner; it is published because they wrote it to be.
    payload.summary = summary.trim()
  }
  // Both texts are checked, and both are checked before the artifact reference is added, so a
  // refused publication is refused whole rather than in part.
  assertContentPolicy(payload.description, policy)
  assertContentPolicy(payload.summary, policy)
  if (artifact !== undefined && artifact !== null) {
    // The artifact is referenced, never inlined: the bytes stay behind the artifact's own ACL, which
    // the Hub enforces per reader and per request.
    payload.artifact = { id: artifact.id, fileName: artifact.fileName, contentType: artifact.contentType, sizeBytes: artifact.sizeBytes }
  }
  return assertPublishable(payload)
}

/**
 * The recipients a share actually grants, as the Hub's artifact ACL takes them.
 *
 * Named so the caller cannot pass the room's whole member list "for convenience": the list here is
 * the one a person chose.
 */
export function recipientsForShare(decision) {
  if (decision === null || typeof decision !== 'object' || decision.decision !== 'share') return []
  return [...decision.recipients]
}
