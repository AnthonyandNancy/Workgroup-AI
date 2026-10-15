import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A task Session is the isolated Session that speaks for one existing Bot while it does work
// another user asked for. Three properties carry the requirement, and each is checked here:
//
//   identity    the Session carries the Bot's own name, role, and instructions
//   isolation   the Session is not the Bot's chat and does not appear in it
//   persistence the binding survives a reload, because it lives in the team file
//
// The identity is checked through the same path the model sees — `selfOf`, which `prompt.js`
// reads to render "# Your identity" — rather than by comparing a stored copy of the Bot's
// fields, because a copy would pass even if the real path resolved to nothing.

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: 'Run the team.', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: 'Write the report.', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

/** A context that can actually create a Session, and records what it created. */
function bench({ team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-session-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const created = []
  const archived = []
  const renamed = []
  const workspaceRegistry = {
    get: () => undefined,
    resolveByPath: async () => undefined,
    create: async () => ({ id: 'ws-1' }),
    archiveSession: async (id, options) => { archived.push({ id, options }) },
  }
  const sessionController = {
    create: async (options) => {
      const sessionId = `task-session-${created.length + 1}`
      created.push({ sessionId, options })
      return { sessionId }
    },
  }
  const ctx = fakeContext({
    services: {
      agentPresets: { list: async () => [{ id: 'standard' }] },
    },
  })
  // DS Bot reaches these as plain context properties, the way the real composition supplies
  // them: `ctx.sessionController`, `ctx.sessionTitle`, and `ctx.workspaceRegistry`. The optional
  // services (`agentPresets`) come through `ctx.get`, which `fakeContext` answers from `services`.
  Object.assign(ctx, {
    workspaceRegistry,
    sessionTitle: { rename: async (session, title) => { renamed.push({ sessionId: session?.id, title }) } },
    sessionController: {
      ...sessionController,
      resolveAgent: async sessionId => ({ session: { id: sessionId }, agent: { id: sessionId } }),
    },
  })
  const rt = createRuntime(ctx, { home })
  Object.assign(rt, {
    ensureWorkspace: async () => 'ws-1',
    isFolder: async () => true,
  })
  return { home, ctx, rt, created, archived, renamed, cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

test('a task Session carries the Bot\'s own identity, through the path the model sees', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const binding = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)

  // `selfOf` is what `prompt.js` reads to render the Bot's identity section. A task Session that
  // resolved to nothing would be an ordinary agent wearing the Bot's name.
  assert.equal(b.rt.selfOf(binding.sessionId), 'b2')
  assert.equal(b.rt.isBotSession(binding.sessionId), true)
  assert.equal(b.rt.taskSessionOf(binding.sessionId).botId, 'b2')

  // And that answer is enough for the prompt to name the Bot, its role, and its instructions.
  const section = b.ctx.sections.get('bot-identity')
  assert.ok(section !== undefined, 'the identity section must be registered')
  const text = typeof section.text === 'function' ? section.text({ agent: { id: binding.sessionId } }) : section.text
  assert.match(text, /You are Writer/)
  assert.match(text, /Your role: Writing/)
  assert.match(text, /Write the report\./)
})

test('a task Session is not the Bot\'s chat, so the owner\'s own conversation is untouched', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const before = b.rt.chatOf('b2')
  const binding = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)

  // The Bot's own chat still points at its original Session: a task must not read or extend it.
  assert.equal(b.rt.chatOf('b2'), before)
  assert.notEqual(binding.sessionId, before)
  // And the task Session is not addressable as the Bot's chat.
  assert.equal(b.rt.chatOwners.has(binding.sessionId), false)
})

test('a task Session is created with the Bot\'s preset and its own title', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const binding = await b.rt.openTaskSession({ taskId: 'task-abc123', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)

  assert.equal(b.created.length, 1)
  // The same preset a Bot's own Session is made with: a Session keeps the preset it is created
  // with, and the `ptc` preset would turn down the tools a team Session is given.
  assert.equal(b.created[0].options.agentPreset, 'standard')
  // The title names the task, so the owner can tell it apart from the Bot's own chat.
  assert.equal(b.renamed.length, 1)
  assert.match(b.renamed[0].title, /Task task-abc/)
  assert.match(b.renamed[0].title, /Writer/)
})

test('opening the same task twice reuses its Session instead of starting a second one', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const first = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(first)
  const again = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })

  assert.equal(again.sessionId, first.sessionId)
  // Two Sessions for one task would double its memory and could double its side effects.
  assert.equal(b.created.length, 1)
})

test('a task Session refuses to switch Bots, because the approval named one', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const binding = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)
  await assert.rejects(
    () => b.rt.openTaskSession({ taskId: 'task-1', botId: 'm1' }),
    /already bound to Bot b2/,
  )
})

test('a task naming a Bot that does not exist is refused', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()
  await assert.rejects(() => b.rt.openTaskSession({ taskId: 'task-1', botId: 'ghost' }), /no Bot ghost/)
  assert.equal(b.created.length, 0, 'nothing may be created for an unknown Bot')
})

test('the binding survives a reload, so a restart leaves the task pointing at the same Bot', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-reload-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  /** A fresh runtime over the same team file: calling it twice is what a restart looks like. */
  const make = (created) => {
    const ctx = fakeContext({ services: { agentPresets: { list: async () => [{ id: 'standard' }] } } })
    Object.assign(ctx, {
      workspaceRegistry: {
        get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'ws-1' }),
        archiveSession: async () => {},
      },
      sessionTitle: { rename: async () => {} },
      sessionController: {
        create: async (options) => { const sessionId = `task-session-${created.length + 1}`; created.push({ sessionId, options }); return { sessionId } },
        resolveAgent: async sessionId => ({ session: { id: sessionId }, agent: { id: sessionId } }),
      },
    })
    const rt = createRuntime(ctx, { home })
    Object.assign(rt, { ensureWorkspace: async () => 'ws-1', isFolder: async () => true })
    return rt
  }

  const created = []
  const first = make(created)
  await first.load()
  const binding = await first.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await first.rememberTaskSession(binding)

  // A fresh runtime over the same team file: this is a restart.
  const second = make(created)
  await second.load()

  // The in-memory map is a cache over the team file, never the record itself, so the identity
  // is back before anything asks for it.
  assert.equal(second.isTaskSession(binding.sessionId), true)
  assert.equal(second.taskSessionOf(binding.sessionId).botId, 'b2')
  assert.equal(second.selfOf(binding.sessionId), 'b2')
  const section = second.ctx.sections.get('bot-identity')
  const text = typeof section.text === 'function' ? section.text({ agent: { id: binding.sessionId } }) : section.text
  assert.match(text, /You are Writer/)

  // And the record on disk is what carried it.
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.taskSessions['task-1'].botId, 'b2')
  assert.equal(saved.taskSessions['task-1'].sessionId, binding.sessionId)
  // Reopening after the restart reuses the recorded Session rather than making a second one.
  const reopened = await second.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  assert.equal(reopened.sessionId, binding.sessionId)
  assert.equal(created.length, 1)
})

test('an approved folder is required when the task named one, and an unusable folder is refused', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  // The folder exists: the Session is created there.
  b.rt.isFolder = async path => path === 'D:\approved'
  const withFolder = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2', workDir: 'D:\approved' })
  await b.rt.rememberTaskSession(withFolder)
  assert.equal(b.created[0].options.cwd, 'D:\approved')

  // The folder is gone: refuse. A silent fallback to the team workspace would let the task read
  // files the owner never approved, which is the substitution F-12 forbids.
  await assert.rejects(
    () => b.rt.openTaskSession({ taskId: 'task-2', botId: 'b2', workDir: 'D:\gone' }),
    /is not a usable directory, so this task will not start/,
  )
  assert.equal(b.created.length, 1, 'no Session may be created in a substituted folder')
})

test('closing a task Session archives it, keeps its record, and stops it working', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()

  const binding = await b.rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await b.rt.rememberTaskSession(binding)
  await b.rt.closeTaskSession('task-1')

  // Archived, not deleted: the owner may still need to read what the task did.
  assert.equal(b.archived.length, 1)
  assert.equal(b.archived[0].id, binding.sessionId)
  assert.equal(b.archived[0].options.stopActivity, true)
  // The record stays, so a later reader still learns which Bot ran the task.
  const saved = JSON.parse(readFileSync(join(b.home, 'state.json'), 'utf8'))
  assert.equal(saved.taskSessions['task-1'].botId, 'b2')
  assert.ok(saved.taskSessions['task-1'].closedAt !== null)
  // Closing twice is a no-op rather than a second archive.
  await b.rt.closeTaskSession('task-1')
  assert.equal(b.archived.length, 1)
})

test('a Session that is not a task Session answers nothing, so ordinary Sessions are unaffected', async (t) => {
  const b = bench()
  t.after(() => b.cleanup())
  await b.rt.load()
  assert.equal(b.rt.taskSessionOf('b2'), undefined)
  assert.equal(b.rt.isTaskSession('b2'), false)
  assert.equal(b.rt.taskSessionOf(undefined), undefined)
  // The Bot's own chat still resolves through the chat map, not through the task index.
  assert.equal(b.rt.selfOf('b2'), 'b2')
})

test('a team file from before this module existed gains the record without losing its Bots', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-legacy-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  // No `taskSessions` key at all: the shape has to be created on demand.
  const legacy = { ...TEAM }
  delete legacy.taskSessions
  writeFileSync(join(home, 'state.json'), JSON.stringify(legacy))

  const ctx = fakeContext({
    services: {
      agentPresets: { list: async () => [{ id: 'standard' }] },
    },
  })
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'ws-1' }), archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 'task-session-1' }),
      resolveAgent: async sessionId => ({ session: { id: sessionId }, agent: { id: sessionId } }),
    },
  })
  const rt = createRuntime(ctx, { home })
  Object.assign(rt, {
    ensureWorkspace: async () => 'ws-1',
    isFolder: async () => true,
  })
  await rt.load()

  // The existing team is intact and a task Session can be opened against it.
  assert.equal(rt.botOf('b2').name, 'Writer')
  const binding = await rt.openTaskSession({ taskId: 'task-1', botId: 'b2' })
  await rt.rememberTaskSession(binding)
  assert.equal(rt.selfOf(binding.sessionId), 'b2')
})
