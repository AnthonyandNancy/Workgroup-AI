import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// F-13: what one approved task may do, checked before every tool call.
//
// The completion condition is "an over-reach is refused, a revocation stops the work". Both are
// negative properties, so the cases below drive the guard directly and assert the refusal text,
// which is what the model would read. A test that only checked "the call did not happen" would
// pass even if the guard refused for the wrong reason.

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: 'Write the copy.', createdAt: 2 },
  },
  rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
}

function bench({ team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-grant-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const guards = []
  const cancelled = []
  const ctx = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'standard' }] } } })
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'ws-1' }), archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'task-session-1' }),
      resolveAgent: async sessionId => ({
        agent: { id: sessionId, cancel: info => { cancelled.push({ sessionId, info }) } },
        session: { id: sessionId },
      }),
    },
  })
  // `fakeContext.tools.guard` records the guard; the bench calls it as the runtime would.
  const rt = createRuntime(ctx, { home })
  for (const guard of ctx.guards) guards.push(guard)
  return { home, ctx, rt, guards, cancelled, cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

/** A task Session with a grant naming exactly what the approval allowed. */
async function taskWithGrant(b, { allowedTools = ['read_file', 'write_file'], allowedHosts, workDir, expiresAt, revocationVersion = 0 } = {}) {
  await b.rt.load()
  const binding = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)
  const grant = await b.rt.mintGrant({
    taskId: 'task-1', sessionId: binding.sessionId, botId: 'b2',
    allowedTools, allowedHosts, workDir, expiresAt, revocationVersion,
  })
  return { binding, grant }
}

const call = (sessionId, name, input = {}) => ({ agent: { id: sessionId }, name, input })

test('a tool the approval did not name is refused, and the refusal names what is allowed', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file'] })

  // Allowed: no refusal.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'a.txt' })), undefined)

  // Refused, and the message tells the model the limits so it can report rather than retry.
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'bash', { command: 'rm -rf /' }))
  assert.match(refusal, /does not include bash/)
  assert.match(refusal, /Allowed: read_file/)
  assert.match(refusal, /Report what you need instead of working around this/)
})

test('an approval that names no tools grants none, because silence is not permission', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: [] })
  // `bash` is the case that matters: a Bot owns it, but this task was not granted it.
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'bash', { command: 'echo hi' }))
  assert.match(refusal, /does not include bash/)
  assert.match(refusal, /Allowed: \(none\)/)
})

test('the reporting tools stay available, so a refused Bot can still tell the owner', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: [] })
  // A task that cannot report its own refusal is a task that fails silently.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'ask_user', {})), undefined)
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'present', {})), undefined)
})

test('a tool call outside the approved folder is refused, and the refusal names the folder', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const approved = resolve('D:/finance')
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file', 'write_file'], workDir: approved })

  // Inside the folder, and a relative path that resolves inside it.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'D:/finance/q4.csv' })), undefined)
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'q4.csv' })), undefined)
  // The folder itself is inside itself.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: approved })), undefined)

  // Outside: another volume, a parent, and a sibling with a shared prefix.
  for (const outside of ['D:/private/secret.txt', 'D:/q4.csv', resolve('D:/'), `${approved}/../private/secret.txt`]) {
    const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: outside }))
    assert.match(String(refusal), /limits file work to/, `${outside} must be refused`)
  }
})

test('a task with no approved folder is not treated as owning the filesystem', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  // No `workDir`: the folder rule does not apply, but the tool allow-list still does.
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file'] })
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'D:/anywhere/x.txt' })), undefined)
  assert.match(String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'bash', {}))), /does not include bash/)
})

// The folder rule cannot be a string comparison: a link *inside* the approved folder points
// anywhere, and its path still starts with the folder. These cases build real links on the real
// filesystem, because that is the only way to show the difference — a fake path cannot have a
// link. `junction` is what Windows grants an unprivileged process; POSIX ignores the type
// argument, so the same cases run unchanged there.
const linkDirectory = (target, path) => {
  try { symlinkSync(target, path, 'junction'); return true } catch (error) {
    // A host without Developer Mode, or a filesystem that refuses links outright, cannot run
    // these cases; the caller skips rather than asserting a property it never exercised.
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS') return false
    throw error
  }
}

test('a link inside the approved folder that points outside it is refused', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-guard-link-'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  const approved = join(base, 'approved')
  const outside = join(base, 'outside')
  mkdirSync(approved)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'not for this task')
  if (!linkDirectory(outside, join(approved, 'escape'))) {
    t.skip('this host refuses to create directory links')
    return
  }

  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file', 'write_file'], workDir: approved })
  // The link's own path starts with the folder, so the lexical answer is "inside"; the real path
  // is the outside directory, and that is the answer that counts.
  assert.match(
    String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(approved, 'escape', 'secret.txt') }))),
    /limits file work to/,
  )
  // A write through the same link is refused too: reading is not the only direction that leaks.
  assert.match(
    String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'write_file', { path: join(approved, 'escape', 'new.txt') }))),
    /limits file work to/,
  )
  // The link itself, not only a path through it.
  assert.match(
    String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(approved, 'escape') }))),
    /limits file work to/,
  )
  // A real file inside the folder still passes, so the rule did not become "refuse everything".
  writeFileSync(join(approved, 'q4.csv'), 'ok')
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(approved, 'q4.csv') })), undefined)
  // A not-yet-existing path inside the folder stays allowed: the target of a legitimate write
  // usually does not exist yet, and refusing those would refuse the work itself.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'write_file', { path: join(approved, 'sub', 'draft.md') })), undefined)
})

test('an approved folder reached through a link is judged by its real location', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const base = mkdtempSync(join(tmpdir(), 'ds-bot-guard-root-link-'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }))
  const real = join(base, 'real')
  mkdirSync(real)
  writeFileSync(join(real, 'inside.txt'), 'ok')
  if (!linkDirectory(real, join(base, 'approved-link'))) {
    t.skip('this host refuses to create directory links')
    return
  }

  // The grant names the link, so the folder it really is has to be the boundary: otherwise a
  // file reached by its real location would be judged outside a folder that contains it.
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file'], workDir: join(base, 'approved-link') })
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(base, 'approved-link', 'inside.txt') })), undefined)
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(real, 'inside.txt') })), undefined)
  assert.match(
    String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: join(base, 'elsewhere.txt') }))),
    /limits file work to/,
  )
})

test('a revoked grant refuses every later call, and the refusal says why', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file'] })
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', {})), undefined)

  await b.rt.revokeGrant('task-1', { reason: 'cancelled by the requester' })
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', {}))
  assert.match(refusal, /approval was withdrawn/)
  assert.match(refusal, /cancelled by the requester/)
  // Even the reporting tools stop: a revoked task must not keep talking to the room.
  assert.match(String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'present', {}))), /approval was withdrawn/)
})

test('revoking also stops the running turn, not only the next call', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b)
  await b.rt.revokeGrant('task-1', { reason: 'cancelled' })
  // Marking the grant dead stops the next call; cancelling the Agent stops the turn already
  // running. Without the second half a long step would finish before the refusal was ever read.
  assert.equal(b.cancelled.length, 1)
  assert.equal(b.cancelled[0].sessionId, binding.sessionId)
  assert.match(b.cancelled[0].info.reason, /ds-bot\/task-cancelled/)
})

test('an expired grant refuses calls even though nothing revoked it', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const past = new Date(Date.now() - 60_000).toISOString()
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file'], expiresAt: past })
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', {}))
  assert.match(refusal, /approval expired at/)
  assert.match(refusal, /Report what you have and stop/)
})

test('a grant is bound to its Session, so another Session is unaffected', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: [] })
  // The Bot's own chat is not a task Session: the guard has nothing to say about it, so the
  // owner's own use of their Bot is unchanged.
  assert.equal(b.rt.checkTaskToolCallForProbe(call('b2', 'bash', { command: 'echo hi' })), undefined)
  assert.equal(b.rt.checkTaskToolCallForProbe(call(undefined, 'bash', {})), undefined)
  // And the task Session really is restricted.
  assert.match(String(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'bash', {}))), /does not include bash/)
})

test('the guard is registered with the runtime, so every call passes through it', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()
  // A guard that is never registered would let every case above pass while protecting nothing.
  assert.ok(b.guards.length >= 1, 'the guard must be registered')
})

test('the grant survives a reload, so a restart does not widen a running task', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-grant-reload-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const make = () => {
    const ctx = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'standard' }] } } })
    Object.assign(ctx, {
      workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'ws-1' }), archiveSession: async () => {} },
      sessionTitle: { rename: async () => {} },
      sessionController: {
        create: async () => ({ sessionId: 'task-session-1' }),
        resolveAgent: async sessionId => ({ agent: { id: sessionId, cancel: () => {} }, session: { id: sessionId } }),
      },
    })
    return createRuntime(ctx, { home })
  }

  const first = make()
  await first.load()
  const binding = await first.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await first.rememberTaskSession(binding)
  await first.mintGrant({ taskId: 'task-1', sessionId: binding.sessionId, botId: 'b2', allowedTools: ['read_file'], workDir: resolve('D:/finance') })

  // A restart: the limits a running task is being held to must come back with it.
  const second = make()
  await second.load()
  assert.equal(second.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'D:/finance/x' })), undefined)
  assert.match(String(second.checkTaskToolCallForProbe(call(binding.sessionId, 'bash', {}))), /does not include bash/)
  assert.match(String(second.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'D:/private/x' }))), /limits file work to/)
})

test('a team file from before grants existed gains the record without losing its Bots', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-grant-legacy-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const legacy = { ...TEAM }
  delete legacy.taskGrants
  delete legacy.taskSessions
  writeFileSync(join(home, 'state.json'), JSON.stringify(legacy))

  const ctx = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'standard' }] } } })
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'ws-1' }), archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'task-session-1' }), resolveAgent: async id => ({ agent: { id, cancel: () => {} }, session: { id } }) },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  assert.equal(rt.botOf('b2').name, 'Writer')
  const binding = await rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await rt.rememberTaskSession(binding)
  await rt.mintGrant({ taskId: 'task-1', sessionId: binding.sessionId, botId: 'b2', allowedTools: ['read_file'] })
  assert.match(String(rt.checkTaskToolCallForProbe(call(binding.sessionId, 'write_file', {}))), /does not include write_file/)
})

test('a network tool reaches only an approved host, and refusal is the default', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  // E3: the approval names hosts, not "the network". A task approved for one host must not be able
  // to reach a second one, and a task approved for no host must not reach any.
  const { binding } = await taskWithGrant(b, { allowedTools: ['web_fetch'], allowedHosts: ['internal.corp'] })

  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'web_fetch', { url: 'https://internal.corp/doc' })), undefined)

  // A different host is refused, and the refusal is written for the model to report, not retry.
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'web_fetch', { url: 'https://example.com/doc' }))
  assert.match(refusal, /does not cover example\.com/)
})

test('a lookalike domain does not satisfy an approved host', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: ['web_fetch'], allowedHosts: ['internal.corp'] })
  // The bypass this case exists for: an `endsWith` comparison would approve the attacker's host.
  const refusal = b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'web_fetch', { url: 'https://internal.corp.attacker.example/doc' }))
  assert.match(refusal, /does not cover internal\.corp\.attacker\.example/)
})

test('a task approved for no host reaches none', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  // No `allowedHosts` at all: the dangerous default would be "unrestricted".
  const { binding } = await taskWithGrant(b, { allowedTools: ['web_fetch'] })
  assert.match(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'web_fetch', { url: 'https://internal.corp/doc' })), /does not cover internal\.corp/)
})

test('a non-network tool is unaffected by the host list', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  const { binding } = await taskWithGrant(b, { allowedTools: ['read_file', 'web_fetch'], allowedHosts: ['internal.corp'] })
  // The host rule must not become a second, invisible gate on tools that never open a socket:
  // a task that could read its approved folder before this change must still be able to.
  assert.equal(b.rt.checkTaskToolCallForProbe(call(binding.sessionId, 'read_file', { path: 'a.txt' })), undefined)
})
