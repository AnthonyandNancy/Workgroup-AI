// Version facts the Hub reports on every health response and handshake.
//
// `protocolVersion` is the wire contract the Hub speaks. Clients that cannot speak it
// must be told so at handshake time rather than failing on the first unusual payload.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const protocolVersion = 'wg.v1'

let cached

/**
 * The Hub version as it should be reported to clients.
 *
 * A wrong version here is worse than a missing one: it makes a client skip a protocol
 * migration it needs. So the fallback is the literal string 'unknown' and a real read
 * failure is loud in tests, rather than a plausible-looking '0.0.0'.
 */
export function hubVersion() {
  if (cached !== undefined) return cached
  try {
    // server/src/version.js -> server/package.json is two levels up from the module.
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'))
    cached = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : 'unknown'
  } catch {
    // A packaged install may not ship package.json beside the sources; the Hub still has
    // to answer health checks rather than crash at the first request.
    cached = 'unknown'
  }
  return cached
}
