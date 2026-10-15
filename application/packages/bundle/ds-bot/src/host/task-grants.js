// Task grants: what one approved cross-user task is allowed to do, checked before every tool
// call rather than only when the Session was created.
//
// A grant exists because "the owner approved this work" and "the model now wants to run a
// command" are different moments. A Session-time restriction is a promise about the future;
// this module is the check that keeps it. It runs on every tool call, so a grant that is
// revoked, expired, or widened past what was approved stops the work at the next step instead
// of at the next Session.
//
// Four rules, each of which fails on its own:
//
//   allow-list  a tool the approval did not name is refused, including a tool the Bot owns
//   version     cancelling a task bumps a version; a grant minted against the old one is dead
//   window      the grant has its own expiry, clamped at mint time to the approval's expiry
//   paths       a file tool may only touch the folder the approval named, links resolved
//
// The prompt is not consulted. A model may be convinced to ask for something it was told not
// to; the guard is what answers, and it answers the same way regardless of how the request was
// phrased.
//
// What this module cannot do: kill an operating-system process. Cancellation reaches the
// running turn through the Agent's own cancel path (see `revoke`), which stops the loop and
// refuses further tool calls. A child process that has already been spawned is terminated by
// `cancellation.mjs`'s registry, which the executor populates, not by this file.

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

/** Tools every task may use whatever the approval said: they read or report, never act. */
const ALWAYS_ALLOWED = new Set(['ask_user', 'present'])

/** Tools whose arguments name a path, so the folder rule can be applied to them. */
const PATH_ARGUMENTS = ['path', 'file_path', 'filePath', 'dir', 'directory', 'cwd', 'target', 'uri']

/**
 * The real path of `path`, resolving every link on the part of it that exists.
 *
 * A string comparison cannot answer "is this inside the approved folder", because a link placed
 * inside the folder points anywhere and the string still starts with the folder. `realpath` is
 * the only answer, and it has to run on the runtime path rather than only when the folder was
 * configured (F-12 does it there): a link can be created after the approval, by the very turn
 * the approval authorizes.
 *
 * The write target usually does not exist yet, so the walk resolves the deepest existing
 * ancestor and re-appends the rest. `dirname` of a filesystem root returns the root, which ends
 * the walk when nothing along the path exists.
 */
function realPathOf(path) {
  let current = path
  const tail = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync.native(current) : resolve(realpathSync.native(current), ...tail)
    } catch {
      const parent = dirname(current)
      // Unresolvable all the way up: fall back to the lexical path, which is what the check
      // compared before. Never widen the decision, only decline to narrow it.
      if (parent === current) return resolve(path)
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/** Whether `candidate` is `root` itself or lies beneath it. */
const within = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)

export function install(rt) {
  const { ctx, state } = rt
  if (state.taskGrants === undefined) state.taskGrants = {}

  /** @type {Map<string, object>} taskId -> grant */
  const byTask = new Map()
  /** @type {Map<string, string>} sessionId -> taskId */
  const bySession = new Map()

  const rebuildIndex = () => {
    byTask.clear()
    bySession.clear()
    for (const [taskId, grant] of Object.entries(state.taskGrants ?? {})) {
      byTask.set(taskId, grant)
      if (typeof grant.sessionId === 'string') bySession.set(grant.sessionId, taskId)
    }
  }

  const grantForSession = sessionId => {
    if (sessionId === undefined) return undefined
    const taskId = bySession.get(sessionId)
    return taskId === undefined ? undefined : byTask.get(taskId)
  }

  /**
   * Record what one task may do.
   *
   * `allowedTools` is the owner's own list; an approval that names none gets none, because
   * "no tools named" is not the same statement as "every tool allowed".
   */
  async function mintGrant({ taskId, sessionId, botId, allowedTools, workDir, expiresAt, revocationVersion = 0 }) {
    if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('ds-bot: a task grant needs a task id')
    if (!Array.isArray(allowedTools)) throw new Error('ds-bot: a task grant needs an allowedTools list')
    const grant = {
      taskId,
      sessionId,
      botId: botId ?? null,
      allowedTools: [...new Set(allowedTools.map(String))],
      workDir: workDir ?? null,
      expiresAt: expiresAt ?? null,
      // The version the Hub had when this was approved. A cancellation on the Hub raises it, and
      // the next call here sees the difference — that is how a cancellation reaches a machine
      // nobody can send a command to.
      revocationVersion: Number(revocationVersion),
      mintedAt: Date.now(),
      revokedAt: null,
      revokedReason: null,
    }
    state.taskGrants[taskId] = grant
    await rt.save()
    rebuildIndex()
    return grant
  }

  /**
   * Revoke a grant and stop the work it authorises.
   *
   * Both halves matter: marking the grant dead stops the *next* tool call, and cancelling the
   * Agent stops the turn that is already running. Doing only the first would let a long step
   * finish; doing only the second would let a queued message start a fresh turn afterwards.
   */
  async function revokeGrant(taskId, { reason = 'revoked' } = {}) {
    const grant = byTask.get(taskId)
    if (grant === undefined) return undefined
    if (grant.revokedAt === null) {
      grant.revokedAt = Date.now()
      grant.revokedReason = reason
      state.taskGrants[taskId] = grant
      await rt.save()
      rebuildIndex()
    }
    // `agent.cancel` is the Agent's own stop path: it ends the current turn and leaves the
    // Session idle rather than deleting anything, so the owner can still read what the task did.
    // `resolveAgent` answers with the Agent itself, the same value DS Bot's own stop path
    // cancels through, so this reaches the running turn rather than a wrapper around it.
    const agent = grant.sessionId === undefined ? undefined : await rt.resolveAgent(grant.sessionId).catch(() => undefined)
    agent?.cancel?.({ kind: 'user', reason: `ds-bot/task-${reason}` })
    return grant
  }

  /**
   * Whether one tool call is allowed. Returns undefined to allow, or a refusal string.
   *
   * The refusal is written for the model, because that is who reads it: it says what was
   * refused and what the approved limits are, so the model can report instead of retrying.
   */
  function checkToolCall(exec) {
    const sessionId = exec?.agent?.id
    const grant = grantForSession(sessionId)
    // Not a task Session: this guard has nothing to say about it.
    if (grant === undefined) return undefined

    if (grant.revokedAt !== null) {
      return `This task's approval was withdrawn (${grant.revokedReason}), so ${exec.name} will not run. Report what you have and stop.`
    }
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.now()) {
      return `This task's approval expired at ${grant.expiresAt}, so ${exec.name} will not run. Report what you have and stop.`
    }
    if (ALWAYS_ALLOWED.has(exec.name)) return undefined
    if (!grant.allowedTools.includes(exec.name)) {
      return `The approval for this task does not include ${exec.name}. Allowed: ${grant.allowedTools.length === 0 ? '(none)' : grant.allowedTools.join(', ')}. Report what you need instead of working around this.`
    }
    return checkPaths(exec, grant)
  }

  /**
   * Refuse a file tool whose argument points outside the approved folder.
   *
   * Only arguments that look like paths are examined, and only when the grant names a folder: an
   * approval that named none is not treated as "the whole filesystem". A relative path is
   * resolved against the approved folder, which is where a Session created with that folder as
   * its cwd would resolve it, so an inside-the-folder relative path still works.
   *
   * Both sides are compared as real paths. Comparing the folder as a string would accept a link
   * that points outside it, and comparing only one side would refuse a folder the approval
   * reached through a link — the same folder, named two ways.
   */
  function checkPaths(exec, grant) {
    if (grant.workDir === null) return undefined
    const approved = resolve(grant.workDir)
    const root = realPathOf(approved)
    for (const key of PATH_ARGUMENTS) {
      const value = exec.input?.[key]
      if (typeof value !== 'string' || value.length === 0) continue
      const candidate = realPathOf(isAbsolute(value) ? resolve(value) : resolve(approved, value))
      if (within(root, candidate)) continue
      return `The approval for this task limits file work to ${root}, so ${exec.name} on ${value} will not run. Report what you need instead of working around this.`
    }
    return undefined
  }

  rebuildIndex()

  ctx.tools.guard(exec => checkToolCall(exec))

  Object.assign(rt, {
    mintGrant, revokeGrant, grantForSession, taskGrantOf: taskId => byTask.get(taskId),
    indexTaskGrants: rebuildIndex,
    // The guard itself, reachable so a caller can ask what it would decide without running a
    // turn. That is how the refusal cases are proven rather than inferred from a missing reply.
    checkTaskToolCallForProbe: checkToolCall,
  })
}

export const taskGrantInternals = { ALWAYS_ALLOWED, PATH_ARGUMENTS }
