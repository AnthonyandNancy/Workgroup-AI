// Workgroup client: the Hub calls a workgroup view needs, and the state they produce.
//
// This is the layer between the Bridge (which delivers events) and the view (which renders props).
// It exists so the view never calls the Hub itself: a component that fetched would have to own
// loading, error, and staleness behaviour, and three components doing that is three chances to
// disagree about what a room currently looks like.
//
// Two rules shape everything here:
//
//   * **The Hub is the only authority.** No local cache is consulted to answer "is this person a
//     member" or "what is the head sequence". A cached membership is how a removed member keeps
//     seeing messages.
//   * **Every failure is named.** A refusal (not an admin, not a member, invitation expired) is a
//     distinct outcome with its own message, because each one tells the employee to do something
//     different. A failure that arrives as `undefined` makes the UI show an empty room.
//
// It deliberately does not handle tasks or approvals beyond listing them: A-06 owns the approval
// flow, and a second path into it would be a second place to get the authorization wrong.

/** Where a member stands in a room, as the Hub reports it. */
export const MEMBER_ROLES = Object.freeze(['owner', 'admin', 'member'])

export class WorkgroupClientError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = 'WorkgroupClientError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Create the workgroup client.
 *
 * @param {{ client: object, bridge?: object, onBotsFromDirectory?: Function }} options
 *   `client` is the A-01 Hub client; `bridge` is the A-02 Bridge, when one is running.
 */
export function createWorkgroupClient({ client, bridge, onBotsFromDirectory } = {}) {
  if (client === undefined) throw new WorkgroupClientError('A Hub client is required', 'NO_HUB_CLIENT')

  const publishedBots = async ({ ownerUserId, query } = {}) => {
    const params = new URLSearchParams()
    if (ownerUserId !== undefined) params.set('ownerUserId', ownerUserId)
    if (query !== undefined) params.set('q', query)
    const suffix = params.toString() === '' ? '' : `?${params}`
    const listed = await client.request('GET', `/bots/directory${suffix}`)
    const entries = listed.bots ?? []
    onBotsFromDirectory?.(entries)
    return entries
  }

  /** Read a room and its members' visible published Bots; private execution fields stay on the Host. */
  const openRoom = async (roomId) => {
    const [room, messages, tasks] = await Promise.all([
      client.request('GET', `/rooms/${roomId}`),
      client.request('GET', `/rooms/${roomId}/messages?limit=200`),
      // A task list read is scoped to this caller by the Hub, so a member never receives another
      // person's approvals to display.
      client.request('GET', `/rooms/${roomId}/tasks`).catch(error => {
        // A room with no tasks route answer is not a reason to fail opening the room: the
        // conversation is what the employee came for. The failure is reported, not hidden.
        if (error.status === 404) return { tasks: [] }
        throw error
      }),
    ])
    const owners = new Set(room.members.map(member => member.userId))
    const directories = await Promise.all([...owners].map(ownerUserId => publishedBots({ ownerUserId })))
    const bots = directories.flat()
      .filter(bot => owners.has(bot.ownerUserId) && ['public', 'room'].includes(bot.visibility))
      .map(({ botId, ownerUserId, displayName, visibility, state }) => ({ botId, ownerUserId, displayName, visibility, state }))
    return {
      room: room.room,
      members: room.members,
      bots,
      messages: messages.messages,
      tasks: tasks.tasks ?? [],
      head: messages.nextAfterSeq ?? 0,
    }
  }

  return {
    openRoom,

    /**
     * Upload one file into a room.
     *
     * The bytes go as the request body, so the Hub's upload limit bounds the file itself rather than a
     * base64 expansion of it. `recipients` names the people who may download it: uploading does **not**
     * publish to the room, and attaching the file to a message does not widen its ACL either — that is
     * the requirement's "non-recipients cannot download", and `shareArtifact` is the explicit way to
     * widen it.
     *
     * @param {string} roomId
     * @param {{ fileName: string, bytes: Uint8Array, contentType?: string, recipients?: string[], taskId?: string }} file
     * @returns {Promise<{ artifact: object }>}
     * @throws {WorkgroupClientError} before any request when the name or the bytes are missing, so a
     *   malformed upload is not answered by the network.
     */
    uploadArtifact: (roomId, { fileName, bytes, contentType, recipients = [], taskId } = {}) => {
      const name = String(fileName ?? '').trim()
      if (name === '') throw new WorkgroupClientError('An attachment needs a file name', 'INVALID_ATTACHMENT')
      if (!(bytes instanceof Uint8Array)) throw new WorkgroupClientError('An attachment needs its bytes', 'INVALID_ATTACHMENT')
      // Refused here rather than sent: the Hub answers this with an error, and a request whose answer is
      // already known only costs a round trip and a rate-limit slot.
      if (bytes.byteLength === 0) throw new WorkgroupClientError('An attachment must not be empty', 'INVALID_ATTACHMENT')
      const query = new URLSearchParams({ fileName: name })
      if (recipients.length > 0) query.set('recipients', recipients.join(','))
      if (taskId !== undefined) query.set('taskId', taskId)
      return client.request('POST', `/rooms/${roomId}/artifacts?${query.toString()}`, {
        binary: { bytes, contentType },
      })
    },

    /**
     * Download one artifact's bytes.
     *
     * The Hub refuses a viewer its ACL excludes, and answers as if the artifact did not exist, so this
     * throws rather than returning an empty result.
     *
     * @returns {Promise<{ bytes: Buffer, headers: object }>}
     */
    downloadArtifact: artifactId => client.request('GET', `/artifacts/${artifactId}/content`, { raw: true }),

    /** The artifacts this caller may read in one room. */
    listArtifacts: roomId => client.request('GET', `/rooms/${roomId}/artifacts`),

    /**
     * End the workgroup. Owner only; the Hub enforces that, not this call.
     *
     * Distinct from `leave` and `removeMember` on purpose — the requirement separates them, and a
     * client that offered one button for all three would let a member end a workgroup for everyone.
     */
    dissolve: roomId => client.request('POST', `/rooms/${roomId}/dissolve`, { body: {} }),

    /**
     * Invite a person by their Hub user id.
     *
     * By id because the Hub has no directory of people to search: an employee knows their
     * colleague's id out of band (it is shown in their own profile), and a search endpoint would be
     * a way to enumerate a company's accounts.
     */
    async invite(roomId, { targetUserId, role = 'member' }) {
      if (typeof targetUserId !== 'string' || targetUserId.trim() === '') {
        throw new WorkgroupClientError('Enter the user id of the colleague to invite', 'MISSING_TARGET_USER')
      }
      const created = await client.request('POST', `/rooms/${roomId}/invitations`, {
        body: { targetUserId: targetUserId.trim(), role },
      })
      return created.invitation
    },

    /** The invitations addressed to this device's user. */
    async incomingInvitations() {
      const listed = await client.request('GET', '/invitations')
      return listed.invitations
    },

    /** Accept or decline an invitation addressed to this user. */
    async respondToInvitation(invitationId, decision) {
      if (decision !== 'accept' && decision !== 'decline') {
        throw new WorkgroupClientError(`A decision must be accept or decline, got ${JSON.stringify(decision)}`, 'INVALID_DECISION')
      }
      const answered = await client.request('POST', `/invitations/${invitationId}/${decision}`, { body: {} })
      // Accepting a room means this device should receive its events from now on. Without the
      // watch the employee would sit in a room that never updates.
      //
      // The room id comes from `answered.room`: the accept route answers with the room and the new
      // membership, precisely because the invitee cannot know the room's id before accepting.
      // Declining answers with the invitation instead, and needs no watch. Read without a fallback
      // so a Hub that stops reporting the room fails here rather than leaving a silent room that
      // never updates.
      if (decision === 'accept') await bridge?.watch?.(answered.room.id)
      return answered
    },

    /** Revoke an invitation this user sent. */
    revokeInvitation: invitationId => client.request('POST', `/invitations/${invitationId}/revoke`, { body: {} }),

    /**
     * The room's members, straight from the Hub.
     *
     * Never merged with a local list: a removed member must disappear the moment the Hub says so,
     * and a local list would keep showing them until a reload.
     */
    async members(roomId) {
      const listed = await client.request('GET', `/rooms/${roomId}/members`)
      return listed.members
    },

    /** Change a member's role. The Hub refuses this for a non-admin. */
    setRole: (roomId, userId, role) => {
      if (!MEMBER_ROLES.includes(role)) {
        throw new WorkgroupClientError(`A role must be one of ${MEMBER_ROLES.join(', ')}, got ${JSON.stringify(role)}`, 'INVALID_ROLE')
      }
      return client.request('POST', `/rooms/${roomId}/members/${userId}/role`, { body: { role } })
    },

    /**
     * Remove a member.
     *
     * The Hub closes their live sockets as part of this, so a removed member stops receiving events
     * rather than continuing until their token expires. This client does not try to do that itself:
     * a client-side "stop showing messages" would be a courtesy, not a boundary.
     */
    removeMember: (roomId, userId) => client.request('POST', `/rooms/${roomId}/members/${userId}/remove`, { body: {} }),

    /** Leave a room. The Hub treats leaving like being removed, including the socket teardown. */
    leave: async (roomId) => {
      const result = await client.request('POST', `/rooms/${roomId}/leave`, { body: {} })
      bridge?.unwatch?.(roomId)
      return result
    },

    /**
     * Send a human message.
     *
     * `clientMessageId` is generated here, once per send, because it is what makes the Hub's
     * handling idempotent: a retry after a timeout with the same id is the same message, not a
     * second one. Generating it per attempt would make a retried send appear twice in the room.
     */
    sendMessage: (roomId, body, { clientMessageId = globalThis.crypto.randomUUID(), replyToMessageId, mentions, attachments } = {}) => {
      const text = String(body ?? '').trim()
      if (text === '') throw new WorkgroupClientError('A message needs some text', 'EMPTY_MESSAGE')
      return client.request('POST', `/rooms/${roomId}/messages`, {
        body: {
          clientMessageId,
          body: text,
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
          // Mentions travel as ids, and attachments as artifact ids. The Hub validates both against
          // this room, so a client cannot mention an outsider or attach another room's file.
          ...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
          ...(Array.isArray(attachments) && attachments.length > 0
            ? { attachments: attachments.map(entry => (typeof entry === 'string' ? { artifactId: entry } : entry)) }
            : {}),
        },
      })
    },

    /**
     * Messages after a sequence, for the Bridge's catch-up or a scroll-back.
     *
     * The cursor is a sequence number, never a timestamp: two messages in one millisecond would
     * make a timestamp cursor skip one.
     */
    messagesAfter: (roomId, afterSeq, limit = 200) =>
      client.request('GET', `/rooms/${roomId}/messages?afterSeq=${afterSeq}&limit=${limit}`),

    /** The room's high-water sequence, so a fresh client knows whether it is behind. */
    head: (roomId) => client.request('GET', `/rooms/${roomId}/messages/head`),

    /**
     * The Bots whose owners have published them.
     *
     * The Hub decides visibility per caller, and its answer is the whole truth: a Bot whose owner
     * has not published it is simply absent, and this client does not try to work out which Bots
     * "should" be usable in a workgroup. That is what keeps a private Bot from ever appearing as a
     * candidate to delegate to.
     *
     * There is deliberately no room filter. The Hub scopes the directory to the *caller*, not to a
     * room — `browseDirectory` takes `viewerUserId`, not a room id — so passing one would look like
     * a restriction while doing nothing. Which entries may act in a given task is decided at task
     * creation, by the Hub, against the room's membership.
     */
    publishedBots,

    /** This user's own id, which the view needs to mark their own messages. */
    get selfUserId() {
      return client.identity?.userId
    },
  }
}

/**
 * Apply one Bridge event to a room view, returning the next state.
 *
 * A pure function, so the same event applied twice produces the same state: the Bridge may deliver
 * at least once, and the reducer is where that becomes exactly-once for the view. Keeping it pure
 * also means the behaviour is testable without a socket, a Hub, or a browser.
 *
 * Unknown event types return the state unchanged rather than throwing: a newer Hub may push
 * something this client does not know yet, and refusing to render because of an unrecognised
 * notification would be worse than ignoring it.
 *
 * @param {{ room: object, members: object[], messages: object[], tasks: object[], head: number }} state
 * @param {object} event a `wg.v1` envelope
 */
export function reduceWorkgroup(state, event) {
  if (event === null || typeof event !== 'object') return state
  const eventRoomId = event.roomId ?? event.payload?.roomId
  if (eventRoomId !== undefined && eventRoomId !== state.room?.id) return state
  switch (event.type) {
    case 'message.created': {
      const message = event.payload?.message
      if (message === undefined || message.roomId !== state.room?.id) return state
      // Deduplicate by id and by sequence: the Bridge already filters, but a catch-up page and a
      // live event for the same message must still produce one row.
      const known = state.messages.some(existing => existing.id === message.id || existing.roomSeq === message.roomSeq)
      if (known) return state
      return {
        ...state,
        messages: [...state.messages, message].sort((left, right) => left.roomSeq - right.roomSeq),
        head: Math.max(state.head ?? 0, message.roomSeq),
      }
    }
    case 'presence.changed': {
      const presence = event.payload ?? {}
      const index = state.members.findIndex(member => member.userId === presence.userId)
      if (index < 0) return state
      const online = presence.online === true
      if (state.members[index].online === online) return state
      const members = [...state.members]
      members[index] = { ...members[index], online }
      return { ...state, members }
    }
    case 'member.changed': {
      const change = event.payload ?? {}
      if (change.roomId !== undefined && change.roomId !== state.room?.id) return state
      // The Hub sends the change, and the client re-reads rather than patching its own guess at
      // what the member list became. A removal that arrived with an unexpected shape would
      // otherwise leave the member visible.
      return { ...state, membersStale: true }
    }
    case 'invitation.created':
      return { ...state, invitationsStale: true }
    case 'task.approval_requested':
    case 'task.approved':
    case 'task.cancelled':
    case 'task.progress':
    case 'task.shared': {
      const task = event.payload?.task
      if (task === undefined) return { ...state, tasksStale: true }
      const others = state.tasks.filter(existing => existing.id !== task.id)
      return { ...state, tasks: [...others, task] }
    }
    default:
      return state
  }
}

/**
 * The empty state a view starts from while `openRoom` is in flight.
 *
 * An explicit shape rather than `undefined`: every render path reads `state.messages.length`, and a
 * `null` state would be a crash on first paint instead of an empty room.
 */
export function emptyWorkgroupState(roomId) {
  return { room: { id: roomId, name: '' }, members: [], messages: [], tasks: [], head: 0, loading: true }
}
