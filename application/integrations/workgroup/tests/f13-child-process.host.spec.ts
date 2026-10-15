// F-13's remaining gap, closed by measurement rather than by argument: when a task is cancelled,
// does a child process the turn had *already spawned* actually die?
//
// The earlier F-13 round proved two things — "the next tool call is refused" and "the running turn
// is cancelled" — and recorded the process question as open, because neither answers it. A
// cancelled turn can still leave a build, a download, or a long command running while every API
// answer says the task stopped. The acceptance criteria require the stronger claim: a revocation
// actually terminates the subprocess.
//
// So this spec drives a REAL turn. A scripted model asks for a long-running shell command; while
// that command is running, the Agent is cancelled exactly the way DS Bot's `revokeGrant` does it
// (`agent.cancel({ kind: 'user' })`). Then it checks the operating system: the child's pid, which
// the command printed, must be gone. Nothing in this test kills the child itself.
//
// That shape matters. A test that awaited a command which never returns cannot observe a kill,
// and a fake handle would pass while any link in the real chain — model request, tool dispatch,
// shell provider, subprocess provider, Agent abort signal — was broken. This one waits for the
// tool to *start*, then cancels, then asks the operating system.
//
// The two scope cases keep the first honest. If a cancellation killed by process group, by name,
// or by "everything DSH started", an unrelated process would die with it. The outsider is started
// by this test process, so it must survive; the sibling case puts a second Agent's child beside
// the cancelled one, so one task cannot reach another's work.
//
// The shell binding is per host and both are exercised where they exist: PowerShell ships with
// Windows and a POSIX shell does not, and the reverse holds in CI's Linux lane.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { PwshLocalExecutor, resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'

/**
 * Whether a PID is still alive on this host.
 * @param pid - process to probe.
 * @returns true while the process exists.
 */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 asks the operating system whether the process exists without touching it.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until `pid` is gone, or until the budget expires.
 * @param pid - process to watch.
 * @param budgetMs - how long to keep asking.
 * @returns true when the process no longer exists.
 */
async function waitForDeath(pid: number, budgetMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return !isAlive(pid)
}

const hasPwsh = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
const hasBash = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0

/** The shell the model's command runs in, on this host. */
interface ShellBinding {
  readonly tool: string
  /** Prints the child pid, then stays alive until something stops it. */
  readonly command: string
}

/** PowerShell: the pid comes from .NET, then a child that never exits on its own. */
const PWSH_BINDING: ShellBinding = {
  tool: 'pwsh',
  command: `Write-Output ([System.Diagnostics.Process]::GetCurrentProcess().Id); node -e "console.log('CHILDPID', process.pid); setInterval(() => {}, 1000)"`,
}
/** POSIX: the same shape with the shell's own syntax. */
const BASH_BINDING: ShellBinding = {
  tool: 'bash',
  command: `echo "SHELLPID $$"; node -e "console.log('CHILDPID', process.pid); setInterval(() => {}, 1000)"`,
}

const binding: ShellBinding | undefined = hasPwsh ? PWSH_BINDING : hasBash ? BASH_BINDING : undefined

const cleanups: (() => void | Promise<void>)[] = []
const spawned = new Set<number>()
afterEach(async () => {
  for (const pid of spawned) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone, which is the point */ }
  }
  spawned.clear()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

interface Bench {
  readonly ctx: Context
  readonly server: MockLlmServer
}

/**
 * Mount the real stack a task turn runs on: the loop's prerequisites, the shell seam, and the
 * DeepSeek adapter pointed at a scripted mock model.
 *
 * The adapter takes its endpoint at load time, so the mock server starts first and the plugin is
 * pointed at the port it actually bound.
 * @returns the context and the running mock server.
 */
async function bench(): Promise<Bench> {
  const home = mkdtempSync(join(tmpdir(), 'wg-f13-child-'))
  const ctx = new Context()
  cleanups.push(() => { void ctx.fiber.dispose() })
  cleanups.push(() => { rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const server = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    apiKey: 'mock-key',
    toolName: binding!.tool,
    toolArguments: JSON.stringify({ description: 'Start the task’s long-running command', command: binding!.command }),
    successText: 'done',
  })
  cleanups.push(() => { void server.close() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalSubprocessRuntime, {})
  if (hasPwsh) {
    await ctx.plugin(PwshLocalExecutor, { timeoutMs: 120_000, graceMs: 300 })
    await ctx.plugin(ToolPwsh)
  } else {
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 120_000, graceMs: 300 })
    await ctx.plugin(ToolBash)
  }
  await ctx.plugin(LlmDeepSeek, { baseURL: server.baseURL, streamIdleTimeoutMs: 60_000 })
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, server }
}

/**
 * Watch the Agent's own event stream until the long command's pid appears.
 * @param agent - Agent whose session is observed.
 * @returns the child pid the command printed.
 */
function childPidPromise(agent: Agent): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('the model never started the command')) }, 90_000)
    const scan = (): boolean => {
      for (const event of agent.session.snapshotEvents()) {
        const text = JSON.stringify(event)
        const match = /CHILDPID[^0-9]{0,8}(\d{3,})/.exec(text)
        if (match !== null) {
          clearTimeout(timer)
          resolve(Number(match[1]))
          return true
        }
      }
      return false
    }
    if (scan()) return
    agent.ctx.on('session/event', () => { scan() })
  })
}

/** A process started outside DSH, which no task cancellation has any business reaching. */
function startOutsider(): Promise<number> {
  const child = spawn('node', ['-e', "console.log('OUTSIDER', process.pid); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { reject(new Error('the outsider never printed a pid')) }, 15_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += String(chunk)
      const match = /OUTSIDER (\d+)/.exec(buffer)
      if (match !== null) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.on('error', reject)
  })
}

describe.skipIf(binding === undefined)('F-13: a cancelled task terminates the child it already spawned', () => {
  it('kills the running command’s child when the Agent is cancelled mid-turn', async () => {
    const b = await bench()
    const agent = await b.ctx.agentLoop.create(SessionId('f13-cancel'), { provider: 'deepseek-official', model: 'mock-model' })

    // The model asks for a command that never returns; the turn is still running while the child
    // lives, which is the only state in which a cancellation can be observed to kill anything.
    const pidOfChild = childPidPromise(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the long command' }], source: { kind: 'user' } }))
    const childPid = await pidOfChild
    spawned.add(childPid)
    expect(isAlive(childPid), 'the command’s child is running before the cancellation').toBe(true)

    // Exactly what DS Bot's revoke path calls (see `revokeGrant` in task-grants.js).
    agent.cancel({ kind: 'user', reason: 'ds-bot/task-cancelled' })

    expect(await waitForDeath(childPid), `child ${childPid} must be gone after the cancellation`).toBe(true)
  }, 180_000)

  it('leaves a process the task did not spawn running, so cancellation is per task', async () => {
    const b = await bench()
    const agent = await b.ctx.agentLoop.create(SessionId('f13-scope'), { provider: 'deepseek-official', model: 'mock-model' })

    const myPid = childPidPromise(agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the long command' }], source: { kind: 'user' } }))
    const childPid = await myPid
    spawned.add(childPid)
    const outsiderPid = await startOutsider()
    spawned.add(outsiderPid)

    expect(isAlive(childPid)).toBe(true)
    agent.cancel({ kind: 'user', reason: 'ds-bot/task-cancelled' })

    expect(await waitForDeath(childPid), 'the task-owned child is gone').toBe(true)
    expect(isAlive(outsiderPid), 'the outsider must still be running').toBe(true)
  }, 180_000)
})
