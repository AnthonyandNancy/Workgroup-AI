// W3: the real composition gate — a test-only `cordis.yml` through the actual DSH Loader.
//
// This suite does not hand-build a `ctx.plugin(...)`: it writes a profile YAML, boots it through
// `@deepseek-ai/cordis-plugin-loader` with real service classes, and reaches the Bot package
// through the product's own `/api/bot` channel. That is what makes it evidence that the plugin
// activates in a composition rather than only when a test constructs its runtime.
//
// Scope, stated so the evidence is not overread:
//
//   * The *browser* half's `conversation` panel is registered by `src/client/index.js`, which no
//     Host process imports. Its real proof is the browser/app lane (`apps/web` under `test:web`),
//     which needs built artifacts and Chromium; this suite marks that part BLOCKED rather than
//     substituting a fake slot registry.
//   * The Host half's provider path is observable through `/api/bot`, because the channel and the
//     workgroup adapter are the same code the product runs.
//   * No model endpoint, Hub server, or browser is used, so this is S/M-level composition
//     evidence, not L.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import LocalAttachment from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import * as Bot from '@deepseek-ai/dsh-bot'

const disposers = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

/** Package specifiers this composition maps to real modules; also the rows of the YAML. */
const MODULES = {
  '@deepseek-ai/dsh-credentials-local': LocalCredentials,
  '@deepseek-ai/dsh-llm': LlmRuntime,
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

/**
 * Boot a test-only profile through the Loader.
 *
 * @param {{ configuredHub?: boolean }} options - whether the Bot has a Hub URL, which decides
 *   whether `/api/bot` reports a usable provider or a named refusal.
 * @returns the loaded composition.
 */
async function boot({ configuredHub = false, signedIn = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-loader-composition-'))
  if (signedIn) {
    // A persisted Hub session is what makes the Host's provider usable without a password: the
    // file is the same record `hub-client` writes, and its presence is what a restart resumes from.
    const deadline = new Date(Date.now() + 3_600_000).toISOString()
    writeFileSync(join(root, 'hub-session.json'), JSON.stringify({
      userId: 'u1', userHandle: 'alice', displayName: 'Alice', deviceId: 'device-1',
      accessToken: 'test-only-access-token', refreshToken: 'test-only-refresh-token',
      accessTokenExpiresAt: deadline, refreshTokenExpiresAt: deadline,
    }))
  }
  const rows = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: join(root, '.credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-session-projection' },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions') } },
    // The search index is not exercised here; opening it lazily keeps the native sqlite module out
    // of the way of an activation test.
    { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: join(root, 'query.sqlite'), openAt: 'never' } },
    // Workspace records and session metadata are KV domains; the JSON backend keeps them as files
    // under this test's own root.
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-remote-access' },
    { name: '@deepseek-ai/dsh-api-session-controller', config: { nativeOpen: false } },
    { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'location', model: 'deepseek-v4.1-flash' } },
    { name: '@deepseek-ai/dsh-agent' },
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
      config: {
        home: join(root, 'bot'),
        hubConfigPath: join(root, 'hub-config.json'),
        hubStatePath: join(root, 'hub-session.json'),
        hubUrl: configuredHub ? 'https://hub.example' : '',
      },
    },
  ]
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, rows.map(row => `- ${JSON.stringify({ ...row, name: `cordis:${row.name}` })}`).join('\n') + '\n')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  Object.assign(ctx.loader.builtins, MODULES)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root, rows }
}

/** POST one `/api/bot` call through the composition's own shared-channel handler. */
async function apiBot(ctx, endpoint, payload = {}) {
  const handler = ctx.connection.createSharedFetchHandler('/api')
  const response = await handler.fetch(new Request('http://dsh.test/api/bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }), ctx.connection.browserPeer)
  return await response.json()
}

describe('the real Loader composition activates the Bot package', () => {
  it('loads every profile row and reaches the Host workgroup path through /api/bot', async () => {
    const { ctx, rows } = await boot()
    const inactive = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(inactive, `rows that did not activate: ${inactive.join(', ')}`).toEqual([])

    // The real Bot package ran its install: its tools are in the composition's tool registry.
    const tools = ctx.tools.schemas().map(schema => schema.name)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools).toEqual(expect.arrayContaining([expect.stringMatching(/^(bot|group|task)_/)]))

    // The provider path is reachable through the product's own endpoint table: `hub-view` answers
    // without a Hub, rather than the route being absent.
    const view = await apiBot(ctx, 'hub-view')
    expect(view.ok).toBe(true)
    expect(view.value.configured).toBe(false)
    expect(view.value.state).toBe('unavailable')
    // An approval attempt with no Hub is refused by name, which proves the request reached the
    // workgroup adapter instead of a generic 404.
    const decision = await apiBot(ctx, 'hub-approve-task', { taskId: 'task-1', decision: 'approve', expectedVersion: 0 })
    expect(decision.ok).toBe(false)
    // A refusal the user can act on, not a missing route: the adapter names the Hub as the reason.
    expect(decision.error?.code).toBe('bot/refused')
    expect(String(decision.error?.message ?? '')).toMatch(/Hub|HUB/)
    expect(rows).toHaveLength(Object.keys(MODULES).length + 0)
  }, 120_000)

  it('receives an approval event through the real Bridge and starts nothing while the task is pending', async () => {
    const requests = []
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const target = String(url)
      requests.push({ url: target, method: init.method ?? 'GET' })
      if (target.endsWith('/rooms/room-1')) return { ok: true, status: 200, json: async () => ({ room: { id: 'room-1', name: 'Ops', kind: 'workgroup' }, members: [] }) }
      if (target.endsWith('/rooms/room-1/messages?afterSeq=0&limit=200')) return { ok: true, status: 200, json: async () => ({ messages: [], hasMore: false }) }
      if (target.endsWith('/rooms/room-1/messages?limit=200')) return { ok: true, status: 200, json: async () => ({ messages: [], nextAfterSeq: 0 }) }
      if (target.endsWith('/rooms/room-1/tasks')) return { ok: true, status: 200, json: async () => ({ tasks: [] }) }
      if (target.endsWith('/tasks/task-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            // The frame claims an approval; the Hub's detail says the task is still waiting for its
            // owner. The consumer must believe the Hub.
            task: {
              id: 'task-1', roomId: 'room-1', requesterUserId: 'u2', ownerUserId: 'u1', targetBotId: 'bot-1',
              description: 'Not approved yet', state: 'PENDING_APPROVAL', version: 0, revocationVersion: 0,
              createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            },
            events: [],
          }),
        }
      }
      throw new Error(`unexpected Hub request ${target}`)
    })
    class TestWebSocket {
      static OPEN = 1
      static instances = []
      readyState = 0
      listeners = new Map()
      constructor() { TestWebSocket.instances.push(this) }
      addEventListener(type, listener) { this.listeners.set(type, listener) }
      send() {}
      close() {}
      emit(type, event) { this.listeners.get(type)?.(event) }
    }
    vi.stubGlobal('WebSocket', TestWebSocket)
    try {
      const { ctx, root } = await boot({ configuredHub: true, signedIn: true })
      const opened = await apiBot(ctx, 'hub-open-room', { roomId: 'room-1' })
      expect(opened.ok).toBe(true)
      const socket = TestWebSocket.instances.at(-1)
      expect(socket).toBeDefined()
      socket.readyState = TestWebSocket.OPEN
      socket.emit('open')
      await apiBot(ctx, 'hub-open-room', { roomId: 'room-1' })
      socket.emit('message', {
        data: JSON.stringify({ schemaVersion: 'wg.v1', eventId: 'event-1', type: 'task.approved', roomId: 'room-1', payload: { taskId: 'task-1', state: 'APPROVED' } }),
      })
      await vi.waitFor(() => expect(requests.some(entry => entry.url.endsWith('/tasks/task-1'))).toBe(true))
      await new Promise(resume => setTimeout(resume, 300))

      // A pending task consumes nothing and opens nothing, even though the event said "approved".
      expect(requests.some(entry => entry.url.endsWith('/grant'))).toBe(false)
      expect(requests.some(entry => entry.url.endsWith('/dispatch/consume'))).toBe(false)
      const statePath = join(root, 'bot', 'state.json')
      const recorded = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined
      expect(recorded?.taskSessions ?? {}).toEqual({})
      expect(recorded?.taskGrants ?? {}).toEqual({})
    } finally {
      vi.unstubAllGlobals()
    }
  }, 120_000)

  it('reports a configured Hub through the same endpoint, without exposing credentials', async () => {
    const { ctx } = await boot({ configuredHub: true })
    const view = await apiBot(ctx, 'hub-view')
    expect(view.ok).toBe(true)
    expect(view.value.configured).toBe(true)
    // The renderer's view carries the URL and the identity fields, never a token.
    expect(JSON.stringify(view.value)).not.toMatch(/token|password|secret/i)
  }, 120_000)
})
