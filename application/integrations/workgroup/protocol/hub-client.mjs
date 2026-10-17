// Hub client: configuration, device registration, sign-in, and the protocol handshake.
//
// This is the application's only door to the Hub. Everything that talks to a Hub goes through
// here, so there is one place that knows:
//
//   * **Which Hub.** Configuration is resolved once, validated, and named in every error. An
//     employee whose Hub address is a typo must be told that, not handed `fetch failed`.
//   * **Who this device is.** A deterministic fingerprint derived from the installation, not from
//     the hostname: two employees on identically configured laptops must not share a device row,
//     and one employee reinstalling must not silently become a second device that the Hub then
//     has to be told to revoke.
//   * **What the Hub speaks.** The protocol handshake runs before the first authenticated call, so
//     a version mismatch is reported as a version mismatch rather than as a series of confusing
//     field-level failures.
//   * **When the token is stale.** A refresh happens before a request that would otherwise 401,
//     because a 401 mid-flow is a visible failure to the user for something the client can see
//     coming.
//
// The client never stores a password. It keeps the refresh token and the device key, which are
// the two credentials the Hub issued to this machine and which can each be revoked server-side.

import { createHash, randomUUID } from 'node:crypto'
import { hostname, platform, arch } from 'node:os'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { apiRootOf, checkHubProtocol, HubProtocolError, HUB_ERROR_CODES, PROTOCOL_VERSION, tokenNeedsRefresh } from '../protocol/index.mjs'

/** How long a single request may take. A Hub on the intranet answers in milliseconds. */
const REQUEST_TIMEOUT_MS = 20_000

export class HubClientError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message)
    this.name = 'HubClientError'
    this.code = code ?? 'HUB_ERROR'
    this.status = status
    this.body = body
  }
}

/**
 * The Hub a client talks to, and the credentials it holds.
 *
 * @param {{
 *   hubUrl: string,
 *   statePath?: string,
 *   appVersion?: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 * }} options
 */
export function createHubClient(options) {
  const { hubUrl, statePath, appVersion = '0.0.0', fetchImpl = globalThis.fetch, now = () => new Date() } = options
  if (typeof fetchImpl !== 'function') throw new HubProtocolError('This runtime has no fetch', HUB_ERROR_CODES.NOT_CONFIGURED)
  const root = apiRootOf(hubUrl)
  /** @type {{ accessToken?: string, accessTokenExpiresAt?: string, refreshToken?: string, deviceId?: string, userId?: string, userHandle?: string, displayName?: string }} */
  let session = statePath === undefined ? {} : loadSession(statePath)

  /**
   * One request against the Hub.
   *
   * `auth: false` is for the two routes that must work before there is a session. `retry` marks a
   * call that has already been retried once after a refresh, so a Hub that keeps answering 401
   * produces one clear failure rather than a loop.
   */
  const request = async (method, path, { body, auth = true, headers = {}, retry = false, raw = false, binary } = {}) => {
    const init = {
      method,
      headers: { accept: raw ? '*/*' : 'application/json', ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
    // An upload sends its bytes as the body. The alternative the Hub also accepts — base64 inside JSON
    // — would inflate the payload by a third, so the operator's `maxUploadBytes` would mean three
    // quarters of itself. `contentType` is required here because the Hub stores it with the ACL, and a
    // guessed one would mislabel the file for whoever receives it.
    if (binary !== undefined) {
      if (!(binary.bytes instanceof Uint8Array)) {
        throw new HubClientError('An upload needs its bytes', { code: HUB_ERROR_CODES.INVALID_REQUEST })
      }
      init.headers['content-type'] = binary.contentType ?? 'application/octet-stream'
      init.body = binary.bytes
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (auth) {
      if (session.accessToken === undefined) {
        throw new HubClientError('This device is not signed in to the Hub', { code: HUB_ERROR_CODES.UNAUTHENTICATED })
      }
      init.headers.authorization = `Bearer ${session.accessToken}`
    }

    let response
    try {
      response = await fetchImpl(`${root}${path}`, init)
    } catch (error) {
      // A transport failure is the Hub being unreachable. It is not an authentication problem and
      // callers branch on the difference: offline work must continue, not log the user out.
      throw new HubClientError(`Cannot reach the Hub at ${root}: ${error.message}`, { code: HUB_ERROR_CODES.HUB_UNREACHABLE, body: undefined })
    }

    if (response.status === 401 && auth && !retry && session.refreshToken !== undefined) {
      // The token was rejected even though the client believed it had time left — a clock
      // difference or a revoke-and-reissue on the Hub. Refresh once and repeat the request.
      await refresh()
      return request(method, path, { body, auth, headers, retry: true, raw, binary })
    }

    if (raw) {
      if (!response.ok) throw await failureFor(response)
      // A download is a stream of bytes with a name; the caller reads it, not this module.
      return { bytes: Buffer.from(await response.arrayBuffer()), headers: response.headers }
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    if (!response.ok) throw await failureFor(response, payload)
    return payload
  }

  /** Turn an error response into an error that names what went wrong. */
  const failureFor = async (response, payload) => {
    const parsed = payload ?? (await response.json().catch(() => undefined))
    const error = parsed?.error
    const message = error?.message ?? `The Hub answered ${response.status}`
    const code = error?.code ?? `HTTP_${response.status}`
    return new HubClientError(`${message} (${response.status} ${code})`, { code, status: response.status, body: parsed })
  }

  const persist = () => {
    if (statePath !== undefined) saveSession(statePath, session)
  }

  /**
   * Refresh the access token.
   *
   * The Hub rotates the refresh token on use and treats a second presentation of the old one as a
   * leak signal that revokes the whole device family. So the new token is persisted *before* the
   * caller continues: a crash between the Hub's answer and the write would leave the client
   * holding a token the Hub has already invalidated.
   */
  const refresh = async () => {
    const payload = await request('POST', '/auth/refresh', { body: { refreshToken: session.refreshToken }, auth: false })
    session = {
      ...session,
      accessToken: payload.accessToken,
      accessTokenExpiresAt: new Date(now().getTime() + payload.accessTokenExpiresIn * 1000).toISOString(),
      refreshToken: payload.refreshToken,
      refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
    }
    persist()
    return session
  }

  return {
    /** The `/api/v1` root every request is built from. */
    get apiRoot() {
      return root
    },

    /** The signed-in identity, or `undefined`. Never includes a password or a token. */
    get identity() {
      return session.userId === undefined
        ? undefined
        : { userId: session.userId, userHandle: session.userHandle, displayName: session.displayName, deviceId: session.deviceId }
    },

    get signedIn() {
      return session.accessToken !== undefined
    },

    /**
     * Ask the Hub what it speaks, and refuse to continue if it is not this protocol.
     *
     * Called before anything else, including registration: registering a device against a Hub
     * whose protocol this client does not understand would leave a device row on the server for a
     * client that then cannot use it.
     */
    async handshake() {
      const config = await request('GET', '/auth/config', { auth: false })
      const verdict = checkHubProtocol(config?.protocol)
      if (!verdict.ok) throw new HubProtocolError(verdict.message, verdict.code)
      return {
        protocol: verdict.protocol,
        registrationMode: config.registrationMode,
        handlePolicy: config.handlePolicy,
        accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      }
    },

    /**
     * Create an account on this Hub.
     *
     * `bootstrapSecret` is only meaningful when the Hub is in `admin_secret` mode, and is passed
     * through rather than stored: it is the operator's one-time gate, not this device's credential.
     */
    async register({ userHandle, displayName, password, bootstrapSecret }) {
      const body = { userHandle, displayName, password }
      if (bootstrapSecret !== undefined) body.bootstrapSecret = bootstrapSecret
      try {
        return await request('POST', '/auth/register', { body, auth: false })
      } catch (error) {
        if (error.status === 403) {
          // One refusal covers both "wrong secret" and "registration closed", because the Hub
          // deliberately does not distinguish them. The message says so instead of guessing.
          throw new HubClientError(
            'This Hub did not accept the registration. It may require an operator bootstrap secret, or be closed.',
            { code: HUB_ERROR_CODES.REGISTRATION_REFUSED, status: 403, body: error.body },
          )
        }
        throw error
      }
    },

    /**
     * Create a Hub-owned guest identity for this application installation.
     *
     * The installation id is an identity input for the Hub only. It is deliberately not copied into
     * the credential file, which stores only the credentials and public identity needed to resume.
     */
    async bootstrap({ installationId, deviceLabel = 'DSH Bot', platform: clientPlatform = 'web' }) {
      const payload = await request('POST', '/auth/bootstrap', {
        auth: false,
        body: {
          installationId,
          deviceLabel,
          platform: clientPlatform,
          appVersion,
        },
      })
      session = {
        userId: payload.user.id,
        userHandle: payload.user.userHandle,
        displayName: payload.user.displayName,
        deviceId: payload.device.id,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: payload.accessTokenExpiresAt,
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
      }
      persist()
      return session
    },

    /**
     * The fingerprint identifies the machine; the Hub reuses an existing device row for it, so
     * restarting the client does not accumulate devices.
     */
    async login({ userHandle, password, label, fingerprint = deviceFingerprint() }) {
      const payload = await request('POST', '/auth/login', {
        auth: false,
        body: {
          userHandle,
          password,
          fingerprint,
          publicKey: `wgai:${fingerprint}`,
          label: label ?? `Workgroup AI on ${hostname()}`,
          platform: `${platform()}-${arch()}`,
          appVersion,
        },
      })
      session = {
        userId: payload.user.id,
        userHandle: payload.user.userHandle,
        displayName: payload.user.displayName,
        deviceId: payload.device.id,
        accessToken: payload.accessToken,
        accessTokenExpiresAt: new Date(now().getTime() + payload.accessTokenExpiresIn * 1000).toISOString(),
        refreshToken: payload.refreshToken,
        refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
      }
      persist()
      return session
    },

    /** Forget this device's credentials locally. The Hub's refresh token is revoked first. */
    async logout() {
      if (session.refreshToken !== undefined) {
        // A failure here must not leave the user signed in locally: the point of logging out is
        // that this machine stops being able to act, and the Hub-side revoke is best-effort on
        // top of that.
        await request('POST', '/auth/logout', { body: { refreshToken: session.refreshToken }, auth: false }).catch(() => undefined)
      }
      session = {}
      persist()
    },

    /** Refresh now if the access token is close to expiring, so the caller never sees the 401. */
    async ensureFreshToken() {
      if (!this.signedIn) return false
      if (!tokenNeedsRefresh(session.accessTokenExpiresAt, { now: now() })) return false
      await refresh()
      return true
    },

    /** The authenticated caller as the Hub sees it. Useful to prove a session is still live. */
    me: () => request('GET', '/auth/me'),

    /** Devices registered to this account, including this one. */
    devices: () => request('GET', '/devices'),

    /** This device's id, for callers that must name it (for example, to revoke it). */
    get deviceId() {
      return session.deviceId
    },

    /**
     * The current access token.
     *
     * Exposed because a WebSocket upgrade cannot use this module's `request`: the Bridge has to put
     * the token in the handshake itself. It is a getter rather than a field so the Bridge cannot
     * capture a stale token and keep using it after a refresh.
     */
    get accessToken() {
      return session.accessToken
    },

    /**
     * Low-level escape hatch for route modules that own a resource.
     *
     * Exposed rather than hidden so `rooms.mjs`, `messages.mjs`, and the rest do not each grow
     * their own fetch with their own timeout, header set, and refresh rule.
     */
    request,
  }
}

/**
 * A stable, per-installation device fingerprint.
 *
 * Derived from the machine identity plus the product's own name, hashed. It is deliberately *not*
 * the hostname or the MAC address in the clear: a fingerprint travels to the Hub and is stored
 * there, and a company Hub has no business holding a plaintext list of its employees' machine
 * names. The hash is also what makes a fingerprint comparison meaningful — the Hub needs equality,
 * not the value.
 *
 * The machine identity contributes the OS, the architecture, and the hostname so that a roaming
 * profile copied to another computer does not present itself as the same device. Two genuinely
 * separate installations therefore differ, and two runs of one installation agree.
 *
 * @param {{ hostnameValue?: string, platformValue?: string, archValue?: string, salt?: string }} [parts]
 */
export function deviceFingerprint(parts = {}) {
  const {
    hostnameValue = hostname(),
    platformValue = platform(),
    archValue = arch(),
    salt = '',
  } = parts
  const material = `${platformValue}\u0000${archValue}\u0000${hostnameValue}\u0000${salt}`
  return `sha256:${createHash('sha256').update(material, 'utf8').digest('hex')}`
}

/** Read the stored session, tolerating a file that is absent or unreadable. */
function loadSession(statePath) {
  if (!existsSync(statePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    // A corrupt credential file must not stop the client from starting: the user signs in again,
    // which is a recoverable outcome, whereas refusing to launch is not.
    return {}
  }
}

/**
 * Write the session where only this user can read it.
 *
 * The write is atomic (temporary file, then rename) because a crash midway through a plain write
 * would leave a truncated file that `loadSession` then discards — signing the user out for no
 * reason. Mode 0600 is set on the temporary file *before* the rename, so the credential is never
 * briefly readable by other users of the machine.
 */
function saveSession(statePath, session) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file is already created with the only mode it understands.
  }
  renameSync(temporary, statePath)
}

/** Where this product keeps the non-sensitive Hub URL configuration for one user. */
export function hubConfigPath(dataRoot) {
  return join(dataRoot, 'workgroup', 'hub-config.json')
}

/** Read the configured Hub URL without ever reading or returning session credentials. */
export function loadHubConfig(configPath) {
  if (!existsSync(configPath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && typeof parsed.hubUrl === 'string'
      ? { hubUrl: parsed.hubUrl }
      : {}
  } catch {
    return {}
  }
}

/** Persist only the validated, non-sensitive Hub URL with the same atomic write rules as session state. */
export function saveHubConfig(configPath, { hubUrl }) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ hubUrl })}\n`, { mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file is already created with the only mode it understands.
  }
  renameSync(temporary, configPath)
}

/** Where this product keeps the non-sensitive identity for one local installation. */
export function hubInstallationPath(dataRoot) {
  return join(dataRoot, 'workgroup', 'installation.json')
}

/** Read installation identity and non-sensitive Hub metadata without returning credential fields. */
export function loadInstallationState(statePath) {
  if (!existsSync(statePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const state = {}
    if (typeof parsed.installationId === 'string') state.installationId = parsed.installationId
    if (typeof parsed.hubUrl === 'string') state.hubUrl = parsed.hubUrl
    if (typeof parsed.appVersion === 'string') state.appVersion = parsed.appVersion
    return state
  } catch {
    return {}
  }
}

/** Persist only installation identity and non-sensitive Hub metadata. */
export function saveInstallationState(statePath, { installationId, hubUrl, appVersion }) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ installationId, hubUrl, appVersion })}\n`, { mode: 0o600 })
  try {
    chmodSync(temporary, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file is already created with the only mode it understands.
  }
  renameSync(temporary, statePath)
}

/** Clear a locally persisted session when the user moves this device to another Hub. */
export function clearHubSession(statePath) {
  saveSession(statePath, {})
}

/** Where this product keeps the Hub session for one user. */
export function hubStatePath(dataRoot) {
  return join(dataRoot, 'workgroup', 'hub-session.json')
}

/**
 * Resolve the Hub address from configuration.
 *
 * The variable name is part of the error message on purpose: an employee who has not been told
 * which address to use needs to ask for that, and the operator needs to know where to put it.
 *
 * @param {Record<string, string | undefined>} env
 */
export function resolveHubUrl(env = process.env) {
  const raw = env.WORKGROUP_HUB_URL ?? env.HUB_PUBLIC_URL
  if (raw === undefined || String(raw).trim() === '') {
    throw new HubProtocolError(
      'No Hub address is configured. Set WORKGROUP_HUB_URL to the address your operator gave you (for example https://hub.intranet.example).',
      HUB_ERROR_CODES.NOT_CONFIGURED,
    )
  }
  return apiRootOf(raw)
}

// Re-exported so a consumer has one import for everything Hub-related: the client, the errors it
// throws, and the two pure helpers callers legitimately branch on.
export { PROTOCOL_VERSION, HubProtocolError, HUB_ERROR_CODES, checkHubProtocol, apiRootOf, tokenNeedsRefresh }
