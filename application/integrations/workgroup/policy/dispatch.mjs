// Dispatch: accepting a Hub grant and turning it into a local Task Session.
//
// This is the one place where a message from the network can lead to something running, so it is
// written as a sequence of refusals rather than a sequence of steps. Nothing here trusts the Hub to
// have checked anything: each fact the local side needs is either verified against the Hub again or
// established locally. A trustworthy Hub is not an assumption this file can afford to make, because
// the failure it would produce is a colleague's Bot running with someone else's authority.
//
// The order is deliberate and each step has its own refusal:
//
//   1. **The device must be the one the grant was minted for.** The Hub enforces this too, but the
//      grant arrives over a socket, and a frame that arrived on this machine is not by itself
//      evidence that this machine is the intended executor.
//   2. **The nonce is presented exactly once.** Presenting it is what marks the grant consumed, so a
//      replayed frame must be stopped before that call, or a second dispatch would start beside the
//      first.
//   3. **The scope must name a directory that is real, absolute, and inside the approved root.**
//      Not a default, not the team folder: a grant without a usable directory is refused. The
//      requirement is explicit that an invalid directory must fail rather than fall back.
//   4. **The task must be approved and not revoked at the moment of use.** The Hub's answer to
//      `consume` carries the scope it granted; a cancellation since then changes the revocation
//      version, and the local grant records the version it was minted at.
//
// What this module does not do is run anything. It returns a *decision*, and the caller is the
// component that opens a Session. Keeping that split means the acceptance rules can be tested
// without a Session, a model, or a process.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

/** Why a dispatch was refused. Each code tells the employee something different to do. */
export const DISPATCH_REFUSALS = Object.freeze({
  NOT_FOR_THIS_DEVICE: 'NOT_FOR_THIS_DEVICE',
  MALFORMED_GRANT: 'MALFORMED_GRANT',
  ALREADY_USED: 'ALREADY_USED',
  UNUSABLE_DIRECTORY: 'UNUSABLE_DIRECTORY',
  DIRECTORY_OUTSIDE_ROOT: 'DIRECTORY_OUTSIDE_ROOT',
  REVOKED: 'REVOKED',
  TRAFFIC_FROM_HUB_FAILED: 'TRAFFIC_FROM_HUB_FAILED',
  BOT_MISMATCH: 'BOT_MISMATCH',
  /**
   * A grant that named no directory at all. Separate from `UNUSABLE_DIRECTORY` because the fix is
   * different: one asks the owner to approve a directory, the other asks them to fix the path.
   */
  NO_DIRECTORY_APPROVED: 'NO_DIRECTORY_APPROVED',
})

export class DispatchRefused extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'DispatchRefused'
    this.code = code
    this.detail = detail
  }
}

/**
 * Resolve and validate the directory a dispatch will work in.
 *
 * The checks, and why each one is here rather than left to the filesystem:
 *
 *   * **absolute** — a relative path would resolve against whatever the process happened to be
 *     started in, which differs between an employee's launch and a service's.
 *   * **exists and is a directory** — a grant naming a folder that is gone must fail. Creating it
 *     would be inventing a workspace the owner never approved.
 *   * **realpath inside the root** — the check runs on the *resolved* path, so a symlink inside the
 *     root that points outside it is caught. Comparing the unresolved string would pass it through,
 *     which is the escape this requirement names.
 *   * **not a filesystem root** — `/` (or `C:\`) is never a task directory. Accepting it would make
 *     every other check meaningless.
 *
 * @returns {{ workDir: string, realPath: string }}
 * @throws {DispatchRefused}
 */
export function resolveTaskDirectory(candidate, { root } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new DispatchRefused(
      'This task was approved with no working directory, so it cannot be started here. Ask the owner to approve one.',
      DISPATCH_REFUSALS.NO_DIRECTORY_APPROVED,
    )
  }
  if (!isAbsolute(candidate)) {
    throw new DispatchRefused(
      `The approved working directory must be an absolute path, got ${JSON.stringify(candidate)}.`,
      DISPATCH_REFUSALS.UNUSABLE_DIRECTORY,
      { candidate },
    )
  }
  if (!existsSync(candidate)) {
    throw new DispatchRefused(`The approved working directory does not exist: ${candidate}`, DISPATCH_REFUSALS.UNUSABLE_DIRECTORY, { candidate })
  }
  let stats
  try {
    stats = statSync(candidate)
  } catch (error) {
    throw new DispatchRefused(`The approved working directory cannot be read: ${candidate} (${error.message})`, DISPATCH_REFUSALS.UNUSABLE_DIRECTORY, { candidate })
  }
  if (!stats.isDirectory()) {
    throw new DispatchRefused(`The approved working directory is not a directory: ${candidate}`, DISPATCH_REFUSALS.UNUSABLE_DIRECTORY, { candidate })
  }
  // A filesystem root is refused before the realpath step, so the message names the real problem
  // rather than reporting the root as "outside itself".
  if (dirname(resolve(candidate)) === resolve(candidate)) {
    throw new DispatchRefused(
      `A filesystem root cannot be a task working directory: ${candidate}`,
      DISPATCH_REFUSALS.UNUSABLE_DIRECTORY,
      { candidate },
    )
  }

  let realPath
  try {
    realPath = realpathSync(candidate)
  } catch (error) {
    // A symlink whose target is gone resolves as an error rather than a path; that is an unusable
    // directory, not a directory outside the root.
    throw new DispatchRefused(`The approved working directory cannot be resolved: ${candidate} (${error.message})`, DISPATCH_REFUSALS.UNUSABLE_DIRECTORY, { candidate })
  }

  if (root !== undefined) {
    const realRoot = realpathSync(root)
    // The comparison is on the *resolved* paths and uses a trailing separator, so `/srv/work-other`
    // is not treated as inside `/srv/work`. A prefix comparison without the separator is the classic
    // way this check passes a sibling directory.
    const inside = realPath === realRoot || realPath.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)
    if (!inside) {
      throw new DispatchRefused(
        `The approved working directory resolves outside the permitted root: ${realPath} is not inside ${realRoot}`,
        DISPATCH_REFUSALS.DIRECTORY_OUTSIDE_ROOT,
        { candidate, realPath, root: realRoot },
      )
    }
  }
  return { workDir: resolve(candidate), realPath }
}

/**
 * Accept a dispatch, or refuse it.
 *
 * @param {{
 *   grant: { nonce?: string, taskId?: string, botId?: string | null },
 *   deviceId: string,
 *   mintedForDeviceId: string,
 *   task: { id: string, state: string, revocationVersion: number, assignedBotId?: string | null },
 *   approvedRevocationVersion: number,
 *   scope: { workDir?: string, tools?: string[], assignedBotId?: string },
 *   root?: string,
 *   consume: (nonce: string, taskId: string) => Promise<{ scope: object, botId: string | null }>,
 * }} input
 * @returns {Promise<{ workDir: string, realPath: string, tools: string[], botId: string | null, taskId: string }>}
 * @throws {DispatchRefused}
 */
export async function acceptDispatch(input) {
  const { grant, deviceId, mintedForDeviceId, task, approvedRevocationVersion, scope, root, consume } = input

  if (grant === null || typeof grant !== 'object') {
    throw new DispatchRefused('A dispatch needs a grant', DISPATCH_REFUSALS.MALFORMED_GRANT)
  }
  if (typeof grant.nonce !== 'string' || grant.nonce.length === 0) {
    throw new DispatchRefused('A dispatch grant needs its nonce', DISPATCH_REFUSALS.MALFORMED_GRANT)
  }
  if (typeof grant.taskId !== 'string' || grant.taskId.length === 0) {
    throw new DispatchRefused('A dispatch grant must name its task', DISPATCH_REFUSALS.MALFORMED_GRANT)
  }
  if (typeof deviceId !== 'string' || typeof mintedForDeviceId !== 'string' || deviceId !== mintedForDeviceId) {
    // Checked before presenting the nonce: a frame for another device must not consume this device's
    // grant, because consuming it would burn the credential the real executor still needs.
    throw new DispatchRefused(
      'This dispatch was minted for a different device, so this machine must not use it.',
      DISPATCH_REFUSALS.NOT_FOR_THIS_DEVICE,
      { deviceId, mintedForDeviceId },
    )
  }
  if (task === null || typeof task !== 'object' || task.id !== grant.taskId) {
    throw new DispatchRefused('The dispatch does not match the task it names', DISPATCH_REFUSALS.MALFORMED_GRANT)
  }
  if (typeof approvedRevocationVersion === 'number' && task.revocationVersion !== approvedRevocationVersion) {
    // The local record of what was approved is checked before the Hub is asked, so a cancellation
    // already known locally never reaches the network.
    throw new DispatchRefused(
      'This task was cancelled or changed after it was approved, so its grant is no longer valid.',
      DISPATCH_REFUSALS.REVOKED,
      { expected: approvedRevocationVersion, actual: task.revocationVersion },
    )
  }
  if (task.state !== 'APPROVED' && task.state !== 'QUEUED') {
    throw new DispatchRefused(
      `This task is ${task.state}, so it cannot be dispatched. Only an approved task may start.`,
      DISPATCH_REFUSALS.REVOKED,
      { state: task.state },
    )
  }
  if (grant.botId !== undefined && grant.botId !== null && task.assignedBotId !== undefined && task.assignedBotId !== null && grant.botId !== task.assignedBotId) {
    // The grant names the Bot the approval chose. A grant for another Bot must not start this task,
    // or the approval's choice of Bot would be advisory rather than binding.
    throw new DispatchRefused(
      `This grant is for Bot ${grant.botId}, but the task was approved for ${task.assignedBotId}.`,
      DISPATCH_REFUSALS.BOT_MISMATCH,
      { grantBotId: grant.botId, assignedBotId: task.assignedBotId },
    )
  }

  // The directory is validated **before** consuming, so a dispatch that cannot run does not burn
  // the credential: the owner can fix the directory and the same grant is still usable.
  const { workDir, realPath } = resolveTaskDirectory(scope?.workDir, { root })

  const consumed = await consume(grant.nonce, grant.taskId)
  if (consumed === null || typeof consumed !== 'object') {
    throw new DispatchRefused('The Hub did not confirm the dispatch', DISPATCH_REFUSALS.TRAFFIC_FROM_HUB_FAILED)
  }

  return {
    taskId: grant.taskId,
    botId: consumed.botId ?? grant.botId ?? null,
    workDir,
    realPath,
    // The scope the Hub recorded is authoritative, and the local one is only a fallback for a Hub
    // response that omitted it. An empty list is kept as empty rather than widened: "no tools
    // approved" is a refusal of everything, not a permission for anything.
    tools: Array.isArray(consumed.scope?.tools) ? [...consumed.scope.tools] : (Array.isArray(scope?.tools) ? [...scope.tools] : []),
  }
}

/**
 * The work directory for a task Session, as the executor must use it.
 *
 * A named function so there is exactly one path from "the owner approved a folder" to "the Session
 * was opened there", and so that path is testable without a Session.
 *
 * @returns {{ workDir: string, realPath: string }}
 */
export function sessionWorkDirFor({ scope, root }) {
  return resolveTaskDirectory(scope?.workDir, { root })
}
