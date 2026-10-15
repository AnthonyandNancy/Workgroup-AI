/**
 * Registry tests for `@deepseek-ai/dsh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: ToolCallId('bash-env-call'),
    rootCallId: ToolCallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : {
        agent: {
          session: {
            header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
          },
        } as unknown as Agent,
      }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })

    expect(registry.collect(execution())).toEqual({
      WORKGROUP_HOME: resolve('./test-dsh-home'),
      WORKGROUP_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      WORKGROUP_HOME: resolve('./test-dsh-home'),
      WORKGROUP_SESSION_ID: 'session-a',
      WORKGROUP_SHELL: '1',
    })
  })

  it('collects the launcher-provided profile name and directory when a profile context exists', () => {
    const ctx = new Context()
    ctx.provide('profileContext', {
      name: 'web', dir: '/profiles/web', patchPath: '/profiles/web/cordis.patch.yml', installAnchor: '/dsh/package.json',
      cwd: '/work', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    expect(registry.collect(execution())).toMatchObject({ WORKGROUP_PROFILE: 'web', WORKGROUP_PROFILE_DIR: '/profiles/web' })
    expect(() => registry.register({
      name: 'profile-claimer',
      variables: { WORKGROUP_PROFILE: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key "WORKGROUP_PROFILE"/)
  })

  it('resolves WORKGROUP_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('WORKGROUP_HOME', './ambient-dsh-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).WORKGROUP_HOME).toBe(resolve('./ambient-dsh-home'))

    vi.stubEnv('WORKGROUP_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    // The product's own default root, not upstream's `~/.dsh`: a machine running the official
    // harness must not see this product's shell home resolve into the official tree.
    expect(fromDefault.collect(execution()).WORKGROUP_HOME).toBe(join(homedir(), '.workgroup-ai'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        WORKGROUP_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { WORKGROUP_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        WORKGROUP_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ WORKGROUP_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('WORKGROUP_SESSION_OPTIONAL')
    expect(registry.collect(execution()).WORKGROUP_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).WORKGROUP_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'WORKGROUP_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'WORKGROUP_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'first',
      variables: { WORKGROUP_SHARED: { description: 'First owner.' } },
      resolve: () => ({ WORKGROUP_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { WORKGROUP_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ WORKGROUP_SHARED: 'second' }),
    })).toThrow(/WORKGROUP_SHARED.*first.*second|WORKGROUP_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'declared',
      variables: { WORKGROUP_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { WORKGROUP_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { WORKGROUP_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { dsh_invalid: { description: 'Invalid key.' } } as unknown as Record<'WORKGROUP_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { WORKGROUP_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { WORKGROUP_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { WORKGROUP_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ WORKGROUP_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*WORKGROUP_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { WORKGROUP_STRING: { description: 'String fact.' } },
      resolve: () => ({ WORKGROUP_STRING: 42 }) as unknown as Record<'WORKGROUP_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*WORKGROUP_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { dshHome: './test-dsh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { WORKGROUP_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ WORKGROUP_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).WORKGROUP_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('WORKGROUP_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './test-dsh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { WORKGROUP_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ WORKGROUP_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).WORKGROUP_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('WORKGROUP_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service with no contributors on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([])
  })
})
