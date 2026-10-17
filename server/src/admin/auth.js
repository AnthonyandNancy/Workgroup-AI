// Operator authentication for the local-demo Hub admin web.
//
// Operators are deliberately not `users`: they have no device, no refresh token, and cannot own a
// room. A fixed bootstrap row lives in `operators`; production changes its password or status in
// the database. Sessions are process-local because the demo runs one Hub process and a restart
// should not preserve an administrator login.
//
// The cookie is an opaque random session id, not a signed user token. It is HttpOnly, SameSite=Strict,
// and Secure when the Hub's public URL is https. State-changing requests also check Origin; a cookie
// alone is not treated as CSRF protection.

import { randomBytes, randomUUID } from 'node:crypto'
import { verifyPassword } from '../auth/password.js'

const ADMIN_COOKIE = 'hub_admin_session'
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function parseCookie(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** Shape an operator row for the browser without the password hash. */
export function publicOperator(row) {
  return {
    id: row.id,
    userHandle: row.user_handle,
    displayName: row.display_name,
    status: row.status,
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
  }
}

/**
 * Build the operator authenticator and its HTTP pre-handler.
 *
 * @param {{ db: object, secureCookies?: boolean }} options
 */
export function createAdminAuth({ db, secureCookies = false }) {
  const sessions = new Map()
  // Statements are prepared on first use rather than at server construction: health tests and
  // deployments can start the Hub before a migration has run, and constructing the admin service
  // must not turn that into a startup failure. Admin routes naturally require the table.
  const findOperator = handle => db.prepare('SELECT * FROM operators WHERE user_handle = ?').get(handle)
  const findById = id => db.prepare('SELECT * FROM operators WHERE id = ?').get(id)
  const touchLogin = (stamp, id) => db.prepare('UPDATE operators SET last_login_at = ?, updated_at = ? WHERE id = ?').run(stamp, stamp, id)

  const audit = (operatorId, eventType, objectType, objectId, details = {}) => {
    db.prepare(`INSERT INTO audit_events
      (id, actor_operator_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(),
      operatorId,
      eventType,
      objectType,
      objectId ?? null,
      'success',
      JSON.stringify(details),
      new Date().toISOString(),
    )
  }

  return {
    cookieName: ADMIN_COOKIE,

    /** Verify a fixed operator credential. Returns undefined for every refusal. */
    async login({ userHandle, password } = {}) {
      if (typeof userHandle !== 'string' || typeof password !== 'string') return undefined
      const operator = findOperator(userHandle.trim())
      if (operator === undefined || operator.status !== 'active') return undefined
      const valid = await verifyPassword(password, operator.password_hash)
      if (!valid) return undefined

      const sessionId = randomBytes(32).toString('base64url')
      sessions.set(sessionId, {
        operatorId: operator.id,
        expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
      })
      const stamp = new Date().toISOString()
      touchLogin(stamp, operator.id)
      audit(operator.id, 'admin.login', 'operator', operator.id)
      return { sessionId, operator: publicOperator({ ...operator, last_login_at: stamp }) }
    },

    logout(sessionId) {
      const record = sessions.get(sessionId)
      if (record === undefined) return
      sessions.delete(sessionId)
      audit(record.operatorId, 'admin.logout', 'operator', record.operatorId)
    },

    /** Resolve a live session to its operator, or undefined. */
    session(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      const record = sessions.get(sessionId)
      if (record === undefined) return undefined
      if (record.expiresAt <= Date.now()) {
        sessions.delete(sessionId)
        return undefined
      }
      const operator = findById(record.operatorId)
      if (operator === undefined || operator.status !== 'active') {
        sessions.delete(sessionId)
        return undefined
      }
      return publicOperator(operator)
    },

    cookie(sessionId) {
      const maxAge = Math.floor(ADMIN_SESSION_TTL_MS / 1000)
      return `${ADMIN_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`
    },

    clearCookie() {
      return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`
    },
  }
}

/** A pre-handler that accepts only an administrator cookie, never a guest Bearer token. */
export function makeRequireOperator({ adminAuth }) {
  return async function requireOperator(request, reply) {
    const sessionId = parseCookie(request.headers.cookie, adminAuth.cookieName)
    const operator = adminAuth.session(sessionId)
    if (operator === undefined) {
      return reply.code(401).send({
        error: { code: 'ADMIN_UNAUTHORIZED', message: 'Administrator authentication is required' },
      })
    }
    if (!assertSameOrigin(request)) {
      return reply.code(403).send({
        error: { code: 'CROSS_ORIGIN_REFUSED', message: 'Cross-origin administrator requests are not allowed' },
      })
    }
    request.operator = operator
    request.adminSessionId = sessionId
  }
}

/**
 * Reject a cross-site state-changing request.
 *
 * SameSite=Strict already keeps the cookie off cross-site requests; this check is the second
 * independent condition, and it also catches a browser/extension that sends an Origin the cookie
 * policy alone would not classify as cross-site.
 */
export function assertSameOrigin(request) {
  if (SAFE_METHODS.has(request.method)) return true
  const origin = request.headers.origin
  if (origin === undefined) return true
  return origin === `${request.protocol}://${request.host}`
}
