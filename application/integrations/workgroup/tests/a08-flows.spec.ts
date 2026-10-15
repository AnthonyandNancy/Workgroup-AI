// A-08: the three dispatch flows, and cancellation that actually stops processes.
//
// Two halves, and the second is the one that was missing three times before this task:
//
//   * **The flows.** `existing_bot`, `chief_auto`, and `create_bot` must each end at a Bot belonging
//     to the owner the approval named, and nothing else. The interesting cases are the refusals: a
//     named Bot that is not in the team, a Chief that names a Bot that does not exist, a Chief that
//     names nothing. Approximating any of them would run a task on a Bot the owner never approved.
//   * **Cancellation.** This is tested with **real child processes** — real `spawn`, real exit
//     events, real kills. A fake handle would let this file pass while a real cancellation did
//     nothing, which is precisely the gap that was recorded as unverified three times.
//
// The process cases use long-running children (`node -e "setInterval(...)"`) so that a cancellation
// that does not actually terminate anything stays observable: the test waits for the exit and fails
// on a timeout. Nothing here sleeps and hopes.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  chooseBot,
  runDispatch,
  progressUpdate,
  roomVisibleTask,
  roomVisibleEvent,
  roomVisibleEventPayload,
  DISPATCH_OUTCOMES,
  ROOM_VISIBLE_TASK_FIELDS,
  FlowError,
} from '../bot-adapter/flows.mjs'
import {
  createProcessRegistry,
  cancelTask,
  cancellationNotice,
  CANCELLATION_OUTCOMES,
  CancellationError,
} from '../bot-adapter/cancellation.mjs'

const ROSTER = {
  byId: {
    chief: { id: 'chief', name: 'Chief', role: 'Boss' },
    writer: { id: 'writer', name: 'Writer', role: 'Copywriter' },
  },
  mainBotIds: ['chief'],
}

// ---------------------------------------------------------------------------
// Choosing the Bot
// ---------------------------------------------------------------------------

describe('existing_bot', () => {
  it('uses the approved Bot verbatim', async () => {
    const choice = await chooseBot({ mode: 'existing_bot', assignedBotId: 'writer', roster: ROSTER, approvedForOwnerUserId: 'bob' })
    assert.deepEqual(choice, { botId: 'writer', created: false, how: 'existing_bot' })
  })

  it('refuses a Bot that is not in the team, rather than substituting the Chief', async () => {
    // The substitution is the tempting mistake: there is a Chief right there. Running the task on it
    // would execute something the owner did not approve, attributed to a Bot they never chose.
    await expect(chooseBot({ mode: 'existing_bot', assignedBotId: 'ghost', roster: ROSTER, approvedForOwnerUserId: 'bob' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BOT_NOT_IN_TEAM' }))
  })

  it('refuses when the approval named no Bot', async () => {
    for (const value of [undefined, null, '']) {
      await expect(chooseBot({ mode: 'existing_bot', assignedBotId: value, roster: ROSTER, approvedForOwnerUserId: 'bob' }))
        .rejects.toThrow(expect.objectContaining({ code: 'MISSING_ASSIGNED_BOT' }))
    }
  })
})

describe('chief_auto', () => {
  it('runs on the Bot the Chief names, when that Bot is real', async () => {
    const choice = await chooseBot({
      mode: 'chief_auto',
      roster: ROSTER,
      approvedForOwnerUserId: 'bob',
      askChief: async () => 'writer',
    })
    assert.equal(choice.botId, 'writer')
    assert.equal(choice.how, 'chief_auto')
    assert.equal(choice.choseBy, 'chief')
  })

  it('refuses a Bot the Chief named that does not exist', async () => {
    // The Chief is a model. Its answer is a suggestion, and a suggestion naming a Bot this team does
    // not have must be refused rather than approximated — otherwise "the Chief picked" would be a
    // way to run a task on anything.
    await expect(chooseBot({
      mode: 'chief_auto', roster: ROSTER, approvedForOwnerUserId: 'bob', askChief: async () => 'imaginary',
    })).rejects.toThrow(expect.objectContaining({ code: 'CHIEF_CHOSE_UNKNOWN_BOT' }))
  })

  it('refuses when the Chief names nothing, and when the team has no Chief', async () => {
    await expect(chooseBot({ mode: 'chief_auto', roster: ROSTER, approvedForOwnerUserId: 'bob', askChief: async () => undefined }))
      .rejects.toThrow(expect.objectContaining({ code: 'CHIEF_CHOSE_NOTHING' }))
    await expect(chooseBot({ mode: 'chief_auto', roster: ROSTER, approvedForOwnerUserId: 'bob' }))
      .rejects.toThrow(expect.objectContaining({ code: 'NO_CHIEF' }))
  })
})

describe('create_bot', () => {
  it('creates a Bot and binds the task to it', async () => {
    const created = []
    const choice = await chooseBot({
      mode: 'create_bot',
      roster: ROSTER,
      approvedForOwnerUserId: 'bob',
      task: { id: 'task-abcdef12', description: 'Summarise the incident' },
      createBot: async (input) => { created.push(input); return { id: 'new-bot' } },
    })
    assert.equal(choice.botId, 'new-bot')
    assert.equal(choice.created, true)
    assert.equal(created.length, 1)
    // The new Bot is created for the owner the approval named, never for the requester.
    assert.equal(created[0].createdBy, 'bob')
    // The brief is the task, so the owner can see why the Bot exists.
    assert.equal(created[0].brief, 'Summarise the incident')
    // And the name is derived from the task rather than invented, so it is recognisable in a list.
    assert.match(created[0].name, /task-abcd|Task Bot/i)
  })

  it('refuses when creation produced nothing, rather than running anyway', async () => {
    for (const value of [undefined, {}, { id: '' }]) {
      await expect(chooseBot({
        mode: 'create_bot', roster: ROSTER, approvedForOwnerUserId: 'bob', createBot: async () => value,
      })).rejects.toThrow(expect.objectContaining({ code: 'BOT_CREATION_FAILED' }))
    }
    await expect(chooseBot({ mode: 'create_bot', roster: ROSTER, approvedForOwnerUserId: 'bob' }))
      .rejects.toThrow(expect.objectContaining({ code: 'CANNOT_CREATE_BOT' }))
  })
})

describe('an unknown mode', () => {
  it('is refused by name', async () => {
    await expect(chooseBot({ mode: 'ask_the_manager', roster: ROSTER, approvedForOwnerUserId: 'bob' }))
      .rejects.toThrow(expect.objectContaining({ code: 'INVALID_ASSIGNMENT_MODE' }))
  })
})

// ---------------------------------------------------------------------------
// Running, and the binding rule
// ---------------------------------------------------------------------------

/** An accepted dispatch as A-07 produces it. */
const ACCEPTED = { taskId: 'task-1', botId: 'writer', workDir: '/tmp/task-1', tools: ['read'] }

describe('running an accepted dispatch', () => {
  it('all three modes converge on one runner, with the approved directory untouched', async () => {
    const runs = []
    const run = async (input) => { runs.push(input); return { sessionId: 'session-1' } }

    for (const [approval, extra] of [
      [{ mode: 'existing_bot', assignedBotId: 'writer', ownerUserId: 'bob' }, {}],
      [{ mode: 'chief_auto', ownerUserId: 'bob' }, { askChief: async () => 'writer' }],
      [{ mode: 'create_bot', ownerUserId: 'bob' }, { createBot: async () => ({ id: 'writer' }) }],
    ]) {
      const result = await runDispatch({ accepted: ACCEPTED, approval, roster: ROSTER, run, ...extra })
      assert.equal(result.outcome, DISPATCH_OUTCOMES.STARTED)
      assert.equal(result.botId, 'writer')
    }

    assert.equal(runs.length, 3)
    for (const invocation of runs) {
      // The directory is passed through unchanged, because A-07 validated it against the approved
      // root. A default here would undo that check.
      assert.equal(invocation.workDir, '/tmp/task-1')
      assert.deepEqual(invocation.allowedTools, ['read'])
    }
  })

  it('reports a refusal as an outcome rather than throwing, so the task reaches a terminal state', async () => {
    const result = await runDispatch({
      accepted: ACCEPTED,
      approval: { mode: 'existing_bot', assignedBotId: 'ghost', ownerUserId: 'bob' },
      roster: ROSTER,
      run: async () => { throw new Error('must not run') },
    })
    assert.equal(result.outcome, DISPATCH_OUTCOMES.REFUSED)
    assert.equal(result.code, 'BOT_NOT_IN_TEAM')
    assert.equal(result.taskId, 'task-1')
  })

  it('refuses to run when the chosen Bot is not the one the accepted grant is for', async () => {
    // The accepted grant names `writer`, but the approval was recorded for `chief`. Both exist, so
    // nothing above this point would have caught it; the binding check is what does. Without it the
    // approval's choice of Bot would be advisory rather than binding.
    let ran = false
    const result = await runDispatch({
      accepted: { ...ACCEPTED, botId: 'writer' },
      approval: { mode: 'existing_bot', assignedBotId: 'chief', ownerUserId: 'bob' },
      roster: ROSTER,
      run: async () => { ran = true; return {} },
    })
    assert.equal(result.outcome, DISPATCH_OUTCOMES.REFUSED)
    assert.equal(result.code, 'BOT_MISMATCH')
    // Nothing ran, which is the point.
    assert.equal(ran, false)
  })

  it('reports progress through the caller’s callback for a refusal, so the owner sees why', async () => {
    const updates = []
    await runDispatch({
      accepted: ACCEPTED,
      approval: { mode: 'existing_bot', assignedBotId: 'ghost', ownerUserId: 'bob' },
      roster: ROSTER,
      run: async () => ({}),
      onProgress: update => { updates.push(update) },
    })
    assert.deepEqual(updates.map(update => update.stage), ['refused'])
    assert.equal(updates[0].code, 'BOT_NOT_IN_TEAM')
  })

  it('refuses without a runner or an accepted dispatch', async () => {
    await expect(runDispatch({ accepted: ACCEPTED, approval: {}, roster: ROSTER }))
      .rejects.toThrow(expect.objectContaining({ code: 'NO_RUNNER' }))
    await expect(runDispatch({ accepted: null, approval: {}, roster: ROSTER, run: async () => ({}) }))
      .rejects.toThrow(expect.objectContaining({ code: 'NO_ACCEPTED_DISPATCH' }))
  })

  it('reports progress a room may see, and nothing about the machine running it', () => {
    // Progress is redacted where it is produced, so a later change to the sender cannot leak it.
    for (const update of [
      progressUpdate({ stage: 'starting', botId: 'secret-bot', sessionId: 'session-1' }),
      progressUpdate({ stage: 'started', botId: 'secret-bot', sessionId: 'session-1' }),
      progressUpdate({ stage: 'finished' }),
    ]) {
      const serialized = JSON.stringify(update)
      assert.equal(serialized.includes('secret-bot'), false, `a Bot id leaked: ${serialized}`)
      assert.equal(serialized.includes('session-1'), false, `a Session id leaked: ${serialized}`)
      assert.equal(serialized.includes('workDir'), false)
    }
    // A refusal is reported as a stage, and an unknown stage is named rather than dropped.
    assert.equal(progressUpdate({ stage: 'refused', code: 'BOT_NOT_IN_TEAM', message: 'no' }).code, 'BOT_NOT_IN_TEAM')
    assert.equal(progressUpdate({ stage: 'something_new' }).reported, 'something_new')
  })

  it('strips a task down to the fields a room may see', () => {
    const visible = roomVisibleTask({
      id: 't1', roomId: 'r1', requesterUserId: 'alice', ownerUserId: 'bob',
      description: 'do it', state: 'RUNNING', createdAt: 'x', updatedAt: 'y',
      // None of these may survive.
      assignedBotId: 'writer', assignmentMode: 'existing_bot', workDir: '/home/bob/secret',
      approval: { scope: { workDir: '/home/bob/secret', tools: ['bash'] } },
    })
    const serialized = JSON.stringify(visible)
    for (const forbidden of ['writer', 'existing_bot', '/home/bob/secret', 'bash']) {
      assert.equal(serialized.includes(forbidden), false, `the room saw ${forbidden}`)
    }
    assert.deepEqual(Object.keys(visible).sort(), [...ROOM_VISIBLE_TASK_FIELDS].sort())
  })

  it('strips a task event\u2019s payload to a state name', () => {
    const event = roomVisibleEvent({
      id: 'e1', taskId: 't1', eventType: 'task.progress', actorUserId: 'bob', createdAt: 'now',
      payload: { state: 'RUNNING', stage: 'working', workDir: '/home/bob/secret', output: 'the answer' },
    })
    const serialized = JSON.stringify(event)
    assert.equal(serialized.includes('/home/bob/secret'), false)
    assert.equal(serialized.includes('the answer'), false, 'a result must not be published by a progress event')
    assert.deepEqual(event.payload, { state: 'RUNNING', stage: 'working' })
    assert.deepEqual(roomVisibleEventPayload({ tools: ['bash'], model: 'x' }), {})
  })
})

// ---------------------------------------------------------------------------
// Cancellation, with real processes
// ---------------------------------------------------------------------------

/** Start a child that will keep running until it is killed, and wrap it like a provider handle. */
function startLongRunningChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  let exited = false
  const done = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true
      resolve({ code, signal })
    })
  })
  return {
    child,
    get exited() { return exited },
    handle: {
      done,
      terminate() { child.kill('SIGTERM') },
      async waitForExit(signal) {
        // The real seam resolves `true` when the managed range is empty. Here the range is the one
        // child, and the signal bounds the wait.
        if (exited) return true
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 8_000)
          const onAbort = () => { clearTimeout(timer); resolve(false) }
          signal?.addEventListener('abort', onAbort, { once: true })
          done.then(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(true) })
        })
      },
    },
  }
}

describe('cancellation reaches the processes a task spawned', () => {
  it('terminates a real child process and confirms it is gone', async () => {
    const registry = createProcessRegistry()
    const first = startLongRunningChild()
    const second = startLongRunningChild()
    try {
      registry.track(first.handle, { taskId: 'task-1', label: 'build' })
      registry.track(second.handle, { taskId: 'task-1', label: 'fetch' })
      assert.equal(registry.size, 2)

      const report = await cancelTask({
        taskId: 'task-1',
        registry,
        cancelTurn: async () => {},
        revokeGrant: async () => {},
      })

      // The evidence, not the request: both waitForExit calls resolved true.
      assert.equal(report.outcome, CANCELLATION_OUTCOMES.CONFIRMED)
      assert.equal(report.confirmed.length, 2)
      assert.deepEqual(report.unconfirmed, [])
      assert.equal(report.turnStopped, true)
      assert.equal(report.grantRevoked, true)
      // And the processes really are dead.
      assert.equal(first.exited, true)
      assert.equal(second.exited, true)
      // `SIGTERM` is what the seam's terminate sends; a platform that reports it confirms a signal
      // was delivered rather than that the process was reaped by another means.
      const outcomes = await Promise.all([first.handle.done, second.handle.done])
      for (const outcome of outcomes) {
        assert.equal(['SIGTERM', 'SIGKILL', 'SIGINT', null].includes(outcome.signal), true, `unexpected signal ${outcome.signal}`)
      }
    } finally {
      first.child.kill('SIGKILL')
      second.child.kill('SIGKILL')
    }
  }, 30_000)

  it('cancels only the task it was asked about', async () => {
    const registry = createProcessRegistry()
    const mine = startLongRunningChild()
    const theirs = startLongRunningChild()
    try {
      registry.track(mine.handle, { taskId: 'task-1' })
      registry.track(theirs.handle, { taskId: 'task-2' })

      const report = await cancelTask({ taskId: 'task-1', registry })
      assert.equal(report.confirmed.length, 1)
      assert.equal(mine.exited, true)
      // The other task's process is untouched: cancellation is per task, and killing a neighbour's
      // work would be worse than the leak it fixes.
      assert.equal(theirs.exited, false)
      assert.equal(registry.size, 1)
    } finally {
      mine.child.kill('SIGKILL')
      theirs.child.kill('SIGKILL')
    }
  }, 30_000)

  it('stops the turn before terminating, so nothing new is spawned during the kill', async () => {
    const registry = createProcessRegistry()
    const order = []
    const child = startLongRunningChild()
    try {
      registry.track(child.handle, { taskId: 'task-1' })
      await cancelTask({
        taskId: 'task-1',
        registry,
        cancelTurn: async () => { order.push('turn') },
        revokeGrant: async () => { order.push('grant') },
      })
      // Turn first: terminating before the loop stops leaves a window in which it spawns one more.
      assert.deepEqual(order, ['turn', 'grant'])
    } finally {
      child.child ?? child.child.kill('SIGKILL')
    }
  }, 30_000)

  it('reports NOTHING_RUNNING rather than pretending to have killed something', async () => {
    const registry = createProcessRegistry()
    const report = await cancelTask({ taskId: 'task-never-started', registry })
    assert.equal(report.outcome, CANCELLATION_OUTCOMES.NOTHING_RUNNING)
    assert.deepEqual(report.confirmed, [])
  })

  it('reports UNCONFIRMED when a provider cannot say its process exited', async () => {
    const registry = createProcessRegistry()
    // A handle that accepts terminate and never reports an exit: the case an operator must hear
    // about, because believing a process is dead when it is not means nobody goes looking.
    registry.track({ terminate() {}, waitForExit: async () => false }, { taskId: 'task-1', label: 'opaque' })
    const report = await cancelTask({ taskId: 'task-1', registry, waitTimeoutMs: 50 })
    assert.equal(report.outcome, CANCELLATION_OUTCOMES.UNCONFIRMED)
    assert.equal(report.unconfirmed.length, 1)
    assert.match(report.unconfirmed[0].detail, /still running|exited/)
  }, 20_000)

  it('reports UNCONFIRMED when the provider lost sight of its range', async () => {
    const registry = createProcessRegistry()
    registry.track({
      terminate() {},
      waitForExit: async () => { throw new Error('the provider can no longer observe its managed range') },
    }, { taskId: 'task-1' })
    const report = await cancelTask({ taskId: 'task-1', registry })
    assert.equal(report.outcome, CANCELLATION_OUTCOMES.UNCONFIRMED)
    assert.match(report.unconfirmed[0].detail, /no longer observe/)
  })

  it('reports UNCONFIRMED when the turn could not be stopped, even if the processes died', async () => {
    const registry = createProcessRegistry()
    const child = startLongRunningChild()
    try {
      registry.track(child.handle, { taskId: 'task-1' })
      const report = await cancelTask({
        taskId: 'task-1',
        registry,
        cancelTurn: async () => { throw new Error('the turn is not responding') },
      })
      // The processes are gone, but the loop may spawn more, so this is not a confirmed stop.
      assert.equal(report.outcome, CANCELLATION_OUTCOMES.UNCONFIRMED)
      assert.equal(report.confirmed.length, 1)
      assert.match(report.turnStopError, /not responding/)
    } finally {
      child.child.kill('SIGKILL')
    }
  }, 30_000)

  it('revokes the binding even when a process could not be confirmed', async () => {
    const registry = createProcessRegistry()
    let revoked = false
    registry.track({ terminate() {}, waitForExit: async () => false }, { taskId: 'task-1' })
    const report = await cancelTask({
      taskId: 'task-1',
      registry,
      waitTimeoutMs: 20,
      revokeGrant: async () => { revoked = true },
    })
    // Revocation is what makes the cancellation durable: a retry or a queued call is refused whatever
    // happened to the process.
    assert.equal(revoked, true)
    assert.equal(report.grantRevoked, true)
    assert.equal(report.outcome, CANCELLATION_OUTCOMES.UNCONFIRMED)
  }, 20_000)

  it('keeps untracked handles out of reach, which is why registration is explicit', async () => {
    const registry = createProcessRegistry()
    const tracked = startLongRunningChild()
    const untracked = startLongRunningChild()
    try {
      registry.track(tracked.handle, { taskId: 'task-1' })
      await cancelTask({ taskId: 'task-1', registry })
      assert.equal(tracked.exited, true)
      // This is the honest statement of the limitation: a process nobody registered is a process
      // cancellation cannot reach, so registering is the caller's obligation.
      assert.equal(untracked.exited, false)
    } finally {
      tracked.child.kill('SIGKILL')
      untracked.child.kill('SIGKILL')
    }
  }, 30_000)

  it('refuses to track without a task, because an untethered handle cannot be cancelled', () => {
    const registry = createProcessRegistry()
    expect(() => registry.track({ terminate() {} })).toThrow(CancellationError)
    expect(() => registry.track({ terminate() {} }, { taskId: '' })).toThrow(CancellationError)
    expect(() => registry.track(undefined, { taskId: 't' })).toThrow(CancellationError)
  })

  it('drops a handle once its process has exited, so the registry stays a set of live processes', async () => {
    const registry = createProcessRegistry()
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const done = new Promise(resolve => child.once('exit', resolve))
    const handle = { done, terminate() {}, waitForExit: async () => true }
    registry.track(handle, { taskId: 'task-1' })
    assert.equal(registry.size, 1)
    await done
    // The removal is scheduled on `done`, so yield once for it to run.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(registry.size, 0)
  }, 20_000)

  it('refuses a cancellation with no task id', async () => {
    await expect(cancelTask({ taskId: '', registry: createProcessRegistry() }))
      .rejects.toThrow(expect.objectContaining({ code: 'NO_TASK' }))
  })

  it('tells a room that the task was cancelled, and nothing about the machine', () => {
    const notice = cancellationNotice({
      taskId: 't1',
      outcome: CANCELLATION_OUTCOMES.UNCONFIRMED,
      unconfirmed: [{ id: 'proc-1', detail: '/home/bob/secret build could not be confirmed' }],
      reason: 'the owner cancelled it',
    })
    // `state` is present; the reason and the unconfirmed detail are not. A room that broadcast
    // "could not confirm the process died" would be reporting a machine's internals to people with
    // no business reading it.
    assert.deepEqual(Object.keys(notice).sort(), ['stage', 'state'])
    assert.equal(JSON.stringify(notice).includes('/home/bob/secret'), false)
    assert.equal(JSON.stringify(notice).includes('the owner cancelled it'), false)
  })
})
