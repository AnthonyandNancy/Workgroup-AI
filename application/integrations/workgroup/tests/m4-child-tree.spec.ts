// E2: on Windows, revoking a task must stop the process **and its children**, and an outcome that
// could not be confirmed must be reported as unconfirmed.
//
// The gap this closes is specific and was measured before it was written down: `handle.terminate()`
// reaches the process the provider spawned, and on Windows that process's own children keep running.
// A model-driven task that starts a shell which starts a compiler leaves the compiler alive after
// the task is gone — the machine keeps working for a task nobody authorized any more.
//
// `taskkill /T` is the only correct verb here, and the reason is in the flags: `/T` walks the child
// tree and `/F` is required because an interactive grandchild does not answer a polite request. A
// version of this that terminated only the direct child would pass a test written against a single
// process and still leak the compiler.
//
// The second half of the requirement is the honesty rule: when termination cannot be confirmed, the
// report says so. `confirmed: true` is the one answer that must never be manufactured, because the
// caller's next action depends on it.

import { describe, expect, it } from 'vitest'
import { terminateProcessTree } from '../bot-adapter/cancellation.mjs'

describe('E2 terminating a process tree', () => {
  it('uses taskkill with /T and /F on Windows', async () => {
    const calls = []
    const result = await terminateProcessTree(4242, {
      platform: 'win32',
      run: async (file, args) => {
        calls.push([file, ...args])
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    expect(calls).toEqual([['taskkill', '/PID', '4242', '/T', '/F']])
    expect(result.confirmed).toBe(true)
  })

  it('reports unconfirmed when taskkill fails, and never claims success', async () => {
    // A missing `taskkill`, a permission refusal, or a process that outlives the kill all land
    // here. The caller must learn that the tree may still be running.
    const result = await terminateProcessTree(4242, {
      platform: 'win32',
      run: async () => { throw new Error('taskkill: not found') },
    })
    expect(result.confirmed).toBe(false)
    expect(result.detail).toMatch(/not found/)
  })

  it('reports unconfirmed when taskkill exits non-zero', async () => {
    // A non-zero exit is not a failure of the call but of the kill, which is the case that matters:
    // "could not find the process" and "could not kill it" must not read as done.
    const result = await terminateProcessTree(4242, {
      platform: 'win32',
      run: async () => ({ code: 128, stdout: '', stderr: 'ERROR: The process "4242" not found.' }),
    })
    expect(result.confirmed).toBe(false)
    expect(result.detail).toMatch(/not found/)
  })

  it('does not shell out on a platform whose provider can report exits', async () => {
    // POSIX keeps the provider's own signal path: it can observe the exit, so it does not need a
    // second mechanism whose result nobody can check.
    let called = false
    const result = await terminateProcessTree(4242, {
      platform: 'linux',
      run: async () => { called = true; return { code: 0, stdout: '', stderr: '' } },
    })
    expect(called).toBe(false)
    expect(result.confirmed).toBe(false)
    expect(result.detail).toMatch(/no tree termination is implemented for linux/)
  })

  it('refuses a pid that is not a pid rather than guessing one', async () => {
    const result = await terminateProcessTree('not-a-pid', {
      platform: 'win32',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    expect(result.confirmed).toBe(false)
    expect(result.detail).toMatch(/pid/i)
  })
})
