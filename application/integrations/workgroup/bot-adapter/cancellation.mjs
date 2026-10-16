// Cancellation: what actually stops a task, at every layer it is running on.
//
// Recorded as a gap three times before this file existed (H-09, F-13, A-07, A-08): "revocation stops
// the next tool call" was implemented and tested, but **a child process that had already been spawned
// was never terminated**. That is the difference between a cancelled task and a task that keeps
// downloading, keeps writing, and keeps costing money while every API answer says it is cancelled.
//
// Three layers, because stopping one is not stopping the task:
//
//   1. **The turn.** The Agent's cancel path ends the loop and refuses further tool calls.
//   2. **The managed processes.** Every subprocess the turn spawned has to be terminated and *waited
//      for*. `terminate()` is a request; `waitForExit()` is the evidence, and without it "cancelled"
//      means "we asked".
//   3. **The binding.** The local grant is marked revoked, so a retry, a queued tool call, or a
//      result publish is refused even if something survived.
//
// The escalation is deliberate about what it cannot promise. A provider that has lost track of its
// managed range cannot be made to terminate it; that case is reported as `unconfirmed` rather than
// as success, because an operator who believes a process is dead when it is not will not go looking.
//
// What this file never does is report success it did not observe. Every path either completes
// `waitForExit` or says which layer could not be confirmed.

import { spawn } from 'node:child_process'

/** How a cancellation ended. `CONFIRMED` is the only outcome that means the work has stopped. */
export const CANCELLATION_OUTCOMES = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  UNCONFIRMED: 'UNCONFIRMED',
  NOTHING_RUNNING: 'NOTHING_RUNNING',
})

export class CancellationError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'CancellationError'
    this.code = code
    this.detail = detail
  }
}

/**
 * The set of live subprocess handles for one task.
 *
 * A registry rather than a single handle because a turn can spawn several at once (a build and a
 * fetch, for instance), and cancelling only the most recent would leave the others running. Entries
 * remove themselves when their `done` settles, so a long-lived executor does not accumulate handles
 * for processes that finished hours ago.
 */
export function createProcessRegistry() {
  /** @type {Map<string, { handle: object, taskId: string, startedAt: number, label?: string }>} */
  const live = new Map()
  let counter = 0

  return {
    /**
     * Take responsibility for a spawned handle.
     *
     * Whichever component spawned the process registers it here; a process nobody registered is a
     * process cancellation cannot reach, which is the whole reason this is explicit.
     *
     * @returns {() => void} a disposer that unregisters the handle
     */
    track(handle, { taskId, label } = {}) {
      if (handle === undefined || handle === null) throw new CancellationError('A process registry needs a handle to track', 'NO_HANDLE')
      if (typeof taskId !== 'string' || taskId.length === 0) throw new CancellationError('A tracked process needs the task it belongs to', 'NO_TASK')
      counter += 1
      const id = `proc-${counter}`
      live.set(id, { handle, taskId, startedAt: Date.now(), label })
      // Removing on completion keeps the registry a set of *live* processes. `done` may be absent on a
      // provider that reports outcomes another way; the entry then stays until cancellation, which is
      // the safe direction — a stale entry costs a no-op terminate, a missing one costs a live process.
      if (handle.done !== undefined && typeof handle.done.then === 'function') {
        handle.done.then(() => live.delete(id), () => live.delete(id))
      }
      return () => live.delete(id)
    },

    /** The live handles for one task. */
    for(taskId) {
      return [...live.entries()].filter(([, entry]) => entry.taskId === taskId).map(([id, entry]) => ({ id, ...entry }))
    },

    get size() {
      return live.size
    },
  }
}

/**
 * Terminate a process and, on Windows, every process it started.
 *
 * `handle.terminate()` reaches the process the provider spawned. On Windows that process's own
 * children outlive it: a task that starts a shell which starts a compiler leaves the compiler
 * running after the task is gone, so the machine keeps working for work nobody authorized any more.
 * `taskkill /T` walks that tree, and `/F` is required because an interactive grandchild does not
 * answer a polite request.
 *
 * The POSIX path deliberately does nothing here. There the provider's own signal reaches the
 * process group and can *observe* the exit, so adding a second, unobservable mechanism would
 * replace evidence with a guess. The result says so rather than reporting success.
 *
 * Every failure — a missing `taskkill`, a permission refusal, a non-zero exit — reports
 * `confirmed: false` with the reason. Termination that cannot be confirmed is the one outcome that
 * must never be reported as success, because the caller's next action depends on it.
 *
 * @param pid - the process id to terminate, and whose tree is walked on Windows.
 * @param options - `{ platform?, run? }`; `run` executes one command and answers `{ code, stdout, stderr }`.
 *   Both are injectable so the flag construction can be tested without killing a real process.
 * @returns `{ confirmed: boolean, method: string, detail?: string }`.
 */
export async function terminateProcessTree(pid, { platform = process.platform, run } = {}) {
  const numeric = Number(pid)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return { confirmed: false, method: 'none', detail: `a process tree cannot be terminated from ${JSON.stringify(pid)}: that is not a pid` }
  }
  if (platform !== 'win32') {
    return { confirmed: false, method: 'provider', detail: `no tree termination is implemented for ${platform}; the provider's own signal path owns this` }
  }
  if (typeof run !== 'function') {
    return { confirmed: false, method: 'taskkill', detail: 'no way to run taskkill was provided' }
  }
  try {
    const result = await run('taskkill', ['/PID', String(numeric), '/T', '/F'])
    if (result?.code === 0) return { confirmed: true, method: 'taskkill' }
    const why = String(result?.stderr ?? '').trim() || `taskkill exited with code ${String(result?.code)}`
    return { confirmed: false, method: 'taskkill', detail: why }
  } catch (error) {
    return { confirmed: false, method: 'taskkill', detail: error.message }
  }
}

/**
 * Run one command and answer its exit code and output.
 *
 * Split out from `terminateProcessTree` so the flag construction is testable without spawning a
 * real `taskkill`, and so the process this module starts is itself a tracked, awaited one.
 */
function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

/**
 * Cancel one task: stop the turn, terminate its processes, wait for them, and revoke the binding.
 *
 * The order matters. The turn is cancelled **first** so it stops spawning; then the processes that
 * already exist are terminated; then the wait proves them gone. Terminating before stopping the turn
 * would leave a window in which the loop spawns one more.
 *
 * @param {{
 *   taskId: string,
 *   registry: ReturnType<typeof createProcessRegistry>,
 *   cancelTurn?: (input: { taskId: string, reason: string }) => Promise<void> | void,
 *   revokeGrant?: (input: { taskId: string, reason: string }) => Promise<void> | void,
 *   reason?: string,
 *   waitTimeoutMs?: number,
 *   now?: () => number,
 * }} input
 */
export async function cancelTask(input) {
  const {
    taskId,
    registry,
    cancelTurn,
    revokeGrant,
    reason = 'the task was cancelled',
    waitTimeoutMs = 10_000,
    now = () => Date.now(),
  } = input
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new CancellationError('A cancellation needs a task id', 'NO_TASK')
  }

  const report = { taskId, reason, turnStopped: false, requested: [], confirmed: [], unconfirmed: [], grantRevoked: false }

  // 1. Stop the loop, so nothing new is spawned while the rest of this runs.
  if (typeof cancelTurn === 'function') {
    try {
      await cancelTurn({ taskId, reason })
      report.turnStopped = true
    } catch (error) {
      // A turn that cannot be stopped is a fact the caller must not lose: the processes below may
      // still be re-spawned by it, so the outcome cannot be `CONFIRMED`.
      report.turnStopError = error.message
    }
  }

  // 2. Terminate every live handle this task owns.
  const tracked = registry?.for(taskId) ?? []
  for (const entry of tracked) {
    const handle = entry.handle
    if (handle === undefined || handle === null) {
      report.unconfirmed.push({ id: entry.id, label: entry.label, detail: 'the handle was released before it could be terminated' })
      continue
    }
    try {
      // On Windows the tree goes first, while the parent still exists to enumerate its children: a
      // `taskkill /T` run after the parent died has no tree to walk, which is how a grandchild
      // survives a cancellation that looks successful. On POSIX this does nothing and the
      // provider's own signal, which can also observe the exit, remains the only mechanism.
      if (process.platform === 'win32' && Number.isSafeInteger(Number(handle.pid))) {
        const tree = await terminateProcessTree(handle.pid, { run: runCommand })
        if (!tree.confirmed) report.unconfirmed.push({ id: entry.id, label: entry.label, detail: `the process tree could not be terminated: ${tree.detail}` })
      }
      // `terminate()` is the seam's only termination verb and is idempotent, so calling it on a
      // process that already exited is a no-op rather than an error worth reporting.
      handle.terminate?.()
      report.requested.push({ id: entry.id, label: entry.label })
    } catch (error) {
      report.unconfirmed.push({ id: entry.id, label: entry.label, detail: error.message })
    }
  }

  // 3. Wait for the managed range to empty. This is the step that turns "we asked" into evidence.
  await Promise.all(tracked.map(async (entry) => {
    const handle = entry.handle
    if (handle === undefined || handle === null || typeof handle.waitForExit !== 'function') {
      // A handle with no way to observe its exit cannot be confirmed, whoever is at fault. Reporting
      // it as confirmed would be the single most dangerous thing this function could do.
      if (!report.unconfirmed.some(item => item.id === entry.id)) {
        report.unconfirmed.push({ id: entry.id, label: entry.label, detail: 'this provider cannot report when the process has exited' })
      }
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), waitTimeoutMs)
    try {
      const emptied = await handle.waitForExit(controller.signal)
      if (emptied) report.confirmed.push({ id: entry.id, label: entry.label })
      else report.unconfirmed.push({ id: entry.id, label: entry.label, detail: `still running after ${waitTimeoutMs} ms` })
    } catch (error) {
      // The provider lost sight of its range. That is exactly the case an operator has to be told
      // about, because nothing on this machine can make it stop anymore.
      report.unconfirmed.push({ id: entry.id, label: entry.label, detail: error.message })
    } finally {
      clearTimeout(timer)
    }
  }))

  // 4. Revoke the binding, so a retry, a queued call, or a publish is refused even if something
  //    survived step 2. This runs whatever the outcome above, and it is what makes cancellation
  //    durable rather than a one-time event.
  if (typeof revokeGrant === 'function') {
    try {
      await revokeGrant({ taskId, reason })
      report.grantRevoked = true
    } catch (error) {
      report.revokeError = error.message
    }
  }

  const unconfirmed = report.unconfirmed.length > 0 || !report.turnStopped && typeof cancelTurn === 'function'
  report.outcome = unconfirmed
    ? CANCELLATION_OUTCOMES.UNCONFIRMED
    : (tracked.length === 0 ? CANCELLATION_OUTCOMES.NOTHING_RUNNING : CANCELLATION_OUTCOMES.CONFIRMED)
  report.at = new Date(now()).toISOString()
  return report
}

/**
 * What a room may be told about a cancellation.
 *
 * The room learns that the task stopped being authorized. It does not learn which process was killed,
 * how many there were, or that one could not be confirmed — those are facts about the owner's machine,
 * and the last one is a fact the owner needs and the room does not.
 */
export function cancellationNotice(report) {
  if (report === null || typeof report !== 'object') return { stage: 'cancelled' }
  return {
    stage: 'cancelled',
    // `state` is the only detail: whether the owner's side confirmed the stop is deliberately
    // omitted. A room that broadcast "could not confirm the process died" would be reporting a
    // machine's internal state to people with no business reading it.
    state: report.outcome,
  }
}
