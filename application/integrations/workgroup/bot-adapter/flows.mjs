// Dispatch flows: the three ways an approved task becomes a running native Bot.
//
// The three modes are the product's own names (`existing_bot`, `chief_auto`, `create_bot`), and the
// difference between them is only *which Bot runs*. Everything after that is identical, and this
// module is written so that is literally true: all three converge on one `runWith` call, so a rule
// about running cannot apply to one mode and not another.
//
// Two things this module must not do, both of which are the reason it exists:
//
//   * **It must not impersonate a Bot with a plain Agent.** A task runs in a Bot's own Session, with
//     that Bot's role, instructions, model, and memory; `openTaskSession` is the only entry point,
//     and it refuses a Bot id that is not in the roster. A fallback that ran the task as an
//     anonymous agent would produce an answer the owner would attribute to their own Bot.
//   * **It must not choose a Bot the owner did not authorize.** `existing_bot` uses the approved id
//     verbatim; `chief_auto` asks the Chief, whose answer is a *suggestion* that then has to be an
//     existing Bot of this owner's; `create_bot` creates one and binds the task to it. Every path
//     ends at a Bot belonging to the same owner the approval named.
//
// The approval's scope is passed through untouched. This module never widens it, and in particular
// never substitutes a workspace for a missing directory: `acceptDispatch` has already refused that
// case, and a second chance to invent a default here would undo it.

/** How a dispatch ended. Every value is a fact the owner can act on. */
export const DISPATCH_OUTCOMES = Object.freeze({
  STARTED: 'STARTED',
  REFUSED: 'REFUSED',
  FAILED: 'FAILED',
})

export class FlowError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'FlowError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Choose the Bot that will run an approved task.
 *
 * @param {{
 *   mode: string,
 *   assignedBotId?: string,
 *   roster: { byId: Record<string, object>, mainBotIds?: string[] },
 *   approvedForOwnerUserId: string,
 *   createBot?: (input: object) => Promise<{ id: string }>,
 *   askChief?: (input: object) => Promise<string | undefined>,
 *   task?: object,
 * }} input
 * @returns {Promise<{ botId: string, created: boolean, how: string, choseBy?: string }>}
 */
export async function chooseBot(input) {
  const { mode, assignedBotId, roster, approvedForOwnerUserId, createBot, askChief, task } = input
  const ownBots = Object.values(roster?.byId ?? {})

  if (mode === 'existing_bot') {
    if (typeof assignedBotId !== 'string' || assignedBotId.length === 0) {
      // The approval should have named one; `approvalScope` refuses the same mistake at the form.
      throw new FlowError('This approval chose an existing Bot but named none, so nothing can run.', 'MISSING_ASSIGNED_BOT')
    }
    const bot = roster?.byId?.[assignedBotId]
    if (bot === undefined) {
      // Deliberately not "fall back to the Chief": the owner named a Bot, and running the task on a
      // different one would be executing something they did not approve.
      throw new FlowError(
        `The approved Bot ${assignedBotId} is not in this team, so this task cannot run.`,
        'BOT_NOT_IN_TEAM',
        { assignedBotId },
      )
    }
    return { botId: bot.id, created: false, how: 'existing_bot' }
  }

  if (mode === 'chief_auto') {
    if (typeof askChief !== 'function') {
      throw new FlowError('This team has no Chief to choose a Bot, so this task cannot run.', 'NO_CHIEF')
    }
    const chosen = await askChief({ task, candidates: ownBots })
    if (typeof chosen !== 'string' || chosen.length === 0) {
      throw new FlowError('The Chief did not name a Bot, so this task cannot run.', 'CHIEF_CHOSE_NOTHING')
    }
    const bot = roster?.byId?.[chosen]
    if (bot === undefined) {
      // The Chief is a model. Its answer is a suggestion, and a suggestion that names a Bot this
      // team does not have is refused rather than approximated — otherwise "the Chief picked" would
      // be a way to run a task on something the owner never approved.
      throw new FlowError(
        `The Chief chose ${chosen}, which is not in this team, so this task cannot run.`,
        'CHIEF_CHOSE_UNKNOWN_BOT',
        { chosen },
      )
    }
    return { botId: bot.id, created: false, how: 'chief_auto', choseBy: 'chief' }
  }

  if (mode === 'create_bot') {
    if (typeof createBot !== 'function') {
      throw new FlowError('This client cannot create a Bot, so this task cannot run.', 'CANNOT_CREATE_BOT')
    }
    const created = await createBot({
      // A name is required and the owner has not typed one, so it is derived from the task rather
      // than invented: the owner sees a Bot whose name says why it exists, and can rename it.
      name: input.botName ?? `Task Bot ${String(task?.id ?? '').slice(0, 8)}`.trim(),
      role: input.botRole ?? '',
      brief: task?.description ?? '',
      createdBy: approvedForOwnerUserId,
    })
    if (created === undefined || typeof created.id !== 'string' || created.id.length === 0) {
      throw new FlowError('Creating the Bot did not produce one, so this task cannot run.', 'BOT_CREATION_FAILED')
    }
    return { botId: created.id, created: true, how: 'create_bot' }
  }

  throw new FlowError(`An assignment mode must be existing_bot, chief_auto, or create_bot, got ${JSON.stringify(mode)}`, 'INVALID_ASSIGNMENT_MODE')
}

/**
 * Run an approved, accepted dispatch.
 *
 * The `run` callback is the one place a native Bot Session is opened, and it receives the chosen Bot
 * and the approved directory. Everything the three modes disagreed about has already been decided by
 * then, so the running rules are written once.
 *
 * The outcome is returned rather than thrown for a *refusal*: a task that cannot run because the
 * owner's Bot is missing is a normal result the caller reports. A genuine failure still throws,
 * because swallowing it would report a crashed task as a finished one.
 *
 * @param {{
 *   accepted: { taskId: string, botId: string | null, workDir: string, tools: string[] },
 *   approval: { mode: string, assignedBotId?: string, ownerUserId?: string },
 *   roster: object,
 *   run: (input: object) => Promise<object>,
 *   createBot?: Function,
 *   askChief?: Function,
 *   task?: object,
 *   onProgress?: (update: object) => void;
 * }} input
 */
export async function runDispatch(input) {
  const { accepted, approval, roster, run, createBot, askChief, task, onProgress } = input
  if (typeof run !== 'function') throw new FlowError('A dispatch needs a runner', 'NO_RUNNER')
  if (accepted === undefined || accepted === null) throw new FlowError('A dispatch needs an accepted grant', 'NO_ACCEPTED_DISPATCH')

  const mode = approval?.mode ?? 'existing_bot'
  const ownerUserId = approval?.ownerUserId

  let choice
  try {
    choice = await chooseBot({
      mode,
      assignedBotId: approval?.assignedBotId ?? accepted.botId ?? undefined,
      roster,
      approvedForOwnerUserId: ownerUserId,
      createBot,
      askChief,
      task,
      botName: input.botName,
      botRole: input.botRole,
    })
  } catch (error) {
    if (error instanceof FlowError) {
      // A refusal is reported, not thrown: the owner needs to see "your Bot is not in this team",
      // and the task needs to reach a terminal state rather than sit in RUNNING forever.
      onProgress?.({ stage: 'refused', code: error.code, message: error.message })
      return { outcome: DISPATCH_OUTCOMES.REFUSED, code: error.code, message: error.message, taskId: accepted.taskId }
    }
    throw error
  }

  // Three ids have to agree before anything runs: the Bot the accepted grant is for, the Bot the
  // approval records, and the Bot that was chosen. Each pair is checked, because they can disagree
  // independently — A-07 compared the grant to the task, and this is where the third one joins.
  //
  // Two of the three agreeing is not enough. A grant minted for one Bot with an approval recorded
  // for another means one of the two sides is stale or forged, and running on the third value (the
  // choice) would pick whichever the code happened to prefer.
  const mismatches = []
  const grantBotId = accepted.botId
  const approvedBotId = typeof approval?.assignedBotId === 'string' && approval.assignedBotId !== '' ? approval.assignedBotId : undefined
  if (approvedBotId !== undefined && choice.botId !== approvedBotId) {
    mismatches.push(`the approval is for Bot ${approvedBotId}, but ${choice.botId} was chosen`)
  }
  if (typeof grantBotId === 'string' && grantBotId !== '' && approvedBotId !== undefined && grantBotId !== approvedBotId) {
    mismatches.push(`the accepted grant is for Bot ${grantBotId}, but the approval is for ${approvedBotId}`)
  }
  if (typeof grantBotId === 'string' && grantBotId !== '' && choice.botId !== grantBotId && approvedBotId === undefined) {
    // No approval named a Bot (the `chief_auto` and `create_bot` modes), so the grant is the only
    // binding there is — and a grant for another Bot must not run.
    mismatches.push(`the accepted grant is for Bot ${grantBotId}, but ${choice.botId} was chosen`)
  }
  if (mismatches.length > 0) {
    const message = `This task will not run: ${mismatches.join('; ')}.`
    onProgress?.({ stage: 'refused', code: 'BOT_MISMATCH', message })
    return { outcome: DISPATCH_OUTCOMES.REFUSED, code: 'BOT_MISMATCH', message, taskId: accepted.taskId, detail: { mismatches } }
  }

  onProgress?.({ stage: 'starting', botId: choice.botId, how: choice.how, created: choice.created })

  const result = await run({
    taskId: accepted.taskId,
    botId: choice.botId,
    // The directory comes from the accepted dispatch, which validated it against the approved root.
    // It is passed through unchanged; this layer has no default to offer.
    workDir: accepted.workDir,
    allowedTools: accepted.tools,
    how: choice.how,
    created: choice.created,
  })

  onProgress?.({ stage: 'started', botId: choice.botId, sessionId: result?.sessionId })
  return {
    outcome: DISPATCH_OUTCOMES.STARTED,
    taskId: accepted.taskId,
    botId: choice.botId,
    how: choice.how,
    created: choice.created,
    sessionId: result?.sessionId,
  }
}

/**
 * What a dispatch should report to the room.
 *
 * Progress is **redacted** here, at the point it is produced, rather than filtered on the way out:
 * a field that never enters the update cannot be leaked by a later change to the sender. What the
 * room learns is that the task moved, not what it read, where it ran, or what it produced.
 *
 * This is A-09's input contract as much as A-08's output: the numbers here are the ones a room may
 * see, and the ones absent are the ones only the owner may.
 */
export function progressUpdate({ stage, botId, sessionId, code, message }) {
  switch (stage) {
    case 'starting':
      // No Bot id: which of the owner's Bots runs a task is the owner's business, and the room only
      // needs to know the work began.
      return { stage: 'starting' }
    case 'started':
      // No session id either, for the same reason, plus a Session id would name a folder.
      return { stage: 'running' }
    case 'refused':
      return { stage: 'refused', code: code ?? 'REFUSED', message: message ?? 'This task could not start.' }
    case 'finished':
      // A result is not published here at all: sharing it is A-09's review step, and a progress
      // update that carried it would publish private work by accident.
      return { stage: 'finished', hasResult: true }
    case 'failed':
      return { stage: 'failed', code: code ?? 'FAILED' }
    default:
      // An unknown stage is named rather than dropped, so a new stage is visible in the room instead
      // of silently never arriving.
      return { stage: 'unknown', reported: String(stage) }
  }
}

/**
 * The redaction rule for what a room may see of a task's event stream.
 *
 * Written as a positive list: only these fields survive. A negative list ("everything except paths")
 * is the shape that leaks, because it is correct until somebody adds a field.
 */
export const ROOM_VISIBLE_TASK_FIELDS = Object.freeze(['id', 'roomId', 'requesterUserId', 'ownerUserId', 'description', 'state', 'createdAt', 'updatedAt'])

/**
 * Strip a task down to what the room may see.
 *
 * The fields it removes are the ones that describe the owner's machine: which Bot was chosen, where
 * it ran, and what it was allowed to use. A room knows a task is running; it does not get to
 * inventory the machine running it.
 */
export function roomVisibleTask(task) {
  if (task === null || typeof task !== 'object') return undefined
  const visible = {}
  for (const field of ROOM_VISIBLE_TASK_FIELDS) {
    if (task[field] !== undefined) visible[field] = task[field]
  }
  return visible
}

/**
 * The fields a task event may carry into a room.
 *
 * A task *event* is what actually reaches other members over the socket, so this is the list that
 * matters. `payload` is filtered separately by `roomVisibleEventPayload`, because an event's payload
 * is free-form and a single allow-list on the envelope would publish it whole.
 */
export const ROOM_VISIBLE_EVENT_FIELDS = Object.freeze(['id', 'taskId', 'eventType', 'actorUserId', 'createdAt'])

export function roomVisibleEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  const visible = {}
  for (const field of ROOM_VISIBLE_EVENT_FIELDS) {
    if (event[field] !== undefined) visible[field] = event[field]
  }
  if (event.payload !== undefined) visible.payload = roomVisibleEventPayload(event.payload)
  return visible
}

/** The payload fields a room may see of a task event: a state name and nothing else. */
export function roomVisibleEventPayload(payload) {
  if (payload === null || typeof payload !== 'object') return {}
  const visible = {}
  if (typeof payload.state === 'string') visible.state = payload.state
  if (typeof payload.stage === 'string') visible.stage = payload.stage
  if (typeof payload.reason === 'string') visible.reason = payload.reason
  return visible
}
