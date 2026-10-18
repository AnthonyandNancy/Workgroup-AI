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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { clearHubSession, createHubClient, hubConfigPath, hubInstallationPath, hubStatePath, loadHubConfig, loadInstallationState, resolveHubUrl, saveHubConfig, saveInstallationState } from '@deepseek-ai/dsh-workgroup/protocol/hub-client'
import { createWorkgroupClient, reduceWorkgroup } from '@deepseek-ai/dsh-workgroup/client'
import { createApprovalClient } from '@deepseek-ai/dsh-workgroup/client/approvals'
import { createBridge } from '@deepseek-ai/dsh-workgroup/bridge'

/**
 * How often a published Bot reports its presence.
 *
 * The Hub treats a heartbeat older than 90 seconds as offline, so a minute leaves a full interval
 * of slack for a slow request without ever reporting a running Host as gone. The value follows
 * from that TTL rather than from taste: a longer period would flap, a shorter one would only add
 * load.
 */
export const BOT_HEARTBEAT_MS = 60_000

/** A rename arrives as a burst of saves; one directory pass per burst is enough. */
export const BOT_SYNC_DEBOUNCE_MS = 250

/**
 * How often a scheduled workgroup message is retried after the Hub refuses it.
 *
 * A schedule is a promise to the person who set it, so a refusal is kept and retried rather than
 * dropped; five minutes is long enough not to hammer a Hub that is down and short enough that a
 * transient failure still lands while the sender is at their desk.
 */
export const SCHEDULE_RETRY_MS = 300_000

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
  // What this Host has told the Hub identity it is signed in as, `botId -> { displayName, visibility }`.
  // It is the difference between a save and a directory write: most saves (messages, flags, prefs)
  // change nothing the directory shows, and must not produce Hub traffic. The visibility is
  // remembered rather than assumed: a rename must not reset an owner's sharing decision to private.
  const publishedBots = new Map()
  // Whether the owner's existing directory entries were read for this sign-in; reset with the identity.
  let directoryRead = false

  // ---------------------------------------------------------------- scheduled messages
  //
  // A workgroup's scheduled message is the Host's promise, not the window's: the browser may be
  // closed when it is due, and a message that only fires while somebody is looking is not the
  // behaviour the original composer offers. The queue is a small JSON file beside the team's own
  // state, written atomically, so a restart keeps what was scheduled and a send that failed keeps
  // its reason instead of disappearing.

  const schedulesPath = join(rt.home ?? rt.dshHome ?? '.', 'workgroup-schedules.json')
  const loadSchedules = () => {
    try {
      const parsed = JSON.parse(readFileSync(schedulesPath, 'utf8'))
      const entries = Array.isArray(parsed) ? parsed : []
      return Object.fromEntries(entries
        .filter(entry => entry && typeof entry.id === 'string' && typeof entry.roomId === 'string' && typeof entry.text === 'string' && Number.isFinite(entry.at))
        .map(entry => [entry.id, entry]))
    } catch {
      // No file yet, or one this build cannot read: scheduling starts empty rather than throwing at
      // install, because a bad queue must not take the whole Bot team down.
      return {}
    }
  }
  let schedules = loadSchedules()
  let scheduleTimer
  const persistSchedules = () => {
    try {
      mkdirSync(dirname(schedulesPath), { recursive: true })
      const temporary = `${schedulesPath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(Object.values(schedules), null, 2))
      renameSync(temporary, schedulesPath)
    } catch (error) {
      rt.warn?.('ds-bot: scheduled workgroup messages were not saved: %s', error?.message ?? error)
    }
  }
  const scheduleList = () => Object.values(schedules).sort((left, right) => left.at - right.at)
  const armSchedules = () => {
    if (scheduleTimer !== undefined) { clearTimeout(scheduleTimer); scheduleTimer = undefined }
    if (publishingStopped) return
    const next = scheduleList()[0]
    if (next === undefined) return
    const wait = next.at - Date.now()
    // A signed-out Host cannot send; waking to the same due entry immediately would spin. Waiting a
    // retry interval keeps the queue alive until the next sign-in.
    const delay = Math.max(0, client?.signedIn === true ? wait : Math.max(wait, SCHEDULE_RETRY_MS))
    scheduleTimer = setTimeout(() => { scheduleTimer = undefined; void fireDueSchedules() }, Math.min(delay, 2_147_483_647))
    scheduleTimer.unref?.()
  }
  const fireDueSchedules = async () => {
    const current = client
    if (publishingStopped) return
    if (current?.signedIn !== true) { armSchedules(); return }
    const due = scheduleList().filter(entry => entry.at <= Date.now())
    for (const entry of due) {
      try {
        await workgroup.sendMessage(entry.roomId, entry.text, { clientMessageId: entry.clientMessageId })
        delete schedules[entry.id]
      } catch (error) {
        // Kept, with the reason and a later attempt: a scheduled message the sender believes in
        // must not vanish because the Hub was briefly unavailable.
        if (schedules[entry.id] !== undefined) {
          schedules[entry.id] = { ...entry, at: Date.now() + SCHEDULE_RETRY_MS, lastError: error?.message ?? String(error) }
        }
      }
    }
    persistSchedules()
    armSchedules()
  }
  let heartbeatTimer
  let syncTimer
  let syncChain = Promise.resolve()
  let syncPending = false
  let syncQueued = false
  let publishingStopped = false
  // Bumped whenever the Hub identity changes, so a pass still in flight for the previous identity
  // cannot record its answers against the new one.
  let publishGeneration = 0
  // With the flags initialized, a queue restored from disk can arm its first due time.
  armSchedules()

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
          resetBotPublishing()
        }
      }
      if (client === current && current.signedIn) {
        await startBridge()
        void requestBotSync()
        return
      }
      await ensureClient().bootstrap({ installationId, deviceLabel: 'DSH Bot', platform: 'web' })
      await startBridge()
      void requestBotSync()
    })()
    const tracked = operation.finally(() => {
      if (guestSessionStarting === tracked) guestSessionStarting = undefined
    })
    guestSessionStarting = tracked
    return tracked
  }

  /** The local Bots that belong in the Hub directory. */
  const localBots = () => Object.values(rt.state?.bots ?? {}).filter(bot => (
    typeof bot?.id === 'string' && bot.id !== '' && typeof bot?.name === 'string' && bot.name.trim() !== ''
  ))

  const warnDirectory = (action, botId, error) => {
    rt.warn?.('ds-bot: could not %s Bot %s in the Hub directory: %s', action, botId, error?.message ?? error)
  }

  const heartbeatBot = async (current, botId) => {
    try {
      await current.request('POST', `/bots/${encodeURIComponent(botId)}/heartbeat`, { body: { state: 'online' } })
    } catch (error) {
      // Presence is a convenience, so a Hub that is briefly unreachable stays a warning: the Bot
      // still answers its owner, and the next heartbeat repairs the directory when the Hub returns.
      rt.warn?.('ds-bot: Bot %s heartbeat was not recorded: %s', botId, error?.message ?? error)
    }
  }

  /**
   * Learn what the signed-in identity has already published, once per sign-in.
   *
   * A Host that was not running when a Bot was deleted cannot have withdrawn it, so the directory
   * keeps an offline entry nobody can publish again. Reading the owner's own entries first lets this
   * pass withdraw those stale rows and, just as importantly, remember the visibility the owner
   * chose — a rename must republish the same sharing decision, not reset it to private.
   *
   * A failed read is a warning, not a reason to skip publishing: the local team still needs its
   * directory entries, and a later pass retries the reconciliation.
   */
  async function reconcileDirectory(current) {
    const ownerUserId = current.identity?.userId
    if (typeof ownerUserId !== 'string' || ownerUserId === '') return false
    let listed
    try {
      listed = await current.request('GET', `/bots/directory?ownerUserId=${encodeURIComponent(ownerUserId)}`)
    } catch (error) {
      rt.warn?.('ds-bot: the Bot directory could not be read: %s', error?.message ?? error)
      return false
    }
    const entries = Array.isArray(listed?.bots) ? listed.bots : []
    const localIds = new Set(localBots().map(bot => bot.id))
    for (const entry of entries) {
      if (typeof entry?.botId !== 'string' || entry.botId === '') continue
      if (!localIds.has(entry.botId)) {
        try {
          await current.request('POST', `/bots/${encodeURIComponent(entry.botId)}/withdraw`, { body: {} })
        } catch (error) {
          if (error?.code !== 'NO_SUCH_ENTRY') warnDirectory('withdraw', entry.botId, error)
        }
        continue
      }
      if (!publishedBots.has(entry.botId)) {
        publishedBots.set(entry.botId, {
          displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
          visibility: entry.visibility === 'room' || entry.visibility === 'public' ? entry.visibility : 'private',
        })
      }
    }
    return true
  }

  /**
   * Publish the local team's Bots to the Hub directory, and withdraw the ones this Host published
   * that are no longer part of the team.
   *
   * The directory is discovery and presence, not room membership. A Bot is published private unless
   * its owner shared it; the owner can still add it to a room either way. No model, Session, path,
   * or capability field is sent.
   */
  async function syncLocalBots() {
    const current = client
    if (publishingStopped || current?.signedIn !== true) return
    const generation = publishGeneration
    if (!directoryRead) directoryRead = await reconcileDirectory(current)
    if (generation !== publishGeneration) return
    const bots = localBots()
    const ids = new Set(bots.map(bot => bot.id))
    for (const botId of Array.from(publishedBots.keys())) {
      if (ids.has(botId)) continue
      try {
        await current.request('POST', `/bots/${encodeURIComponent(botId)}/withdraw`, { body: {} })
      } catch (error) {
        // A withdraw that finds nothing to withdraw has already achieved what it was for.
        if (error?.code !== 'NO_SUCH_ENTRY') {
          warnDirectory('withdraw', botId, error)
          continue
        }
      }
      if (generation !== publishGeneration) return
      publishedBots.delete(botId)
    }
    for (const bot of bots) {
      const displayName = bot.name.trim()
      // The Hub entry is keyed by (owner, botId) and updated in place, so an unchanged name needs
      // no request at all: this is what keeps ordinary saves out of the directory. The visibility
      // is the one already recorded, so a rename does not silently narrow a shared Bot.
      const known = publishedBots.get(bot.id)
      if (known?.displayName === displayName && known.visibility !== undefined) continue
      const visibility = known?.visibility ?? 'private'
      try {
        await current.request('POST', '/bots', {
          // The whole body: the directory holds a name, a visibility decision, and the id this
          // runtime answers for. Instructions, model, Session, folder, tools, and capabilities are
          // execution details and never leave this machine.
          body: { botId: bot.id, displayName, visibility },
        })
      } catch (error) {
        warnDirectory('publish', bot.id, error)
        continue
      }
      if (generation !== publishGeneration) return
      publishedBots.set(bot.id, { displayName, visibility })
      // Publishing records an intention to be reachable; the first heartbeat is what makes the
      // entry online, so it follows immediately rather than waiting a whole interval.
      await heartbeatBot(current, bot.id)
    }
  }

  /** One heartbeat round for every Bot this Host has published. */
  const heartbeatPublishedBots = async () => {
    const current = client
    if (publishingStopped || current?.signedIn !== true) return
    for (const botId of Array.from(publishedBots.keys())) await heartbeatBot(current, botId)
  }

  /**
   * Keep presence fresh while this Host runs.
   *
   * A self-rescheduling timeout rather than an interval: a slow Hub cannot stack overlapping
   * rounds, and there is one handle for sign-out, a Hub switch, and disposal to clear.
   */
  const scheduleHeartbeat = () => {
    if (publishingStopped || heartbeatTimer !== undefined || publishedBots.size === 0 || client?.signedIn !== true) return
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined
      void heartbeatPublishedBots().finally(() => { scheduleHeartbeat() })
    }, BOT_HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }

  /** Coalesce the saves around a rename or a deletion into one directory pass. */
  const scheduleBotSync = () => {
    if (publishingStopped || client?.signedIn !== true) return
    if (syncTimer !== undefined) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      void requestBotSync()
    }, BOT_SYNC_DEBOUNCE_MS)
    syncTimer.unref?.()
  }

  /**
   * Run at most one directory pass at a time, and keep the heartbeat alive after each one.
   *
   * Two passes racing over the same save could publish a Bot twice, or withdraw it between its
   * publish and its heartbeat. A request that arrives during a pass asks for one more pass rather
   * than a parallel one, so a change made while the pass was reading is still seen.
   */
  const requestBotSync = () => {
    if (publishingStopped || client?.signedIn !== true) return syncChain
    if (syncPending) {
      syncQueued = true
      return syncChain
    }
    syncPending = true
    syncChain = syncChain.then(async () => {
      try {
        do {
          syncQueued = false
          await syncLocalBots()
        } while (syncQueued && !publishingStopped)
      } catch (error) {
        rt.warn?.('ds-bot: local Bots were not published: %s', error?.message ?? error)
      } finally {
        syncPending = false
        syncQueued = false
        scheduleHeartbeat()
        // A sign-in may have happened while a due message waited for it.
        armSchedules()
      }
    })
    return syncChain
  }

  /** Forget what the previous Hub identity was told; the next pass republishes under the new one. */
  const resetBotPublishing = () => {
    publishGeneration += 1
    directoryRead = false
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer)
    if (syncTimer !== undefined) clearTimeout(syncTimer)
    heartbeatTimer = undefined
    syncTimer = undefined
    publishedBots.clear()
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
    // A sign-in replaces whatever identity published the directory before (a guest session, or
    // another account on this machine). Directory entries are owned per user, so this Host's Bots
    // have to be published again under the account that is signed in now.
    resetBotPublishing()
    await startBridge()
    void requestBotSync()
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
      resetBotPublishing()
    }
    return hubView()
  }

  /** Open the connection from a persisted session, without asking for credentials again. */
  async function resume() {
    ensureClient()
    if (!client.signedIn) return hubView()
    await startBridge()
    void requestBotSync()
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
      resetBotPublishing()
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
        const created = await client.request('POST', '/rooms', {
          body: {
            name: body.name,
            kind: 'workgroup',
            ...(Array.isArray(body.botIds) && body.botIds.length > 0 ? { botIds: body.botIds } : {}),
          },
        })
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
      case 'hub-update-notice':
        return await client.request('PATCH', `/rooms/${body.roomId}`, { body: { notice: body.notice } })
      case 'hub-add-bot':
        return await client.request('POST', `/rooms/${body.roomId}/bots`, { body: { botId: body.botId } })
      case 'hub-remove-bot':
        return await client.request('DELETE', `/rooms/${body.roomId}/bots/${encodeURIComponent(body.ownerUserId)}/${encodeURIComponent(body.botId)}`)
      case 'hub-bot-invitations': {
        // The Hub answers `{ invitations }`; the Browser's roster wants the list itself, and a
        // wrapper object reaching it would read as "no invitations" rather than as a shape mismatch.
        const listed = await client.request('GET', '/bot-invitations')
        return listed.invitations ?? []
      }
      case 'hub-invite-bot':
        return await client.request('POST', `/rooms/${body.roomId}/bot-invitations`, {
          body: { ownerUserId: body.ownerUserId, botId: body.botId },
        })
      case 'hub-respond-bot-invitation':
        return await client.request('POST', `/bot-invitations/${body.invitationId}/${body.decision}`, { body: {} })
      case 'hub-task-events':
        return await client.request('GET', `/rooms/${body.roomId}/task-events?limit=${String(body.limit ?? 100)}${body.before === undefined ? '' : `&before=${encodeURIComponent(body.before)}`}`)
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
      case 'hub-bot-candidates':
        // The caller's own Bots plus the ones other members published and made visible to them.
        // The Hub filters by membership and visibility; this Host only forwards.
        return await client.request('GET', `/rooms/${body.roomId}/bot-candidates`)
      case 'hub-workgroup-schedules':
        return { schedules: scheduleList() }
      case 'hub-schedule-workgroup-message': {
        const text = String(body.text ?? '').trim()
        const at = Number(body.at)
        if (typeof body.roomId !== 'string' || body.roomId === '') {
          throw Object.assign(new Error('A scheduled message needs a room'), { code: 'bot/invalid' })
        }
        if (text === '') throw Object.assign(new Error('A scheduled message needs its text'), { code: 'bot/invalid' })
        if (!Number.isFinite(at) || at <= 0) {
          throw Object.assign(new Error('A scheduled message needs a time'), { code: 'bot/invalid' })
        }
        const entry = {
          id: randomUUID(),
          roomId: body.roomId,
          text,
          at,
          // The idempotency key is minted once, here: a retry after a timeout must not produce a
          // second message, and it survives a Host restart with the entry.
          clientMessageId: typeof body.clientMessageId === 'string' && body.clientMessageId !== '' ? body.clientMessageId : randomUUID(),
          createdAt: new Date().toISOString(),
        }
        schedules[entry.id] = entry
        persistSchedules()
        armSchedules()
        return { schedule: entry, schedules: scheduleList() }
      }
      case 'hub-cancel-workgroup-schedule': {
        if (schedules[body.id] === undefined) {
          throw Object.assign(new Error('No such scheduled message'), { code: 'bot/invalid' })
        }
        delete schedules[body.id]
        persistSchedules()
        armSchedules()
        return { schedules: scheduleList() }
      }
      case 'hub-set-bot-visibility': {
        // The owner decides who may discover a Bot. Re-publishing the entry records that decision in
        // the directory; nothing about the Bot's execution leaves this machine.
        const bot = localBots().find(entry => entry.id === body.botId)
        if (bot === undefined) throw Object.assign(new Error('No such local Bot'), { code: 'bot/invalid' })
        if (body.visibility !== 'private' && body.visibility !== 'room') {
          throw Object.assign(new Error('Visibility must be private or room'), { code: 'bot/invalid' })
        }
        const displayName = bot.name.trim()
        const published = await client.request('POST', '/bots', {
          body: { botId: bot.id, displayName, visibility: body.visibility },
        })
        publishedBots.set(bot.id, { displayName, visibility: body.visibility })
        return published
      }
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
      case 'hub-memory-search': {
        const query = new URLSearchParams({ q: String(body.query ?? '') })
        return await client.request('GET', `/rooms/${body.roomId}/memories/search?${query.toString()}`)
      }
      case 'hub-memory-create':
        return await client.request('POST', `/rooms/${body.roomId}/memories`, {
          body: {
            body: body.body,
            ...(body.scope === undefined ? {} : { scope: body.scope }),
            ...(body.sourceMessageId === undefined ? {} : { sourceMessageId: body.sourceMessageId }),
            ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          },
        })
      case 'hub-memory-revise':
        return await client.request('PATCH', `/memories/${body.memoryId}`, {
          body: {
            body: body.body,
            expectedRevision: body.expectedRevision,
            ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          },
        })
      case 'hub-memory-delete':
        return await client.request('DELETE', `/memories/${body.memoryId}`)
      case 'hub-me':
        return await client.me()
      case 'hub-devices':
        return await client.devices()
      default:
        throw Object.assign(new Error(`Unknown workgroup endpoint: ${endpoint}`), { code: 'bot/invalid' })
    }
  }

  // Bot creation, renames, and deletions all commit through `rt.save`, so that is where the
  // directory learns about them. The wrapper schedules work and returns the save's own promise
  // untouched, so a failed write still fails exactly as it did; the directory pass re-reads the
  // team when it runs. The state lives in this install, so two DSH hosts cannot share it.
  const saveBeforeHubPublish = rt.save
  if (typeof saveBeforeHubPublish === 'function') {
    rt.save = (...args) => {
      const saved = saveBeforeHubPublish(...args)
      scheduleBotSync()
      return saved
    }
  }

  // A disposed plugin must not keep a timer or keep writing to a Hub the Bot no longer belongs to.
  rt.ctx?.effect?.(() => () => {
    publishingStopped = true
    if (scheduleTimer !== undefined) clearTimeout(scheduleTimer)
    scheduleTimer = undefined
    resetBotPublishing()
  }, 'ds-bot: Hub Bot directory')

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
