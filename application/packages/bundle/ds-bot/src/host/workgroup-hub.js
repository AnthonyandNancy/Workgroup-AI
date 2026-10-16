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
import { createHubClient, hubStatePath, resolveHubUrl } from '@deepseek-ai/dsh-workgroup/protocol/hub-client'
import { createWorkgroupClient } from '@deepseek-ai/dsh-workgroup/client'
import { createBridge } from '@deepseek-ai/dsh-workgroup/bridge'

export function install(rt) {
  const { config, dshHome } = rt

  // A configured address is read once, at install. Reading it per call would let a mid-session
  // environment change silently move the user to a different Hub while a session file for the old
  // one is still on disk.
  let hubUrl
  let configError
  try {
    hubUrl = config.hubUrl ?? resolveHubUrl(config.env ?? process.env)
  } catch (error) {
    configError = error
  }

  const statePath = config.hubStatePath ?? hubStatePath(dshHome)
  let client
  let workgroup
  let bridge
  /** 'signed-out' before sign-in, then the Bridge's own states. Surfaced to the browser. */
  let connectionState = 'signed-out'
  let connectionDetail
  // The rooms this process is watching. Kept so a reconnect after a sign-in re-subscribes to
  // everything the user had open, rather than only the room they last touched.
  const watched = new Set()

  const ensureClient = () => {
    if (configError !== undefined) throw configError
    if (client === undefined) {
      client = createHubClient({ hubUrl, statePath, appVersion: rt.version ?? '0.0.0' })
      workgroup = createWorkgroupClient({
        client,
        bridge: { watch: async (roomId) => { watched.add(roomId); await bridge?.watch(roomId) } },
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
    const signedIn = client?.signedIn ?? false
    // `identity` rather than the session record: it carries the display fields and none of the
    // credentials, which is the only thing a renderer may have.
    const identity = client?.identity
    return {
      // `configured: false` is what tells the browser half to leave the workgroup menu entry out
      // rather than offer an action that cannot succeed.
      configured: configError === undefined,
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
        onEvent: event => { rt.onWorkgroupEvent?.(event) },
        onStateChange: (next, detail) => {
          connectionState = next
          connectionDetail = detail === undefined ? undefined : String(detail?.message ?? detail?.reason ?? detail ?? '')
          rt.warn?.('ds-bot: workgroup connection %s', next)
        },
        logger: { warn: (...args) => rt.warn?.(...args), info: (...args) => rt.warn?.(...args) },
      })
    }
    await bridge.start([...watched])
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
    }
    return hubView()
  }

  /** Open the connection from a persisted session, without asking for credentials again. */
  async function resume() {
    ensureClient()
    if (!client.signedIn) return hubView()
    await startBridge()
    return hubView()
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
    if (endpoint === 'hub-view') return hubView()

    ensureClient()
    switch (endpoint) {
      case 'hub-sign-in':
        return await signIn({ userHandle: body.userHandle, password: body.password, label: body.label })
      case 'hub-sign-out':
        return await signOut()
      case 'hub-resume':
        return await resume()
      case 'hub-open-room': {
        // An open room is a watched room: the caller's intent is to look at it, and a room that
        // showed a conversation but never updated would be a worse answer than an explicit error.
        watched.add(body.roomId)
        await startBridge()
        await bridge.watch(body.roomId)
        return await workgroup.openRoom(body.roomId)
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
      case 'hub-send':
        // The Hub treats `clientMessageId` as the idempotency key, so it is generated by the
        // client module (once per send) rather than restated here.
        return await workgroup.sendMessage(body.roomId, body.text, {
          ...(body.clientMessageId === undefined ? {} : { clientMessageId: body.clientMessageId }),
          ...(body.replyToMessageId === undefined ? {} : { replyToMessageId: body.replyToMessageId }),
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
      case 'hub-approve-task':
        return await client.request('POST', `/tasks/${body.taskId}/approve`, { body: { decision: body.decision } })
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
    get hubConfigured() { return configError === undefined },
    get hubSignedIn() { return client?.signedIn ?? false },
  })
}
