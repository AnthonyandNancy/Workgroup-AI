// The fork's Hub connection, owned by the Host half.
//
// Workgroups are the one part of DS Bot that does not live on this machine: a workgroup is a room
// on a colleague-shared Hub, and its truth is whatever the Hub says. The browser half cannot talk
// to the Hub itself — the Hub sends no CORS headers and the client's own requests are
// same-origin — so this module is the only place a Hub connection can live, and the browser
// reaches it through the ordinary `POST /api/bot` channel.
//
// Three decisions worth stating, because each forecloses a simpler alternative:
//
//  * **The connection is optional, and its absence is a supported install.** A user with no Hub is
//    the local-only case, not a broken one: with no `WORKGROUP_HUB_URL` there is no client, the
//    browser half sees no provider, and the menu keeps upstream's entries exactly. That is why
//    nothing here throws at install time — a missing Hub address is only reported when a Hub
//    operation is actually attempted.
//  * **Nothing about the local team depends on the Hub.** Bots, local groups, private Sessions and
//    memory all work with the Hub unreachable; only the workgroup endpoints fail, and they fail
//    with a reason the user can act on.
//  * **The session is a file, not memory**, written by `hub-client` with owner-only permissions.
//    A sign-in has to outlive the process, and a token held only in memory would silently sign the
//    user out on every restart.
//
// The modules themselves come from `@deepseek-ai/dsh-workgroup`, a workspace package rather than a
// relative path out of this package: `lib/` staging copies files without rewriting imports, so a
// relative path that leaves `src/host` would resolve to a different depth once published under
// `lib/src/host`. A package name is the same string in both trees.
import { randomUUID } from 'node:crypto'
import { clearHubSession, createHubClient, hubConfigPath, hubInstallationPath, hubStatePath, loadHubConfig, loadInstallationState, resolveHubUrl, saveHubConfig, saveInstallationState } from '@deepseek-ai/dsh-workgroup/protocol/hub-client'
import { createWorkgroupClient, reduceWorkgroup } from '@deepseek-ai/dsh-workgroup/client'
import { createApprovalClient } from '@deepseek-ai/dsh-workgroup/client/approvals'
import { createBridge } from '@deepseek-ai/dsh-workgroup/bridge'

export function install(rt) {
  const { config, dshHome } = rt

  // The URL is non-sensitive configuration; the session file below remains the only place that
  // carries Hub-issued credentials. An explicit runtime value wins over the persisted value, and
  // both are normalized before a client is created.
  const statePath = config.hubStatePath ?? hubStatePath(dshHome)
  const configPath = config.hubConfigPath ?? hubConfigPath(dshHome)
  const installationPath = config.hubInstallationPath ?? hubInstallationPath(dshHome)
  const savedConfig = loadHubConfig(configPath)
  const savedInstallation = loadInstallationState(installationPath)
  const appVersion = rt.version ?? '0.0.0'
  const installationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedInstallation.installationId ?? '')
    ? savedInstallation.installationId
    : randomUUID()
  let hubUrl
  let configError
  try {
    const configuredUrl = config.hubUrl ?? savedConfig.hubUrl ?? savedInstallation.hubUrl
    hubUrl = configuredUrl === undefined
      ? resolveHubUrl(config.env ?? process.env)
      : resolveHubUrl({ WORKGROUP_HUB_URL: configuredUrl })
    saveInstallationState(installationPath, { installationId, hubUrl, appVersion })
  } catch (error) {
    configError = error
  }

  let client
  let workgroup
  let bridge
  let bridgeStarting
  let guestSessionStarting
  /** 'signed-out' before sign-in, then the Bridge's own states. Surfaced to the browser. */
  let connectionState = 'signed-out'
  let connectionDetail
  // The rooms this process is watching. Kept so a reconnect after a sign-in re-subscribes to
  // everything the user had open, rather than only the room they last touched.
  const watched = new Set()
  const roomStates = new Map()

  const publishWorkgroupEvent = event => {
    const roomId = event?.roomId
    const current = typeof roomId === 'string' ? roomStates.get(roomId) : undefined
    if (current !== undefined) {
      const next = reduceWorkgroup(current, event)
      if (next !== current) roomStates.set(roomId, next)
    }
    rt.ctx?.emit?.('workgroup/event', event)
    rt.onWorkgroupEvent?.(event)
  }

  const ensureClient = () => {
    if (configError !== undefined) throw configError
    if (client === undefined) {
      client = createHubClient({ hubUrl, statePath, appVersion })
      workgroup = createWorkgroupClient({
        client,
        bridge: {
          watch: async (roomId) => { watched.add(roomId); await bridge?.watch(roomId) },
          unwatch: roomId => { watched.delete(roomId); roomStates.delete(roomId); bridge?.unwatch(roomId) },
        },
      })
    }
    return client
  }

  /**
   * The Browser half's view of this connection.
   *
   * Deliberately free of the token, the refresh token, and the Hub's own error bodies: the browser
   * is a renderer, and a credential that reaches it has escaped the Host for no benefit.
   */
  const hubView = () => {
    const signedIn = connectionState === 'unavailable' ? false : client?.signedIn ?? false
    // `identity` rather than the session record: it carries the display fields and none of the
    // credentials, which is the only thing a renderer may have.
    const identity = client?.identity
    return {
      // `configured: false` is what tells the browser half to leave the workgroup menu entry out
      // rather than offer an action that cannot succeed.
      configured: configError === undefined,
      ...(configError === undefined && hubUrl !== undefined ? { hubUrl } : {}),
      ...(configError === undefined ? {} : { reason: configError.code ?? 'HUB_NOT_CONFIGURED', message: configError.message }),
      signedIn,
      ...(identity === undefined ? {} : { userId: identity.userId, userHandle: identity.userHandle, displayName: identity.displayName, deviceId: identity.deviceId }),
      state: connectionState,
      ...(connectionDetail === undefined ? {} : { detail: connectionDetail }),
      watchedRooms: [...watched],
    }
  }

  /** Start (or restart) the live event stream. Idempotent: the Bridge owns reconnect itself. */
  const startBridge = async () => {
    ensureClient()
    if (bridge === undefined) {
      bridge = createBridge({
        hubUrl,
        client,
        // `WebSocket` is global in modern Node; `globalThis.WebSocket` is passed explicitly so a
        // runtime without it fails at construction with a clear message instead of at first use.
        WebSocketImpl: globalThis.WebSocket,
        onEvent: publishWorkgroupEvent,
        onStateChange: (next, detail) => {
          connectionState = next
          connectionDetail = detail === undefined ? undefined : String(detail?.message ?? detail?.reason ?? detail ?? '')
          rt.warn?.('ds-bot: workgroup connection %s', next)
        },
        logger: { warn: (...args) => rt.warn?.(...args), info: (...args) => rt.warn?.(...args) },
      })
    }
    if (bridgeStarting !== undefined) return await bridgeStarting
    if (!['idle', 'closed', 'fatal'].includes(bridge.state)) return
    const starting = bridge.start([...watched]).finally(() => {
      if (bridgeStarting === starting) bridgeStarting = undefined
    })
    bridgeStarting = starting
    await starting
  }

  const ensureGuestSession = () => {
    if (guestSessionStarting !== undefined) return guestSessionStarting
    const operation = (async () => {
      const current = ensureClient()
      if (current.signedIn) {
        try {
          await current.ensureFreshToken()
        } catch (error) {
          rt.warn?.('ds-bot: persisted Hub session was not refreshed; bootstrapping a replacement: %s', error?.message ?? error)
          bridge?.stop()
          bridge = undefined
          client = undefined
          workgroup = undefined
          clearHubSession(statePath)
          connectionState = 'signed-out'
          connectionDetail = undefined
        }
      }
      if (client === current && current.signedIn) {
        await startBridge()
        return
      }
      await ensureClient().bootstrap({ installationId, deviceLabel: 'DSH Bot', platform: 'web' })
      await startBridge()
    })()
    const tracked = operation.finally(() => {
      if (guestSessionStarting === tracked) guestSessionStarting = undefined
    })
    guestSessionStarting = tracked
    return tracked
  }

  /**
   * Sign in and begin watching.
   *
   * The Bridge starts here rather than at install because there is nothing to connect with until
   * there is a session, and an unauthenticated socket would be refused by the Hub anyway.
   */
  async function signIn({ userHandle, password, label }) {
    ensureClient()
    await client.login({ userHandle, password, label })
    await startBridge()
    // Signing in is the first moment this Host can hear about approvals that happened while it was
    // away, so the approved queue is reconciled here rather than waiting for a room event.
    void rt.taskDispatchReconcile?.().catch(error => rt.warn?.('ds-bot: approved tasks were not reconciled: %s', error?.message ?? error))
    return hubView()
  }

  async function signOut() {
    try {
      await client?.logout()
    } finally {
      // Stop the stream even if the Hub-side revoke failed: the user asked to stop being signed in
      // on this machine, and a socket that keeps delivering their rooms would contradict that.
      bridge?.stop()
      bridge = undefined
      connectionState = 'signed-out'
      connectionDetail = undefined
      watched.clear()
      roomStates.clear()
    }
    return hubView()
  }

  /** Open the connection from a persisted session, without asking for credentials again. */
  async function resume() {
    ensureClient()
    if (!client.signedIn) return hubView()
    await startBridge()
    void rt.taskDispatchReconcile?.().catch(error => rt.warn?.('ds-bot: approved tasks were not reconciled: %s', error?.message ?? error))
    return hubView()
  }

  /** Switch Hub without carrying the old Hub session or watched rooms across the change. */
  async function configureHub(rawUrl) {
    const nextHubUrl = resolveHubUrl({ WORKGROUP_HUB_URL: rawUrl })
    saveHubConfig(configPath, { hubUrl: nextHubUrl })
    saveInstallationState(installationPath, { installationId, hubUrl: nextHubUrl, appVersion })
    try {
      await client?.logout()
    } finally {
      if (client === undefined) clearHubSession(statePath)
      bridge?.stop()
      bridge = undefined
      client = undefined
      workgroup = undefined
      watched.clear()
      roomStates.clear()
      hubUrl = nextHubUrl
      configError = undefined
      connectionState = 'signed-out'
      connectionDetail = undefined
    }
    return hubView()
  }

  /** Register without returning the Hub response's private or credential-shaped fields. */
  async function register({ userHandle, displayName, password, bootstrapSecret, deviceLabel }) {
    ensureClient()
    await client.handshake()
    const result = await client.register({ userHandle, displayName, password, bootstrapSecret, deviceLabel })
    const user = result?.user ?? {}
    return {
      user: {
        userId: user.userId ?? user.id,
        userHandle: user.userHandle,
        displayName: user.displayName,
      },
    }
  }

  /** Return only rooms visible to the current authenticated Hub user. */
  async function rooms() {
    ensureClient()
    const result = await client.request('GET', '/rooms')
    return result?.rooms ?? []
  }

  /**
   * The folder an approval may work in, as this machine sees it.
   *
   * The Hub records the approved scope verbatim and the executor re-checks it, but neither can
   * resolve a path on this machine. `cleanWorkDir` is the only guard that knows this disk: it
   * expands `~`, resolves symbolic links, and refuses a file, a filesystem root, a missing folder,
   * and DSH's own data roots. A path it turns into `undefined` is the team workspace — the default
   * an approval must never fall back to — so that answer is refused rather than recorded as a grant
   * that names no directory.
   */
  const approvedWorkDir = async (workDir) => {
    if (rt.cleanWorkDir === undefined) {
      // Without the folder guard an approval cannot be checked here; approving anyway would put an
      // unverified path into the scope the executor is told to enforce.
      throw Object.assign(new Error('The folder guard is unavailable, so this approval cannot be validated'), { code: 'bot/unavailable' })
    }
    const cleaned = await rt.cleanWorkDir(workDir ?? '')
    if (cleaned === undefined) {
      throw Object.assign(new Error('Approve a task in a specific folder; the team workspace is the default this approval must not fall back to'), { code: 'bot/invalid' })
    }
    return cleaned
  }

  /**
   * The workgroup endpoint table, reached from the browser half as ordinary `/api/bot` calls.
   *
   * Every method returns plain JSON. Nothing here formats a message or decides what a workgroup
   * looks like: the browser half renders, and this module reports what the Hub said.
   */
  // Extra arguments from the caller are ignored rather than declared: each call is a single awaited
  // request whose result belongs to the caller, so there is nothing here to cancel mid-flight.
  async function hubEndpoint(endpoint, body) {
    // Reads that describe the connection itself must not require a connection to answer: the
    // browser asks `hub-view` first, and a throw here would leave the UI with no way to explain
    // why the feature is off.
    if (endpoint === 'hub-view') {
      try {
        await ensureGuestSession()
      } catch (error) {
        connectionState = 'unavailable'
        connectionDetail = `${error?.code ?? 'HUB_UNAVAILABLE'}: ${error?.message ?? 'The Hub is unavailable'}`
      }
      return hubView()
    }
    if (endpoint === 'hub-configure') return await configureHub(body?.hubUrl)

    ensureClient()
    switch (endpoint) {
      case 'hub-sign-in':
        return await signIn({ userHandle: body.userHandle, password: body.password, label: body.label })
      case 'hub-sign-out':
        return await signOut()
      case 'hub-resume':
        return await resume()
      case 'hub-register':
        return await register({
          userHandle: body.userHandle,
          displayName: body.displayName,
          password: body.password,
          bootstrapSecret: body.bootstrapSecret,
          deviceLabel: body.deviceLabel,
        })
      case 'hub-rooms':
        return await rooms()
      case 'hub-open-room': {
        // An open room is a watched room: the caller's intent is to look at it, and a room that
        // showed a conversation but never updated would be a worse answer than an explicit error.
        watched.add(body.roomId)
        await startBridge()
        await bridge.watch(body.roomId)
        const state = await workgroup.openRoom(body.roomId)
        roomStates.set(body.roomId, state)
        // Opening a room is also a chance to notice an approval this Host missed.
        void rt.taskDispatchReconcile?.().catch(error => rt.warn?.('ds-bot: approved tasks were not reconciled: %s', error?.message ?? error))
        return state
      }
      case 'hub-create-room': {
        const created = await client.request('POST', '/rooms', { body: { name: body.name, kind: 'workgroup' } })
        watched.add(created.room.id)
        await startBridge()
        await bridge.watch(created.room.id)
        return created.room
      }
      case 'hub-invite':
        return await workgroup.invite(body.roomId, { targetUserId: body.targetUserId, role: body.role })
      case 'hub-invitations':
        return await workgroup.incomingInvitations()
      case 'hub-respond-invitation':
        return await workgroup.respondToInvitation(body.invitationId, body.decision)
      case 'hub-revoke-invitation':
        return await workgroup.revokeInvitation(body.invitationId)
      case 'hub-rename-room':
        return await client.request('PATCH', `/rooms/${body.roomId}`, { body: { name: body.name } })
      case 'hub-download-artifact': {
        const file = await workgroup.downloadArtifact(body.artifactId)
        return { bytes: Array.from(file.bytes), contentType: file.headers?.['content-type'] ?? 'application/octet-stream' }
      }
      case 'hub-members':
        return await workgroup.members(body.roomId)
      case 'hub-set-role':
        return await workgroup.setRole(body.roomId, body.userId, body.role)
      case 'hub-leave-room':
        return await workgroup.leave(body.roomId)
      case 'hub-dissolve':
        // A distinct endpoint from leaving or being removed: only the owner may call it, and the Hub
        // is where that is enforced.
        return await workgroup.dissolve(body.roomId)
      case 'hub-kick':
        return await workgroup.removeMember(body.roomId, body.userId)
      case 'hub-upload-artifact': {
        if (!Array.isArray(body.bytes) || !body.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
          throw Object.assign(new Error('An attachment needs valid bytes'), { code: 'bot/invalid' })
        }
        // The bytes arrive already read by the host (a file picker gives a path, not a buffer), and are
        // forwarded as bytes: wrapping them in base64 would make the Hub's upload limit mean three
        // quarters of itself.
        return await workgroup.uploadArtifact(body.roomId, {
          fileName: body.fileName,
          bytes: Uint8Array.from(body.bytes),
          contentType: body.contentType,
          recipients: Array.isArray(body.recipients) ? body.recipients : [],
        })
      }
      case 'hub-send':
        // The Hub treats `clientMessageId` as the idempotency key, so it is generated by the
        // client module (once per send) rather than restated here.
        return await workgroup.sendMessage(body.roomId, body.text, {
          ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId }),
          ...(body.replyToMessageId === undefined ? {} : { replyToMessageId: body.replyToMessageId }),
          ...(Array.isArray(body.mentions) ? {
            mentions: body.mentions.map(entry => ({
              userId: entry?.userId,
              ...(entry?.botId === undefined ? {} : { botId: entry.botId }),
            })),
          } : {}),
          ...(Array.isArray(body.attachments) ? {
            attachments: body.attachments.map(entry => ({
              artifactId: typeof entry === 'string' ? entry : entry?.artifactId,
            })),
          } : {}),
        })
      case 'hub-messages':
        return body.afterSeq === undefined
          ? await client.request('GET', `/rooms/${body.roomId}/messages?limit=${String(body.limit ?? 200)}`)
          : await workgroup.messagesAfter(body.roomId, body.afterSeq, body.limit ?? 200)
      case 'hub-head':
        return await workgroup.head(body.roomId)
      case 'hub-directory':
        return await workgroup.publishedBots({ ownerUserId: body.ownerUserId, query: body.query })
      case 'hub-tasks':
        return await client.request('GET', `/rooms/${body.roomId}/tasks`)
      case 'hub-approve-task': {
        // One mapping for the owner's decision. The Host calls the same client a programmatic
        // caller uses, so the Browser, Host, and integration layers cannot drift on field names.
        // The scope is built once, inside `decide`, from the values the owner confirmed.
        const approvals = createApprovalClient({ client, selfUserId: client.identity?.userId })
        const workDir = body.decision === 'approve' ? await approvedWorkDir(body.workDir) : undefined
        return await approvals.decide({
          taskId: body.taskId,
          decision: body.decision,
          expectedVersion: body.expectedVersion,
          ...(body.decision === 'approve' ? {
            mode: body.mode,
            botId: body.botId,
            workDir,
            tools: body.tools,
            recipients: body.recipients,
            expiresAt: body.expiresAt,
          } : {}),
        })
      }
      case 'hub-cancel-task': {
        // Cancelling is the requester's, the owner's, or a room admin's act; the Hub checks which.
        // It revokes the grants, and the owner Host stops its Session when the event arrives.
        const approvals = createApprovalClient({ client, selfUserId: client.identity?.userId })
        return await approvals.cancel(body.taskId)
      }
      case 'hub-review-task': {
        // Review is the owner's judgement on a finished result, so it goes through the same client
        // as the decision: `keep`, `share`, and `reject` are three Hub routes, and only `share`
        // carries recipients.
        const approvals = createApprovalClient({ client, selfUserId: client.identity?.userId })
        return await approvals.review(body.taskId, body.decision, {
          ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
          ...(Array.isArray(body.recipients) ? { recipients: body.recipients } : {}),
        })
      }
      case 'hub-memory':
        return await client.request('GET', `/rooms/${body.roomId}/memories`)
      case 'hub-me':
        return await client.me()
      case 'hub-devices':
        return await client.devices()
      default:
        throw Object.assign(new Error(`Unknown workgroup endpoint: ${endpoint}`), { code: 'bot/invalid' })
    }
  }

  // `configError` is deliberately not thrown here: see the module comment. The browser half reads
  // `hub-view` and shows "no Hub configured" rather than the whole Bot entry failing to activate.
  Object.assign(rt, {
    hubEndpoint,
    hubView,
    // The authenticated client itself, for the one consumer that needs to read owner-scoped task
    // detail and mint/consume a grant: the approval is a Host-side act, and routing it through the
    // browser endpoint table would put the owner's scope on a renderer's wire.
    hubClient: () => ensureClient(),
    get hubConfigured() { return configError === undefined },
    get hubSignedIn() { return client?.signedIn ?? false },
  })
}
