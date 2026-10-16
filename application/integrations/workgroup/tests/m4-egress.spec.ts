// E3: a task reaches only the hosts its approval named, and an approval that named none opens
// nothing.
//
// The requirement is "outbound access outside the approved range is refused by default, and the
// refusal is recorded". The decision itself is what this file tests, because the decision is where
// the rule either holds or does not; the enforcement point (`task-grants.js`, which turns a verdict
// into the refusal the model reads) is covered next door in the Bot package's own suite.
//
// Every case here is a negative one on purpose. A positive case passes against an implementation
// that allows everything, so the cases that can fail are the only ones worth writing first:
//
//   * **A lookalike domain.** `internal.corp.attacker.example` ends with the approved string, so an
//     `endsWith` comparison approves the attacker's host. Both directions are asserted, so the check
//     cannot be "fixed" by swapping the arguments.
//   * **A port-restricted approval.** Approving `internal.corp:8443` must not also approve port 22
//     on the same host.
//   * **An absent list.** A missing `allowed` must refuse everything. The dangerous default is the
//     opposite reading, in which a task nobody configured becomes a task with no restrictions.
//   * **A missing host.** An incomplete request is the one input that must not get the benefit of
//     the doubt.

import { describe, expect, it } from 'vitest'
import { egressTargetOf, judgeEgress } from '../policy/egress.mjs'

describe('E3 outbound access', () => {
  it('refuses a host outside the approved list', () => {
    const verdict = judgeEgress({ host: 'example.com', port: 443 }, { allowed: ['internal.corp'] })
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/not approved|no approved hosts/)
  })

  it('refuses everything when the list is empty or absent', () => {
    expect(judgeEgress({ host: 'example.com', port: 443 }, { allowed: [] }).allowed).toBe(false)
    expect(judgeEgress({ host: 'example.com', port: 443 }, {}).allowed).toBe(false)
    expect(judgeEgress({ host: 'example.com', port: 443 }, undefined).allowed).toBe(false)
  })

  it('allows an approved host with or without an explicit port', () => {
    expect(judgeEgress({ host: 'internal.corp', port: 443 }, { allowed: ['internal.corp'] }).allowed).toBe(true)
    expect(judgeEgress({ host: 'internal.corp', port: 8080 }, { allowed: ['internal.corp'] }).allowed).toBe(true)
  })

  it('does not widen a port-restricted approval to other ports', () => {
    const policy = { allowed: ['internal.corp:8443'] }
    expect(judgeEgress({ host: 'internal.corp', port: 8443 }, policy).allowed).toBe(true)
    expect(judgeEgress({ host: 'internal.corp', port: 22 }, policy).allowed).toBe(false)
  })

  it('refuses a lookalike domain in both directions', () => {
    const policy = { allowed: ['internal.corp'] }
    expect(judgeEgress({ host: 'internal.corp.attacker.example', port: 443 }, policy).allowed).toBe(false)
    expect(judgeEgress({ host: 'evil-internal.corp', port: 443 }, policy).allowed).toBe(false)
  })

  it('treats case and a trailing root dot as the same host', () => {
    expect(judgeEgress({ host: 'Internal.Corp', port: 443 }, { allowed: ['internal.corp'] }).allowed).toBe(true)
    expect(judgeEgress({ host: 'internal.corp', port: 443 }, { allowed: ['INTERNAL.CORP'] }).allowed).toBe(true)
    expect(judgeEgress({ host: 'internal.corp.', port: 443 }, { allowed: ['internal.corp'] }).allowed).toBe(true)
  })

  it('refuses a request that names no host rather than treating it as internal', () => {
    expect(judgeEgress({ port: 443 }, { allowed: ['internal.corp'] }).allowed).toBe(false)
    expect(judgeEgress({ host: '', port: 443 }, { allowed: ['internal.corp'] }).allowed).toBe(false)
  })

  it('names the host it refused and never recites the approved list', () => {
    // The denial is read by whoever triggered it; a message that lists the policy teaches the next
    // attempt how to pass it.
    const verdict = judgeEgress({ host: 'example.com', port: 443 }, { allowed: ['internal.corp', 'secret.corp'] })
    expect(verdict.reason).toMatch(/example\.com/)
    expect(verdict.reason).not.toMatch(/secret\.corp/)
  })

  it('reads a destination from a URL or from a bare host', () => {
    expect(egressTargetOf({ input: { url: 'https://internal.corp:8443/doc' } }, ['url'])).toEqual({ host: 'internal.corp', port: 8443 })
    expect(egressTargetOf({ input: { url: 'https://internal.corp/doc' } }, ['url'])).toEqual({ host: 'internal.corp' })
    expect(egressTargetOf({ input: { host: 'internal.corp:22' } }, ['host'])).toEqual({ host: 'internal.corp', port: 22 })
  })

  it('yields no destination for a call that names none, so other tools are not gated', () => {
    // The rule narrows networking calls; it must not become a second, invisible gate on every tool.
    expect(egressTargetOf({ input: { path: 'a.txt' } }, ['url', 'host'])).toBeUndefined()
    expect(egressTargetOf({ input: {} }, ['url'])).toBeUndefined()
    expect(egressTargetOf(undefined, ['url'])).toBeUndefined()
  })
})
