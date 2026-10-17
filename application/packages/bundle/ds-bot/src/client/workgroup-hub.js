// The browser half's workgroup adapter, and the one place a workgroup becomes reachable.
//
// Until now `ctx.get('workgroupHub')` had no provider anywhere, so the workgroup menu entry never
// appeared in any install — the feature was unreachable in production even though every module it
// needed existed. This module is that provider.
//
// Why the client half rather than the host: the read site is browser code (`src/client/index.js`
// reads the service, and this bundle is built with `platform: 'browser'`), and the Host and the
// browser are two processes with two separate Cordis service stores. A Host-side
// `ctx.provide('workgroupHub', …)` is simply invisible from here. What *is* shared is the
// `POST /api/bot` channel, so the Host owns the Hub connection and this module forwards to it.
//
// Why there is still a provider object when nothing is configured: the menu gate reads a value
// captured during `apply`. Returning `undefined` for "no Hub" would mean the entry could never
// appear even after a Hub was configured and the user signed in, because nothing would re-read it.
// So the service is always provided and its `available` flag is reactive: `workgroups` is
// `undefined` until a Hub answers, and the menu appears when one does. That keeps the promise the
// menu makes to the user — the entry exists exactly when there is somewhere for a workgroup to
// live — without freezing the answer at mount time.
import { call } from './api.js'
import { createSource } from './sources.js'
import { reduceWorkgroup } from '@deepseek-ai/dsh-workgroup/client'

/**
 * Ask the Host what it knows about the Hub, and keep the answer current.
 *
 * A Host that has never been asked, or that has no Hub configured, answers the same truthful way:
 * `configured: false`. An unreachable Host is not treated as "no Hub" but as "unknown", because the
 * two need different UI — one is a setting the operator must supply, the other is a service to
 * restart — and conflating them would send a user hunting for a configuration that already exists.
 */
export function createHubBridge({ pollMs = 4000, callImpl = call } = {}) {
  const view = createSource({ phase: 'unknown', configured: false, signedIn: false, state: 'unknown' })
  let timer
  let inFlight
  let stopped = true

  const refresh = async () => {
    if (inFlight !== undefined) return inFlight
    inFlight = callImpl('hub-view')
      .then((answer) => {
        view.set({ phase: 'ready', ...answer })
        return answer
      })
      .catch((error) => {
        view.set({ phase: 'unreachable', configured: false, signedIn: false, state: 'unreachable', message: error?.message ?? 'Could not reach DSH' })
        return undefined
      })
      .finally(() => { inFlight = undefined })
    return inFlight
  }

  // A self-rescheduling timeout rather than an interval, matching the roster poll: the next ask is
  // scheduled after the previous answer, so a slow Host cannot accumulate overlapping requests, and
  // the pending handle is one variable a disposer can clear.
  const schedule = () => {
    if (stopped || pollMs <= 0) return
    timer = setTimeout(() => {
      void refresh().finally(() => { schedule() })
    }, pollMs)
  }

  return {
    view,
    refresh,
    /** Mutations go through the same Host endpoints, so the token never reaches the browser. */
    send: (endpoint, payload) => callImpl(endpoint, payload).then(async (value) => { await refresh(); return value }),
    start() {
      stopped = false
      void refresh().finally(() => { schedule() })
      return this
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * The service the team view consumes.
 *
 * `createRoom` is the only method the shipped menu calls; the rest exist because a workgroup view
 * and its settings need them, and they are gathered here so no component needs its own transport.
 * Each one goes to the Host rather than to the Hub, and each returns the Hub's answer unchanged.
 *
 * `available` is a getter over the reactive view rather than a snapshot, so a component that reads
 * it during render re-renders when the answer changes.
 */
export function createWorkgroupHub({ bridge }) {
  const invoke = (endpoint, payload) => bridge.send(endpoint, payload)
  const pending = new Map()
  const roomSources = new Map()
  const roomSource = roomId => {
    let source = roomSources.get(roomId)
    if (source === undefined) {
      source = createSource(undefined)
      roomSources.set(roomId, source)
    }
    return source
  }
  const openRoom = roomId => {
    const active = pending.get(roomId)
    if (active !== undefined) return active.promise
    const loading = { events: [] }
    pending.set(roomId, loading)
    loading.promise = invoke('hub-open-room', { roomId }).then(state => {
      const next = loading.events.reduce(reduceWorkgroup, state)
      roomSource(roomId).set(next)
      return next
    }).finally(() => { pending.delete(roomId) })
    return loading.promise
  }
  const applyEvent = event => {
    const roomId = event?.roomId
    if (typeof roomId !== 'string') return
    pending.get(roomId)?.events.push(event)
    const source = roomSources.get(roomId)
    const current = source?.getSnapshot()
    if (current === undefined) return
    const next = reduceWorkgroup(current, event)
    if (next !== current) source.set(next)
  }
  return {
    get configured() {
      return bridge.view.getSnapshot().configured === true
    },
    get available() {
      const snapshot = bridge.view.getSnapshot()
      return snapshot.configured === true && snapshot.signedIn === true
    },
    get signedIn() {
      return bridge.view.getSnapshot().signedIn === true
    },
    get state() {
      return bridge.view.getSnapshot().state
    },
    get identity() {
      const snapshot = bridge.view.getSnapshot()
      return snapshot.userId === undefined
        ? undefined
        : { userId: snapshot.userId, userHandle: snapshot.userHandle, displayName: snapshot.displayName, deviceId: snapshot.deviceId }
    },
    view: bridge.view,

    configure: value => {
      const url = typeof value === 'string' ? value : value?.url
      return invoke('hub-configure', { hubUrl: url })
    },
    register: payload => invoke('hub-register', payload),
    signIn: credentials => invoke('hub-sign-in', credentials),
    signOut: () => invoke('hub-sign-out', {}),
    resume: () => invoke('hub-resume', {}),
    rooms: () => invoke('hub-rooms', {}).then(result => result?.rooms ?? result),
    createRoom: (name, options = {}) => invoke('hub-create-room', { name, ...options }),
    openRoom,
    roomState: roomSource,
    applyEvent,
    watch: roomId => invoke('hub-open-room', { roomId }),
    dissolve: roomId => invoke('hub-dissolve', { roomId }),
    renameRoom: (roomId, patch) => invoke('hub-rename-room', { roomId, name: patch.name }),
    downloadArtifact: artifactId => invoke('hub-download-artifact', { artifactId }),
    uploadArtifact: (roomId, payload) => invoke('hub-upload-artifact', { roomId, ...payload, bytes: Array.from(payload.bytes) }),
    invite: (roomId, options) => invoke('hub-invite', { roomId, ...options }),
    invitations: () => invoke('hub-invitations', {}),
    respondToInvitation: (invitationId, decision) => invoke('hub-respond-invitation', { invitationId, decision }),
    revokeInvitation: invitationId => invoke('hub-revoke-invitation', { invitationId }),
    members: roomId => invoke('hub-members', { roomId }),
    setRole: (roomId, userId, role) => invoke('hub-set-role', { roomId, userId, role }),
    leaveRoom: roomId => invoke('hub-leave-room', { roomId }),
    removeMember: (roomId, userId) => invoke('hub-kick', { roomId, userId }),
    sendMessage: (roomId, text, options = {}) => invoke('hub-send', { roomId, text, ...options }),
    messages: (roomId, options = {}) => invoke('hub-messages', { roomId, ...options }),
    head: roomId => invoke('hub-head', { roomId }),
    directory: options => invoke('hub-directory', options ?? {}),
    tasks: roomId => invoke('hub-tasks', { roomId }),
    answerTask: (taskId, decision, options = {}) => invoke('hub-approve-task', { taskId, decision, ...options }),
    // Keep, share, or reject a finished result. Sharing names recipients; the other two publish
    // nothing, which is why they need no recipient list.
    reviewTask: (taskId, decision, options = {}) => invoke('hub-review-task', { taskId, decision, ...options }),
    // Stop a task this user may cancel (the requester, the owner, or a room admin). The Hub decides
    // who that is; the pane only offers the control to those it can already identify.
    cancelTask: taskId => invoke('hub-cancel-task', { taskId }),
    memory: roomId => invoke('hub-memory', { roomId }),
    me: () => invoke('hub-me', {}),
    devices: () => invoke('hub-devices', {}),
  }
}
