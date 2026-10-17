// W3 L-level (single machine): a real model runs an approved workgroup task.
//
// This suite is the real-model counterpart of `a18`: the same production consumer and Task Session
// modules, but against a **real Hub process**, a **real Loader composition with the real model
// provider**, and a **real model endpoint**. It answers one question the M-level suites cannot:
// does the approved task actually reach a native Bot session and produce a model turn?
//
// What is real here:
//
//   * the Hub is `server/src/index.js` as a separate process, with its own data directory and
//     Ed25519 grant signing key;
//   * the Host is a test-only `cordis.yml` booted through the real Loader, with the real Bot package,
//     the real agent loop, and the real `llm-pi-ai` provider pointing at the historical local
//     endpoint;
//   * the approval is sent through the product's `/api/bot` endpoint, the Hub publishes to the real
//     WebSocket Bridge, and the consumer mints/consumes a real signed grant;
//   * the Task Session is a real Session, and the turn is a real model call whose transcript is
//     written by the real session persistence.
//
// What is still not covered, and must not be inferred from this file: a real browser UI or the
// desktop app (so approval-form rendering and the `conversation` panel stay L-BLOCKED), two machines
// (N), and packaging (P).
//
// The model credential is never written here. `LOCATION_API_KEY` must be present in the environment;
// the historical record under `application/apps/desktop/.desktop-build/development/home/.credentials.yaml`
// is where this machine keeps it. Without it the suite skips rather than pretending to pass.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachment from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as Bot from '@deepseek-ai/dsh-bot'

import { createHubClient } from '../protocol/hub-client.mjs'
import { createWorkgroupClient } from '../client/index.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SERVER_ROOT = resolve(APP_ROOT, '..', 'server')
const MODEL_BASE_URL = 'http://127.0.0.1:8317/v1'
const MODEL_ID = 'deepseek-v4.1-flash'
const MODEL_KEY = process.env.LOCATION_API_KEY ?? ''
const PASSWORD = 'correct-horse-battery-staple'
const BOOTSTRAP = 'a19-bootstrap-secret'

const roots = []
const disposers = []
const children = []
afterAll(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const child of children.splice(0)) await stopChild(child)
  // The Host's session logs can still be open when the composition disposes, so the tree is removed
  // with retries rather than recycled; these are this suite's own temp roots.
  for (const root of roots.splice(0)) { try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch { /* Windows may hold a closed log briefly */ } }
}, 120_000)

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-a19-'))
  roots.push(root)
  return root
}

function response(payload, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  const exited = new Promise(resume => child.once('exit', resume))
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise(resume => setTimeout(resume, 5000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function waitFor(predicate, { timeout = 120_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resume => setTimeout(resume, interval))
  }
}

/** Start the real Hub as its own process, with its own data directory and signing key. */
async function startHub() {
  const root = tempRoot()
  const port = 23000 + Math.floor(Math.random() * 900)
  const keys = generateKeyPairSync('ed25519')
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_DATA_DIR: join(root, 'data'),
      HUB_TOKEN_SIGNING_KEY: 'a19-test-signing-key-long-enough-for-hs256',
      HUB_GRANT_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      HUB_GRANT_SIGNING_KEY_ID: 'a19-g1',
      HUB_REGISTRATION: 'admin_secret',
      HUB_ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    try { return (await fetch(`${base}/api/v1/health/live`)).ok } catch { return false }
  }, { timeout: 30_000, label: `the Hub to start:\n${log}` })
  return { base, root, child }
}

let counter = 0
async function newPerson(hubBase, label) {
  counter += 1
  const handle = `${label}${counter}`
  const client = createHubClient({ hubUrl: hubBase, appVersion: '0.1.0-a19' })
  await client.handshake()
  await client.register({ userHandle: handle, displayName: `${label} Person`, password: PASSWORD, bootstrapSecret: BOOTSTRAP })
  await client.login({ userHandle: handle, password: PASSWORD })
  return {
    handle,
    password: PASSWORD,
    client,
    userId: client.identity.userId,
    workgroup: createWorkgroupClient({ client }),
  }
}

/**
 * Boot the Host exactly as `a17` does, plus the agent loop and the real model provider.
 *
 * @param {{ hubUrl: string, root: string }} options
 * @returns the loaded composition and the paths the test reads.
 */
async function bootHost({ hubUrl, root }) {
  const home = join(root, 'bot')
  const sessionsRoot = join(root, 'sessions')
  const hubStatePath = join(root, 'hub-session.json')
  const hubConfigPath = join(root, 'hub-config.json')
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-llm' },
    // The historical local model endpoint. The credential is resolved from the environment by the
    // provider; it is never written into this file or the profile.
    {
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          location: {
            displayName: 'Location',
            apiKeyEnv: 'LOCATION_API_KEY',
            api: 'openai-responses',
            baseURL: MODEL_BASE_URL,
            models: [{ id: MODEL_ID, name: MODEL_ID }],
          },
        },
      },
    },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: sessionsRoot, compression: 'none' } },
    { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: join(root, 'query.sqlite'), openAt: 'never' } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-remote-access' },
    { name: '@deepseek-ai/dsh-api-session-controller', config: { nativeOpen: false } },
    { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'location', model: MODEL_ID } },
    { name: '@deepseek-ai/dsh-agent' },
    { name: '@deepseek-ai/dsh-agent-loop' },
    { name: '@deepseek-ai/dsh-attachment-local' },
    { name: '@deepseek-ai/dsh-fs-local' },
    { name: '@deepseek-ai/dsh-commands' },
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: '@deepseek-ai/dsh-client-file-upload' },
    { name: '@deepseek-ai/dsh-session-title', config: { fallbackMaxWords: 6, fallbackMaxBytes: 64, maxTitleBytes: 80 } },
    { name: '@deepseek-ai/dsh-workspace' },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    {
      name: '@deepseek-ai/dsh-bot',
      config: { home, hubUrl, hubConfigPath, hubStatePath, mainName: 'Chief', mainRole: 'Chief of Staff' },
    },
  ]
  const modules = {
    '@deepseek-ai/dsh-credentials-local': LocalCredentials,
    '@deepseek-ai/dsh-llm': LlmRuntime,
    '@deepseek-ai/dsh-llm-pi-ai': PiAi,
    '@deepseek-ai/dsh-session': SessionStore,
    '@deepseek-ai/dsh-session-projection': SessionProjectionRegistry,
    '@deepseek-ai/dsh-session-persistence-jsonl': SessionPersistenceJsonl,
    '@deepseek-ai/dsh-session-query-sqlite': SqliteSessionQueryEngine,
    '@deepseek-ai/dsh-storage': Storage,
    '@deepseek-ai/dsh-storage-json': StorageJson,
    '@deepseek-ai/dsh-storage-domain': StorageDomain,
    '@deepseek-ai/dsh-typert-registry': TypertRegistry,
    '@deepseek-ai/dsh-api-remote-access': RemoteAccess,
    '@deepseek-ai/dsh-api-session-controller': SessionController,
    '@deepseek-ai/dsh-agent-default-model': AgentDefaultModel,
    '@deepseek-ai/dsh-agent': AgentRegistry,
    '@deepseek-ai/dsh-agent-loop': AgentLoop,
    '@deepseek-ai/dsh-attachment-local': LocalAttachment,
    '@deepseek-ai/dsh-fs-local': LocalFileSystem,
    '@deepseek-ai/dsh-commands': CommandRuntime,
    '@deepseek-ai/dsh-client-connection': Connection,
    '@deepseek-ai/dsh-client-file-upload': FileUploads,
    '@deepseek-ai/dsh-session-title': SessionTitleService,
    '@deepseek-ai/dsh-workspace': WorkspaceRegistry,
    '@deepseek-ai/dsh-system-prompt': SystemPrompt,
    '@deepseek-ai/dsh-tools': ToolRuntime,
    '@deepseek-ai/dsh-bot': Bot,
  }
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, home, sessionsRoot, hubStatePath, hubConfigPath, configPath }
}

async function apiBot(ctx, endpoint, payload = {}) {
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const response = await handler.fetch(new Request('http://dsh.test/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }), ctx.connection.browserPeer)
  return await response.json()
}

function jsonlUnder(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  return found
}

describe.skipIf(MODEL_KEY === '')('a real model runs an approved workgroup task end to end', () => {
  let hub
  let owner
  let requester
  let host
  let workDir
  let roomId
  let taskId
  let localBotId

  beforeAll(async () => {
    hub = await startHub()
    requester = await newPerson(hub.base, 'requester')
    owner = await newPerson(hub.base, 'owner')
    // A workgroup owned by the requester, with the owner as a member.
    const room = await requester.client.request('POST', '/rooms', { body: { name: 'Live approval room', kind: 'workgroup' } })
    roomId = room.room.id
    const invitation = await requester.workgroup.invite(roomId, { targetUserId: owner.userId })
    await owner.workgroup.respondToInvitation(invitation.id, 'accept')

    const root = tempRoot()
    process.env.WORKGROUP_HOME = join(root, 'dsh-home')
    mkdirSync(process.env.WORKGROUP_HOME, { recursive: true })
    workDir = join(root, 'approved-folder')
    mkdirSync(workDir)
    workDir = realpathSync(workDir)
    host = await bootHost({ hubUrl: hub.base, root })

    // The Host signs in through the product endpoint, so the Hub client, the device, and the Bridge
    // are the ones the product would use.
    const signedIn = await apiBot(host.ctx, 'hub-sign-in', { userHandle: owner.handle, password: PASSWORD, label: 'a19 owner host' })
    expect(signedIn.ok, JSON.stringify(signedIn)).toBe(true)
    // The browser's normal startup read. It is what creates the team's first Main Bot on a fresh
    // install (`rt.bootstrap()` runs from the `state` endpoint), so the harness calls it instead of
    // reaching into the Host.
    const started = await apiBot(host.ctx, 'state', {})
    expect(started.ok, JSON.stringify(started)).toBe(true)

    // The team's own Main Bot is created on first load. It is the native Bot this task will run on.
    const botId = await waitFor(() => {
      const path = join(host.home, 'state.json')
      if (!existsSync(path)) return false
      const state = JSON.parse(readFileSync(path, 'utf8'))
      const ids = Object.keys(state.bots ?? {})
      return ids.length > 0 ? ids[0] : false
    }, { timeout: 60_000, label: 'the Host to create its Main Bot' })
    localBotId = botId

    // Publish that Bot in the owner's Hub directory, which is what a requester may mention. The
    // product publishes the same way; this call is the same `POST /bots` the owner's client makes.
    await owner.client.request('POST', '/bots', {
      body: { botId: localBotId, displayName: 'Chief', role: 'Chief of Staff', description: 'Runs approved tasks', visibility: 'public' },
    })

    // Open the room in the Host so its Bridge is subscribed before the approval is published.
    const opened = await apiBot(host.ctx, 'hub-open-room', { roomId })
    expect(opened.ok, JSON.stringify(opened)).toBe(true)

    // The mention creates a candidate. Nothing runs before the owner decides.
    const sent = await requester.workgroup.sendMessage(roomId, 'Chief, please reply with the word pong', {
      mentions: [{ userId: owner.userId, botId: localBotId }],
    })
    expect(sent.proposedTasks).toHaveLength(1)
    expect(sent.proposedTasks[0].state).toBe('PENDING_APPROVAL')
    taskId = sent.proposedTasks[0].id
  }, 180_000)

  it('starts nothing before the owner decides, then runs one real model turn in an isolated Session', async () => {
    const before = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
    expect(before.taskSessions[taskId] ?? undefined).toBeUndefined()
    expect(before.taskGrants[taskId] ?? undefined).toBeUndefined()

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const approved = await apiBot(host.ctx, 'hub-approve-task', {
      taskId,
      decision: 'approve',
      expectedVersion: 0,
      mode: 'existing_bot',
      botId: localBotId,
      workDir,
      tools: ['read'],
      recipients: [requester.userId],
      expiresAt,
    })
    expect(approved.ok, JSON.stringify(approved)).toBe(true)

    // Wait for the real model turn to finish and the consumer to report it for review.
    let last
    let finished
    try {
      finished = await waitFor(async () => {
        last = await owner.client.request('GET', `/tasks/${taskId}`)
        return ['REVIEW_REQUIRED', 'FAILED', 'CANCELLED', 'SHARED', 'COMPLETED'].includes(last.task.state) ? last : false
      }, { timeout: 180_000, interval: 250, label: `task ${taskId} to reach a terminal-or-review state` })
    } catch (error) {
      throw new Error(`${error.message}; last=${JSON.stringify(last?.task ?? null)}; events=${JSON.stringify(last?.events ?? [])}`)
    }
    expect(finished.task.state, JSON.stringify(finished.task)).toBe('REVIEW_REQUIRED')

    // The isolated Session is durably bound, and it is not the Main Bot's own chat.
    const state = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
    const binding = state.taskSessions[taskId]
    expect(binding).toBeDefined()
    expect(binding.botId).toBe(localBotId)
    expect(binding.workDir).toBe(workDir)
    expect(binding.closedAt).toBeNull()
    const mainChat = state.bots[localBotId].sessionId
    expect(binding.sessionId).not.toBe(mainChat)

    // The turn produced a real model answer. The transcript is the real JSONL session log; the
    // answer is the assistant message, not the prompt (which also names the word), so a missing
    // model call cannot look like a pass.
    const logs = jsonlUnder(host.sessionsRoot)
    const taskLog = logs.find(path => path.includes(binding.sessionId)) ?? logs.at(-1)
    expect(taskLog, `no session log under ${host.sessionsRoot}`).toBeDefined()
    let transcript = []
    await waitFor(() => {
      transcript = readFileSync(taskLog, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return undefined }
      }).filter(Boolean)
      const ended = transcript.find(entry => entry.type === 'turn/end' && entry.data?.reason?.kind === 'completed')
      const answered = transcript.find(entry => entry.type === 'assistant/message')
      return ended !== undefined && answered !== undefined
    }, { timeout: 30_000, interval: 250, label: 'the real turn transcript to be written' })
    const answer = transcript
      .filter(entry => entry.type === 'assistant/message')
      .map(entry => JSON.stringify(entry.data?.message ?? ''))
      .join(String.fromCharCode(10))
    expect(answer.toLowerCase()).toContain('pong')
    expect(transcript.some(entry => entry.type === 'turn/end' && entry.data?.reason?.kind === 'completed')).toBe(true)

    // The room may see the state, never the owner's machine. The requester's own read proves it.
    const asRequester = await requester.client.request('GET', `/tasks/${taskId}`)
    expect(asRequester.task.state).toBe('REVIEW_REQUIRED')
    expect(asRequester.task.approval).toBeUndefined()
    expect(asRequester.task.assignedBotId).toBeUndefined()
    // `targetBotId` is the Bot the requester named themselves, so it is theirs to see back; the Bot
    // the owner actually approved and the folder it ran in are not.
    expect(asRequester.task.targetBotId).toBe(localBotId)
    expect(JSON.stringify(asRequester)).not.toContain(workDir)
    // And the owner's view still carries the scope, so the review is informed.
    expect((await owner.client.request('GET', `/tasks/${taskId}`)).task.approval.scope.workDir).toBe(workDir)
  }, 240_000)

  it('shares the reviewed result with the named recipient, and only them', async () => {
    const detail = await owner.client.request('GET', `/tasks/${taskId}`)
    const shared = await apiBot(host.ctx, 'hub-review-task', {
      taskId,
      decision: 'share',
      expectedVersion: detail.task.version,
      recipients: [requester.userId],
    })
    expect(shared.ok, JSON.stringify(shared)).toBe(true)
    const after = await owner.client.request('GET', `/tasks/${taskId}`)
    expect(after.task.state).toBe('SHARED')
    expect((await requester.client.request('GET', `/tasks/${taskId}`)).task.state).toBe('SHARED')
    const sharedEvent = after.events.find(entry => entry.eventType === 'task.shared')
    expect(sharedEvent).toBeDefined()
    // The room-visible event records how many recipients were named; the recipient list itself stays
    // on the owner's task answer, which is where the share was decided.
    expect(sharedEvent.payload.recipients).toBe(1)
    expect(after.task.approval).toBeDefined()
  }, 60_000)
})
