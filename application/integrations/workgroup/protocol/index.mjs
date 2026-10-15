// Client protocol: the version this build speaks, and the one check that must happen first.
//
// `server/contracts/` is the authority for the Hub's wire format; this module is the application
// side of it and deliberately holds no data rules of its own. It exists so there is exactly one
// place that decides "does this Hub and this client agree" — a second copy of that decision is how
// a client ends up reading fields a Hub never sent.
//
// The handshake is a *refusal*, not a negotiation. A Hub that speaks a different protocol is not
// something to work around: the client stops and says which version it needs. Guessing at an
// unknown format produces a client that appears to work while silently dropping the fields it did
// not recognise, which is the failure this check exists to prevent.

/** The protocol version this client speaks. Must be the same literal the Hub reports. */
export const PROTOCOL_VERSION = 'wg.v1'

/** Error codes the rest of the client branches on. */
export const HUB_ERROR_CODES = Object.freeze({
  UNSUPPORTED_PROTOCOL: 'UNSUPPORTED_PROTOCOL',
  HUB_UNREACHABLE: 'HUB_UNREACHABLE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  REGISTRATION_REFUSED: 'REGISTRATION_REFUSED',
})

export class HubProtocolError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'HubProtocolError'
    this.code = code
  }
}

/**
 * The major version of a protocol string, or `undefined` if it is not one.
 *
 * `wg.v1`, `wg.v2`, … The major is the only part that decides compatibility: a Hub that adds a
 * field inside v1 is still v1, and a client that demanded the whole string match would refuse a
 * compatible upgrade.
 */
export function majorOf(protocol) {
  if (typeof protocol !== 'string') return undefined
  const match = /^wg\.v(\d+)$/.exec(protocol.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * Decide whether this client can talk to a Hub that reported `protocol`.
 *
 * @param {string | undefined} protocol the Hub's `/auth/config` answer
 * @returns {{ ok: true, protocol: string } | { ok: false, code: string, message: string }}
 */
export function checkHubProtocol(protocol) {
  const theirs = majorOf(protocol)
  if (theirs === undefined) {
    return {
      ok: false,
      code: HUB_ERROR_CODES.UNSUPPORTED_PROTOCOL,
      message: `This address did not answer like a Workgroup AI Hub (it reported protocol ${JSON.stringify(protocol)}). Check HUB_PUBLIC_URL.`,
    }
  }
  const ours = majorOf(PROTOCOL_VERSION)
  if (theirs !== ours) {
    // The message names both versions and which side to change, because the person reading it is
    // an operator deciding whether to update the client or the server.
    return {
      ok: false,
      code: HUB_ERROR_CODES.UNSUPPORTED_PROTOCOL,
      message: `This client speaks ${PROTOCOL_VERSION} but the Hub speaks ${protocol}. Update ${
        theirs > ours ? 'this client' : 'the Hub'
      } before connecting.`,
    }
  }
  return { ok: true, protocol }
}

/**
 * Normalize a Hub base URL into the `/api/v1` root every request is built from.
 *
 * Accepts what an operator actually types: with or without a trailing slash, with or without the
 * `/api/v1` suffix already present. Rejecting a trailing slash would be a needless refusal for the
 * single most likely typo.
 *
 * @param {string} raw
 * @returns {string} e.g. `https://hub.example.com/api/v1`
 * @throws {HubProtocolError} when the value is not an absolute http(s) URL
 */
export function apiRootOf(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new HubProtocolError(`The Hub address must be an absolute URL, got ${JSON.stringify(raw)}`, HUB_ERROR_CODES.NOT_CONFIGURED)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HubProtocolError(`The Hub address must use http or https, got ${url.protocol}`, HUB_ERROR_CODES.NOT_CONFIGURED)
  }
  // Dropping a query or fragment silently would hide a misconfiguration such as a pasted
  // ?token=… URL, so those are refused rather than trimmed.
  if (url.search !== '' || url.hash !== '') {
    throw new HubProtocolError('The Hub address must not carry a query string or fragment', HUB_ERROR_CODES.NOT_CONFIGURED)
  }
  const path = url.pathname.replace(/\/+$/, '')
  const root = path.endsWith('/api/v1') ? path : `${path}/api/v1`
  return `${url.origin}${root}`
}

/**
 * Whether a token expiry is close enough that it should be refreshed before use.
 *
 * The skew is not paranoia: an access token that expires in the middle of a request produces a
 * 401 the client then has to retry, and on a socket upgrade that retry is a visible reconnect.
 *
 * @param {string | undefined} expiresAt ISO timestamp, when the caller knows it
 * @param {{ now?: Date, skewSeconds?: number }} [options]
 */
export function tokenNeedsRefresh(expiresAt, { now = new Date(), skewSeconds = 60 } = {}) {
  if (typeof expiresAt !== 'string') return true
  const at = Date.parse(expiresAt)
  // An unparseable expiry is treated as "refresh now": assuming a malformed value is still valid
  // means the client finds out from a 401 somewhere less convenient.
  if (Number.isNaN(at)) return true
  return at - now.getTime() <= skewSeconds * 1000
}
