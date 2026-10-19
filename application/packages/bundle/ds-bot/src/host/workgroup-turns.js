// Workgroup turns: how a workgroup's leading Bot answers an ordinary message.
//
// The original group chat delivers a message into the administrator Bot's group Session and the Bot
// answers it like any other turn: its memory, its instructions, and its permission preset decide
// what it says and whether it acts. Nothing about that path is a task — there is no approval step
// between "somebody spoke" and "the Bot answered", because the Bot is already the owner's own agent
// working on the owner's own behalf.
//
// A workgroup keeps that model. The Hub records which Bot leads a room; this module notices a new
// message in a room this machine leads and delivers it into that Bot's long-lived Session for that
// room. The result is posted back as the Bot's own message. The cross-user *task* path is separate
// and unchanged: a colleague mentioning somebody else's Bot still produces a pending approval.
//
// Three facts make this safe to do from an event stream:
//
//   * **Only the leader answers.** `effectiveReplyMode === 'admin'` and this machine owning the
//     leader are both required, so a room where everyone answers (or whose leader is gone) does not
//     produce a second, unasked-for voice.
//   * **Each message is delivered once.** `seen` records the highest sequence delivered to each Bot
//     and is persisted, so a replayed event, a reconnect, or a restart cannot make the Bot answer
//     the same line twice.
//   * **One turn at a time per room.** A second message that arrives mid-turn waits for the queue
//     rather than starting a parallel turn, which is what keeps the Bot's replies in order.
//
// What this module cannot do: answer while its owner's machine is off. That is the same limitation
// the original group chat has — a Bot runs where its owner runs — and the room says so rather than
// pretending a message was handled.


/** How long a leader's answer may take before the queue gives up on it. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000

export function install(rt) {
  /** Rooms with a turn in progress, so a second message queues instead of running beside it. */
  const running = new Map()

  /** The signed-in Hub client, or undefined when this install has no usable Hub. */
  const signedInClient = () => {
    let client
    try {
      client = rt.hubClient?.()
    } catch {
      // No Hub configured is a supported local-only install, not a fault.
      return undefined
    }
    return client?.signedIn === true ? client : undefined
  }

  /** This machine's Hub user id, or undefined when nobody is signed in. */
  const selfUserId = () => signedInClient()?.identity?.userId

  /** One room's saved turn state, created on first use. */
  function stateFor(roomId) {
    rt.state.workgroupRooms ??= {}
    rt.state.workgroupRooms[roomId] ??= { sessions: {}, seen: {}, turns: {}, openedAt: Date.now() }
    const entry = rt.state.workgroupRooms[roomId]
    // A team file written by an earlier version may hold a partial record.
    entry.sessions ??= {}
    entry.seen ??= {}
    entry.turns ??= {}
    return entry
  }

  /** Whether this machine speaks for a room's leader. */
  function leadsRoom(room) {
    const me = selfUserId()
    if (me === undefined) return false
    if (room?.effectiveReplyMode !== 'admin') return false
    if (room.adminBotOwnerUserId !== me) return false
    return typeof room.adminBotId === 'string' && room.adminBotId !== ''
  }

  /**
   * The Bot's long-lived Session in this room, created on its first turn there.
   *
   * Created the same way the original group chat creates a member's group Session: with the room's
   * working folder when it has one, the room's permission preset when it has one, and registered as
   * a group Session so an approval request during the turn reaches the room as a card instead of
   * waiting unseen on a hidden Session.
   */
  async function sessionFor(room) {
    const state = stateFor(room.id)
    const botId = room.adminBotId
    const known = state.sessions[botId]
    if (known !== undefined) {
      await rt.ensureCapabilities?.(known)
      return known
    }
    const bot = rt.botOf?.(botId)
    if (bot === undefined) throw new Error(`The room's administrator Bot ${botId} is not on this machine`)
    const dir = room.workDir ?? bot.workDir
    const sessionId = await rt.createSession(`${bot.name} · ${room.name}`, { dir })
    state.sessions[botId] = sessionId
    // Indexed now rather than only at the next load: `approvals.js` answers a group Session's tool
    // requests with a card in that group, and a leader whose Session was not indexed yet would wait
    // for an approval nobody can see.
    rt.groupOwners?.set(sessionId, { botId, roomId: room.id })
    const ref = await rt.desiredModel?.(bot)
    if (ref !== undefined) {
      await rt.selectSessionModel?.(sessionId, splitRef(ref))
        .catch(error => rt.warn?.(`ds-bot: model for ${bot.name} in ${room.name} not applied: ${error?.message ?? error}`))
    }
    await rt.applyPermission?.(bot, sessionId, { permission: room.permission })
      .catch(error => rt.warn?.(`ds-bot: permission for ${bot.name} in ${room.name} not applied: ${error?.message ?? error}`))
    await rt.save?.()
    return sessionId
  }

  /** `provider/model`, the form `selectSessionModel` takes. */
  const splitRef = (ref) => {
    const at = String(ref ?? '').indexOf('/')
    return at === -1 ? { model: String(ref) } : { provider: String(ref).slice(0, at), model: String(ref).slice(at + 1) }
  }

  /** Whether a message should reach the leader at all. */
  function shouldAnswer(room, message, botId) {
    if (message?.senderBotId === botId) return false
    // A message that names somebody already chose who answers; the leader is not one of them.
    const mentions = Array.isArray(message?.mentions) ? message.mentions : []
    if (mentions.length > 0) return false
    const state = stateFor(room.id)
    const seen = state.seen[botId] ?? 0
    return Number.isInteger(message?.roomSeq) && message.roomSeq > seen
  }

  /** The text a turn is given: who spoke, and what they said. */
  function turnText(room, message) {
    const who = message.senderDisplayName ?? message.senderUserId ?? 'A member'
    return `[Workgroup "${room.name}" · a message from ${who}]\n${message.body ?? ''}`
  }

  /**
   * Ask the leader for an answer and post what it says.
   *
   * The reply is collected from the Bot's Session through the same waiter mechanism a group turn
   * uses, so an answer that waits for a tool approval still arrives when the approval is answered.
   */
  async function runTurn(room, message, sessionId) {
    const state = stateFor(room.id)
    const botId = room.adminBotId
    const turns = (state.turns[botId] ?? 0) + 1
    state.turns[botId] = turns
    let settled
    const answer = await new Promise((resolve) => {
      let timer
      settled = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      timer = setTimeout(() => settled({ missed: true }), TURN_TIMEOUT_MS)
      timer.unref?.()
      const exchangeId = `wg-${room.id}-${botId}-${turns}`
      rt.roomWaiters?.set(exchangeId, {
        sessionId,
        botId,
        roomId: room.id,
        resolve: settled,
        fail: failure => settled({ failure }),
        touch: () => {},
        work: () => {},
        say: () => {},
        approval: () => {},
      })
      void rt.deliver({
        toId: botId,
        sessionId,
        text: turnText(room, message),
        role: 'room',
        roomId: room.id,
        roomName: room.name,
        note: 'a member spoke; answer in the room',
        exchangeId,
      }).catch((error) => {
        rt.warn?.(`ds-bot: workgroup delivery to ${botId} failed: ${error?.message ?? error}`)
        settled(null)
      })
    })
    if (typeof answer !== 'string' || answer.trim() === '') return undefined
    const client = signedInClient()
    if (client === undefined) return undefined
    // A deterministic client id per (room, bot, turn) is what makes a retried post idempotent: the
    // Hub answers a repeat of the same id with the message it already stored.
    const posted = await client.request('POST', `/rooms/${encodeURIComponent(room.id)}/messages`, {
      body: {
        clientMessageId: `wg-turn-${room.id}-${botId}-${turns}`,
        body: answer.trim().slice(0, 32_000),
        senderBotId: botId,
      },
    }).catch((error) => {
      rt.warn?.(`ds-bot: workgroup reply from ${botId} was not posted: ${error?.message ?? error}`)
      return undefined
    })
    return posted?.message
  }

  /**
   * Handle one room event.
   *
   * Only `message.created` matters here, and only for a room this machine leads. A failure is
   * reported and swallowed: an event stream must not fail because one room's answer did not work.
   */
  async function handleRoomEvent(event) {
    if (event?.type !== 'message.created') return { answered: false, reason: 'IGNORED' }
    const room = rt.workgroupRoomState?.(event.roomId)
    if (room === undefined || !leadsRoom(room)) return { answered: false, reason: 'NOT_LEADER' }
    const message = event?.payload?.message
    if (message === undefined) return { answered: false, reason: 'NO_MESSAGE' }
    const botId = room.adminBotId
    if (!shouldAnswer(room, message, botId)) return { answered: false, reason: 'NOT_ADDRESSED' }
    const state = stateFor(room.id)
    // Claimed before the turn starts, so a second event for the same message is refused even while
    // the first is still running.
    state.seen[botId] = message.roomSeq
    await rt.save?.().catch?.(() => {})
    const previous = running.get(room.id) ?? Promise.resolve()
    const turn = previous
      .then(() => runTurn(room, message, undefined))
      .catch((error) => {
        rt.warn?.(`ds-bot: workgroup turn in ${room.id} failed: ${error?.message ?? error}`)
        return undefined
      })
    running.set(room.id, turn)
    try {
      // The Session is created inside the queued turn, so two messages arriving together cannot both
      // create one.
      const sessionId = await sessionFor(room).catch((error) => {
        rt.warn?.(`ds-bot: workgroup Session for ${room.id} failed: ${error?.message ?? error}`)
        return undefined
      })
      if (sessionId === undefined) return { answered: false, reason: 'NO_SESSION' }
      const answer = await turn
      return answer === undefined ? { answered: false, reason: 'NO_ANSWER' } : { answered: true, message: answer }
    } finally {
      if (running.get(room.id) === turn) running.delete(room.id)
    }
  }

  /**
   * Forget a room this Host no longer speaks in.
   *
   * Called when a room is dissolved or this machine's Bot leaves it: the Session is archived so the
   * Bot does not keep a hidden conversation for a room that ended, and the saved turn state goes with
   * it so a re-created room does not inherit the old watermark.
   */
  async function forgetRoom(roomId) {
    const state = rt.state.workgroupRooms?.[roomId]
    if (state === undefined) return
    for (const sessionId of Object.values(state.sessions ?? {})) {
      await rt.ctx?.workspaceRegistry?.archiveSession?.(sessionId, { stopActivity: true }).catch?.(() => {})
    }
    delete rt.state.workgroupRooms[roomId]
    running.delete(roomId)
    await rt.save?.().catch?.(() => {})
  }

  rt.onWorkgroupMessage = handleRoomEvent
  rt.forgetWorkgroupRoom = forgetRoom
  rt.workgroupTurnsView = () => Object.entries(rt.state.workgroupRooms ?? {})
    .map(([roomId, state]) => ({ roomId, sessions: { ...state.sessions }, seen: { ...state.seen } }))
}
