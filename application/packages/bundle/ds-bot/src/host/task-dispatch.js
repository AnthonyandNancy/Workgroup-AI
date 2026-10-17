// Task dispatch: the owner Host's consumer of an approved workgroup task.
//
// A Hub approval is a statement, not a command. This module is the one place where that statement
// becomes work on this machine, and it therefore treats the event that announced it as a hint:
// everything it acts on is read again from the Hub, in the owner's own authenticated session.
//
// The sequence, and the refusal that guards each step, is the same one `policy/dispatch.mjs` and
// `bot-adapter/flows.mjs` already implement: owner and state checked against a fresh read, scope
// validated on disk, a signed single-use grant consumed, and only then an isolated Task Session
// bound to the task and the approved Bot. This module adds the wiring, not a second policy.
//
// Two properties are worth stating because they constrain what may be added here:
//
//   * **An event is not authority.** `task.approved` is published to every socket in the room, so
//     its payload is used for the task id and nothing else; a member's Host that treated it as
//     authority would run another owner's task.
//   * **Nothing falls back.** A missing owner, Bot, scope, folder, or grant ends the attempt with a
//     reported failure. There is no default Bot, no default directory, and no retry against a
//     different one.

import { createPublicKey, randomUUID } from 'node:crypto'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { createApprovalClient } from '@deepseek-ai/dsh-workgroup/client/approvals'
import { acceptDispatch, resolveTaskDirectory } from '@deepseek-ai/dsh-workgroup/policy'
import { DISPATCH_OUTCOMES, progressUpdate, runDispatch } from '@deepseek-ai/dsh-workgroup/bot-adapter/flows'
import { verifyGrantSignature } from '@deepseek-ai/dsh-workgroup/policy/grant-signature'
import { splitRef } from './text.js'

/** The two events this consumer acts on. Everything else is the room's business. */
const START_EVENT = 'task.approved'
const CANCEL_EVENT = 'task.cancelled'

/**
 * The prompt a task Session starts with.
 *
 * The task's own words are the request; the surrounding sentence tells the Bot which boundary the
 * approval set, because the tool guard refuses anything else and a Bot that does not know why would
 * spend its turn retrying. No path, credential, or requester identity is added here: the folder is
 * the Session's own working directory, and who asked is the owner's business.
 *
 * @param {{ description?: string }} task
 * @returns {string}
 */
export function taskPromptText(task) {
  const description = typeof task?.description === 'string' ? task.description.trim() : ''
  return [
    'A colleague sent this request through a workgroup task, and the owner approved it:',
    '',
    description,
    '',
    'You are running in an isolated task Session. Work only within the approved folder and tools; if something you need is not approved, report it instead of working around it.',
  ].join('\n')
}

export function install(rt) {
  /** @type {Map<string, Promise<object>>} taskId -> the attempt in progress, so duplicate frames join it. */
  const inFlight = new Map()

  /** The signed-in Hub client, or undefined when this install has no usable Hub. */
  const signedInClient = () => {
    let client
    try {
      client = rt.hubClient?.()
    } catch {
      // No Hub configured (or an unreachable one) is a supported local-only install, not a fault
      // to report to the user on every event.
      return undefined
    }
    return client?.signedIn === true ? client : undefined
  }

  /**
   * Publish one progress stage, redacted at the source.
   *
   * Only the stage travels: `progressUpdate` decides what a room may see, and the Hub stores that
   * payload verbatim. A failure to report is logged locally and never replaces the task result.
   */
  /** A failure category is the only part of a failure a room may see. */
  const safeReason = code => (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined)

  const reportStage = async (approvals, taskId, update) => {
    const safe = progressUpdate(update)
    const reason = safeReason(safe.code)
    try {
      await approvals.reportProgress(taskId, { stage: safe.stage, ...(reason === undefined ? {} : { reason }) })
    } catch (error) {
      rt.warn?.('ds-bot: progress for task %s was not reported: %s', taskId, error?.message ?? error)
    }
  }

  /**
   * Move a task to a terminal state after a refusal.
   *
   * The expected version is the one the detail read carried, so a task that moved on in the
   * meantime refuses the report rather than overwriting a newer decision. The state is the honest
   * one: `EXPIRED` for a window that closed, `FAILED` for everything else.
   */
  const reportRefusal = async (approvals, task, to, update) => {
    const safe = progressUpdate(update)
    const reason = safeReason(update?.code ?? safe.code)
    try {
      await approvals.reportProgress(task.id, {
        state: to,
        expectedVersion: task.version,
        stage: safe.stage,
        ...(reason === undefined ? {} : { reason }),
      })
    } catch (error) {
      rt.warn?.('ds-bot: task %s could not be marked %s: %s', task.id, to, error?.message ?? error)
    }
  }

  const refuse = async (approvals, task, code, message) => {
    // An approval whose deadline passed is `EXPIRED`; anything else that stops the work is
    // `FAILED`. Both are terminal, so nothing retries a dispatch the owner did not authorize.
    const to = code === 'EXPIRED' ? 'EXPIRED' : 'FAILED'
    await reportRefusal(approvals, task, to, { stage: 'refused', code, message })
    return { started: false, reason: code }
  }

  /**
   * Ask the owner's Chief which Bot should run a task.
   *
   * `chief_auto` is a model decision, not a local guess: the Chief is the owner's own Main Bot, and
   * its answer is only a suggestion — `runDispatch` refuses a name that is not one of this owner's
   * Bots. Nothing is created or started here; the answer is one id, or the mode refuses.
   *
   * The one-shot call deliberately goes through the same `llm` service the Bot runs on rather than
   * opening a Session: a decision prompt must not become part of any Bot's conversation.
   */
  async function askChief({ task, candidates }) {
    const chief = rt.botOf?.(rt.state?.mainBotIds?.[0])
    if (chief === undefined) throw new Error('This team has no Main Bot, so no Chief can choose a Bot for this task.')
    const route = splitRef((await rt.desiredModel?.(chief)) ?? (await rt.defaultModel?.()))
    if (route === undefined) throw new Error('No model is available, so the Chief cannot choose a Bot.')
    const info = await rt.ctx.llm.resolveModelInfo(route.provider, route.model).catch(() => undefined)
    const efforts = info?.reasoning?.efforts ?? []
    const effort = efforts.some(entry => entry.id === 'off') ? 'off' : efforts.at(0)?.id
    const list = candidates
      .map(entry => `- ${entry.id}: ${entry.name ?? entry.id}${entry.role ? ` (${entry.role})` : ''}`)
      .join(String.fromCharCode(10))
    const text = `Task:
${String(task?.description ?? '').trim()}

Bots:
${list}

Answer with exactly one bot id from the list and nothing else.`
    const assembler = new BlockAssembler()
    for await (const chunk of rt.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      system: "You choose which one of the owner's Bots should run a task. Reply with one bot id only.",
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      maxTokens: 200,
      signal: AbortSignal.timeout(30_000),
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
    const reply = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(String.fromCharCode(10))
    // The id must be one of the candidates; a reply naming something else is no decision, and the
    // flow reports that rather than choosing for it.
    return candidates.map(entry => entry.id).find(id => reply.includes(id))
  }

  /**
   * Start one approved task, once.
   *
   * Every check below reads its inputs from the owner-scoped detail, never from the event. The
   * return value is for tests and logs; the caller does not branch on it.
   */
  async function startApprovedTask(taskId) {
    const client = signedInClient()
    if (client === undefined) return { taskId, started: false, reason: 'NO_HUB' }
    const selfUserId = client.identity?.userId
    const approvals = createApprovalClient({ client, selfUserId })
    const detail = await approvals.task(taskId)
    const task = detail?.task
    if (task === undefined) return { taskId, started: false, reason: 'NO_TASK' }
    await rt.recordRevocationVersion?.(taskId, task.revocationVersion)
    // Object-level authority, re-established from the Hub: the event named a task, not an owner.
    if (task.ownerUserId !== selfUserId) return { taskId, started: false, reason: 'NOT_OWNER' }
    if (task.state !== 'APPROVED') return { taskId, started: false, reason: `NOT_APPROVED:${task.state}` }

    const scope = task.approval?.scope
    if (scope === undefined || scope === null || typeof scope !== 'object') {
      return await refuse(approvals, task, 'NO_APPROVED_SCOPE', 'The task has no recorded approval scope.')
    }
    if (!Number.isInteger(task.version)) {
      return await refuse(approvals, task, 'NO_VERSION', 'The task has no version to report against.')
    }
    // The deadline is the owner's, when the scope named one, and the Hub's approval window
    // otherwise. A window that has closed grants nothing the executor could honour.
    const deadline = typeof scope.expiresAt === 'string' ? scope.expiresAt : task.approval?.expiresAt
    if (typeof deadline === 'string' && Date.parse(deadline) <= Date.now()) {
      return await refuse(approvals, task, 'EXPIRED', 'The approval window has closed.')
    }
    const approvedBotId = typeof task.assignedBotId === 'string' && task.assignedBotId !== ''
      ? task.assignedBotId
      : typeof scope.assignedBotId === 'string' && scope.assignedBotId !== '' ? scope.assignedBotId : undefined
    if (scope.assignedBotId !== undefined && task.assignedBotId !== undefined && task.assignedBotId !== null
      && scope.assignedBotId !== task.assignedBotId) {
      return await refuse(approvals, task, 'BOT_MISMATCH', 'The scope and the task name different Bots.')
    }
    if (scope.mode === 'existing_bot' && approvedBotId === undefined) {
      return await refuse(approvals, task, 'MISSING_ASSIGNED_BOT', 'The approval named no Bot to run this task.')
    }
    // A Session that already exists is the durable record that this task started. A live one is
    // left alone; a closed one is not restarted, because a restart would reuse an approval for
    // work nobody approved again.
    const existing = rt.taskBinding?.(taskId)
    if (existing !== undefined) {
      return { taskId, started: false, reason: existing.closedAt === null ? 'ALREADY_STARTED' : 'ALREADY_CLOSED' }
    }
    // Validate the folder before minting anything: a grant is a credential, and spending one on a
    // scope this machine can already refuse would burn a single-use secret for nothing.
    try {
      resolveTaskDirectory(scope.workDir)
    } catch (error) {
      return await refuse(approvals, task, error?.code ?? 'UNUSABLE_DIRECTORY', error?.message ?? String(error))
    }

    const minted = await approvals.mintGrant(taskId, approvedBotId === undefined ? {} : { botId: approvedBotId })
    const grant = minted?.grant
    if (grant === undefined) return await refuse(approvals, task, 'NO_GRANT', 'The Hub issued no grant for this task.')
    const published = await client.request('GET', '/dispatch/keys')
    const keys = new Map(Object.entries(published?.keys ?? {}).map(([keyId, pem]) => [keyId, createPublicKey(pem)]))

    let accepted
    try {
      accepted = await acceptDispatch({
        grant,
        deviceId: client.identity?.deviceId,
        // This Host minted the grant with its own authenticated device, so the two are the same
        // fact; the check still runs, and a mismatch would mean the grant was minted elsewhere.
        mintedForDeviceId: client.identity?.deviceId,
        task,
        approvedRevocationVersion: task.revocationVersion,
        scope,
        consume: (nonce, id) => approvals.consumeGrant(nonce, id, { signature: grant.signature, keyId: grant.keyId }),
        verifyGrant: ({ grant: checked }) => {
          const verdict = verifyGrantSignature({ grant: checked }, { keys })
          return verdict.valid ? true : verdict.reason
        },
      })
    } catch (error) {
      return await refuse(approvals, task, error?.code ?? 'DISPATCH_REFUSED', error?.message ?? String(error))
    }

    // Consuming the grant already moved the task to QUEUED (the Hub records the dispatch and the
    // state step together). Re-read the task rather than assuming a version: the transition bumped
    // it, and reporting RUNNING against the pre-consume version would be refused.
    let running
    try {
      const queued = (await approvals.task(taskId)).task
      if (queued?.ownerUserId !== selfUserId) return { taskId, started: false, reason: 'NOT_OWNER' }
      await rt.recordRevocationVersion?.(taskId, queued.revocationVersion)
      if (queued.state === 'RUNNING') {
        running = queued
      } else if (queued.state === 'QUEUED') {
        running = await approvals.reportProgress(taskId, { state: 'RUNNING', expectedVersion: queued.version })
        await rt.recordRevocationVersion?.(taskId, running.revocationVersion)
      } else {
        // A cancellation (or another terminal state) landed between consuming the grant and this
        // report. Nothing may start; the grant's own revocation/expiry is the remaining guard.
        return { taskId, started: false, reason: `STATE_${queued.state}` }
      }
    } catch (error) {
      rt.warn?.('ds-bot: task %s could not be marked running: %s', taskId, error?.message ?? error)
      return { taskId, started: false, reason: 'STATE_REFUSED' }
    }

    let outcome
    try {
      outcome = await runDispatch({
      accepted,
      approval: { mode: scope.mode, assignedBotId: approvedBotId, ownerUserId: task.ownerUserId },
      roster: { byId: rt.state?.bots ?? {} },
      task,
      // A Bot created for this task is the owner's own Bot, made through the team's own creation
      // path so it carries the same role, model, and memory rules as any other.
      ...(typeof rt.createBot === 'function' ? { createBot: input => rt.createBot(input) } : {}),
      // `chief_auto` asks the owner's Chief, through the same model service the Bot uses; a team
      // without a Chief or a model refuses that mode instead of letting an ordinary Agent stand in.
      ...(typeof rt.ctx?.llm?.stream === 'function' ? { askChief } : {}),
      onProgress: update => { void reportStage(approvals, taskId, update) },
      run: async ({ taskId: dispatchedTaskId, botId, workDir, allowedTools }) => {
        const binding = await rt.openTaskSession({
          taskId: dispatchedTaskId,
          botId,
          workDir,
          title: task.description === undefined ? undefined : `Task · ${String(task.description).slice(0, 40)}`,
        })
        await rt.rememberTaskSession(binding)
        // The grant names the Session, so it is written after the Session exists and before the
        // first turn: a tool call in that turn is checked against the approved limits.
        await rt.mintGrant({
          taskId: dispatchedTaskId,
          sessionId: binding.sessionId,
          botId,
          allowedTools,
          // The approval named no destination, so this task opens no socket. The default is the
          // deny direction, and widening it needs an approval field that does not exist yet.
          allowedHosts: [],
          workDir,
          expiresAt: typeof grant.expiresAt === 'string' ? grant.expiresAt : (typeof scope.expiresAt === 'string' ? scope.expiresAt : task.approval?.expiresAt ?? null),
          revocationVersion: task.revocationVersion,
        })
        await rt.ensureCapabilities?.(binding.sessionId)
        // The turn is what makes this execution rather than a titled empty Session. The prompt is
        // the task's own words, wrapped so the Bot knows the boundary it runs under.
        await rt.ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId: binding.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: taskPromptText(task) }],
        }, AbortSignal.timeout(30_000))
        return { sessionId: binding.sessionId }
      },
    })

    } catch (error) {
      // A runner that threw (no model endpoint, a Session the host refused) leaves the task
      // RUNNING unless it is reported; reporting FAILED is what stops the room waiting for a
      // result that will never come.
      await reportRefusal(approvals, { ...task, version: running?.version ?? task.version }, 'FAILED', {
        stage: 'failed', code: error?.code ?? 'RUN_FAILED', message: error?.message ?? String(error),
      })
      rt.warn?.('ds-bot: task %s failed to run: %s', taskId, error?.message ?? error)
      return { taskId, started: false, reason: 'RUN_FAILED' }
    }

    if (outcome.outcome === DISPATCH_OUTCOMES.REFUSED) {
      await reportRefusal(approvals, { ...task, version: running?.version ?? task.version }, 'FAILED', {
        stage: 'refused', code: outcome.code, message: outcome.message,
      })
      return { taskId, started: false, reason: outcome.code }
    }
    return { taskId, started: true, sessionId: outcome.sessionId }
  }

  /**
   * Stop one task the Hub says was cancelled.
   *
   * The order is the requirement: **the grant is revoked before the Session is stopped**, so a tool
   * call that races the stop is already refused by the per-call guard. The stop itself is DSH's own
   * archive-with-stop path, which ends the turn; whether a child process the turn started is gone is
   * not something this Host can observe, so that half is recorded as unconfirmed rather than
   * claimed.
   */
  async function cancelTask(taskId) {
    const client = signedInClient()
    if (client === undefined) return { taskId, cancelled: false, reason: 'NO_HUB' }
    const selfUserId = client.identity?.userId
    const approvals = createApprovalClient({ client, selfUserId })
    // The event is a notification; the detail is the authority for "is this cancelled, and is it mine".
    const detail = await approvals.task(taskId)
    const task = detail?.task
    if (task === undefined) return { taskId, cancelled: false, reason: 'NO_TASK' }
    await rt.recordRevocationVersion?.(taskId, task.revocationVersion)
    if (task.ownerUserId !== selfUserId) return { taskId, cancelled: false, reason: 'NOT_OWNER' }
    if (task.state !== 'CANCELLING' && task.state !== 'CANCELLED') {
      return { taskId, cancelled: false, reason: `NOT_CANCELLED:${task.state}` }
    }
    await rt.revokeGrant?.(taskId, { reason: 'hub-cancelled' })
    const binding = await rt.closeTaskSession?.(taskId)
    if (binding !== undefined) {
      // `sessionStopped` is what this Host observed: the Session was archived with its activity
      // stopped. `processTree: 'unconfirmed'` is the honest half — the model's tools may have spawned
      // an operating-system process, and no registry for it is wired here.
      binding.cancel = { signalledAt: Date.now(), sessionStopped: true, processTree: 'unconfirmed' }
      await rt.save()
      rt.warn?.('ds-bot: task %s was cancelled; child-process termination is unconfirmed', taskId)
    }
    return { taskId, cancelled: true, observed: 'UNCONFIRMED' }
  }

  /**
   * Report how a task's turn ended.
   *
   * A finished turn means the owner has a result to review; a failed or interrupted one is a
   * failure. An aborted turn is reported by the cancellation path instead, because the Hub already
   * knows the task is stopping. The report is derived from a fresh read, so the version the Hub
   * holds is the one the transition names.
   */
  async function finishTaskTurn(binding, event) {
    const client = signedInClient()
    if (client === undefined) return
    const selfUserId = client.identity?.userId
    const approvals = createApprovalClient({ client, selfUserId })
    const kind = event?.data?.reason?.kind
    if (kind === 'aborted') return
    const detail = await approvals.task(binding.taskId)
    const task = detail?.task
    if (task === undefined || task.ownerUserId !== selfUserId) return
    // A turn end is an owner-scoped read, so it is also the moment this Host learns whether the
    // task's revocation version moved while the turn was running.
    await rt.recordRevocationVersion?.(binding.taskId, task.revocationVersion)
    if (task.state !== 'RUNNING') return
    if (binding.reviewReportedAt !== undefined) return
    const failed = kind === 'error' || kind === 'interrupted'
    try {
      await approvals.reportProgress(binding.taskId, {
        state: failed ? 'FAILED' : 'REVIEW_REQUIRED',
        expectedVersion: task.version,
        stage: failed ? 'failed' : 'review',
      })
    } catch (error) {
      rt.warn?.('ds-bot: task %s could not report its turn end: %s', binding.taskId, error?.message ?? error)
      return
    }
    binding.reviewReportedAt = Date.now()
    await rt.save()
  }

  /**
   * Handle one Hub event.
   *
   * An approval starts work; a cancellation stops it. Duplicate approval frames join the attempt
   * already in progress, and the durable Session binding stops a second attempt after the first
   * settled.
   */
  const handleEvent = async (event) => {
    const taskId = event?.payload?.taskId
    if (typeof taskId !== 'string' || taskId === '') return { started: false, reason: 'NO_TASK_ID' }
    if (event?.type === CANCEL_EVENT) {
      return await cancelTask(taskId).catch((error) => {
        rt.warn?.('ds-bot: task %s was not cancelled: %s', taskId, error?.message ?? error)
        return { taskId, cancelled: false, reason: 'FAILED' }
      })
    }
    if (event?.type !== START_EVENT) return { started: false, reason: 'IGNORED' }
    const active = inFlight.get(taskId)
    if (active !== undefined) return await active
    const attempt = startApprovedTask(taskId)
      .catch((error) => {
        // A failure is logged, never retried against another Bot, folder, or model.
        rt.warn?.('ds-bot: task %s was not started: %s', taskId, error?.message ?? error)
        return { taskId, started: false, reason: 'FAILED' }
      })
      .finally(() => {
        if (inFlight.get(taskId) === attempt) inFlight.delete(taskId)
      })
    inFlight.set(taskId, attempt)
    return await attempt
  }

  // A task Session's own turn end is the only signal that the work finished. It is registered as
  // an effect so a disposed plugin stops listening.
  rt.ctx?.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const binding = rt.taskSessionOf?.(session?.id)
    if (binding === undefined) return
    void finishTaskTurn(binding, event)
  })

  /**
   * Find approved work the Host did not hear about.
   *
   * The Bridge only delivers room events, so an approval that happened while this Host was offline
   * (or while it was not watching the room) never arrives as an event. The owner's approved queue
   * is the durable read for exactly that gap: on sign-in, on resume, and on a slow timer, this
   * applies the same event path to each queued task. A task that already has a binding is skipped,
   * so reconciliation cannot start a second Session for the same work.
   */
  async function reconcileApprovedTasks() {
    const client = signedInClient()
    if (client === undefined) return { inspected: 0, started: 0 }
    const approvals = createApprovalClient({ client, selfUserId: client.identity?.userId })
    const queue = await approvals.approvedQueue()
    let started = 0
    for (const listed of Array.isArray(queue) ? queue : []) {
      if (listed?.id === undefined || listed.ownerUserId !== client.identity?.userId) continue
      if (rt.taskBinding?.(listed.id) !== undefined) continue
      const result = await handleEvent({ type: START_EVENT, payload: { taskId: listed.id } })
      if (result?.started === true) started += 1
    }
    return { inspected: Array.isArray(queue) ? queue.length : 0, started }
  }

  // The one hook `workgroup-hub` calls for every Bridge event. Assigning it is what makes this
  // module the consumer; nothing else in the product subscribes to an approval.
  rt.onWorkgroupEvent = handleEvent
  rt.taskDispatchReconcile = reconcileApprovedTasks
  // A slow reconciliation covers an approval that arrived while the Bridge was open but the room
  // was not subscribed. A minute is fast enough for work nobody is waiting on interactively, and
  // slow enough to be invisible next to the model calls a task makes.
  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => {
      void reconcileApprovedTasks().catch(error => rt.warn?.('ds-bot: approved task reconciliation failed: %s', error?.message ?? error))
    }, 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: approved task reconciliation')
  Object.assign(rt, {
    taskDispatch: handleEvent,
    // Reachable so a test can await the attempt a duplicate frame joined, without widening the
    // event contract with a task id or a promise.
    taskDispatchPending: taskId => inFlight.get(taskId),
  })
}

export const taskDispatchInternals = { START_EVENT }
