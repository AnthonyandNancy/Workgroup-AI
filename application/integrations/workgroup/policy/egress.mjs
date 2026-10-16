// E3: which hosts an approved task may reach.
//
// A task runs under the owner's approval for one job — a folder, a tool set, a purpose — and that
// approval is not "the network". Without this rule an approved task can reach anywhere the machine
// can, which turns a narrow approval into general egress.
//
// The rule is an allow-list, and its default is refuse. A deny-list cannot be made safe: the set of
// hosts a task legitimately needs is finite and known when the owner approves it, while the set it
// must not reach is neither.
//
// Matching is exact for the same reason. `endsWith` approves `internal.corp.attacker.example`
// because it ends with the approved string, and `startsWith` approves it from the other side; both
// are one-line bypasses of a check whose entire purpose is to be unbypassable.
//
// This module decides; the caller performs the request and records the denial. Keeping the decision
// pure is what lets the negative cases be tested without a network.

/** Entries are `host` or `host:port`; anything else is a host name with no port. */
function parseEntry(entry) {
  const text = String(entry ?? '').trim().toLowerCase()
  if (text === '') return undefined
  const separator = text.lastIndexOf(':')
  // Only a trailing numeric segment is a port, so an IPv6 literal is not split at its own colons
  // and `host:https` is not silently read as a port named "https".
  if (separator > 0 && /^\d+$/.test(text.slice(separator + 1))) {
    return { host: text.slice(0, separator), port: Number(text.slice(separator + 1)) }
  }
  return { host: text, port: undefined }
}

/** A host as compared: lowercase, with the single trailing root dot DNS allows removed. */
function normalizeHost(host) {
  const text = String(host ?? '').trim().toLowerCase()
  return text.endsWith('.') ? text.slice(0, -1) : text
}

/**
 * Decide whether one outbound request is approved.
 *
 * @param target - `{ host, port }` of the request about to be made.
 * @param policy - `{ allowed }`, entries `host` or `host:port`. A missing or empty list approves
 *   nothing, so an unstubbed policy cannot become an open door.
 * @returns `{ allowed: true }`, or `{ allowed: false, reason }`. The reason names what was refused
 *   and never echoes the list: a denial is read by whoever triggered it, and a message that recites
 *   the policy teaches the next attempt how to pass it.
 */
export function judgeEgress(target, policy) {
  const host = normalizeHost(target?.host)
  if (host === '') return { allowed: false, reason: 'Outbound request has no host, so it is not approved' }

  const entries = (policy?.allowed ?? []).map(parseEntry).filter(entry => entry !== undefined)
  if (entries.length === 0) return { allowed: false, reason: `Outbound access to ${host} is refused: this task has no approved hosts` }

  const port = target?.port === undefined ? undefined : Number(target.port)
  if (entries.some(entry => entry.host === host && (entry.port === undefined || entry.port === port))) return { allowed: true }

  const asked = port === undefined ? '' : `:${String(port)}`
  return { allowed: false, reason: `Outbound access to ${host}${asked} is not approved for this task` }
}

/**
 * The destination a tool call names, or `undefined` when it names none.
 *
 * A destination is written either as a URL or as a bare host with a separate port, so both are
 * read. A value that parses as neither is treated as naming no destination: a malformed argument is
 * the tool's own error to report, and inventing a host from it would refuse a call for a reason the
 * model cannot see in its arguments.
 *
 * @param exec - a tool call: `{ name, input }`.
 * @param keys - argument names that can carry a destination.
 * @returns `{ host, port? }` or `undefined`.
 */
export function egressTargetOf(exec, keys) {
  for (const key of keys) {
    const value = exec?.input?.[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const text = value.trim()
    // A scheme is what makes a value a URL. Without this test, `new URL('internal.corp:22')`
    // succeeds by reading `internal.corp` as the scheme, and `host:port` — the other form tools use
    // — would report an empty host and be refused as malformed instead of checked against the list.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const url = new URL(text)
      const port = url.port === '' ? undefined : Number(url.port)
      return { host: url.hostname, ...(port === undefined ? {} : { port }) }
    }
    const separator = text.lastIndexOf(':')
    if (separator > 0 && /^\d+$/.test(text.slice(separator + 1))) return { host: text.slice(0, separator), port: Number(text.slice(separator + 1)) }
    return { host: text }
  }
  return undefined
}
