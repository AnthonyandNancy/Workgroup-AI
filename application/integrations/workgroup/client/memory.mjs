// Workgroup memory: what a Bot may retrieve, and how an entry is corrected.
//
// A workgroup's memory is a shared record: somebody writes down what the group decided, and later
// anybody in the group — and the Bots they authorize — can act on it. That is useful exactly to the
// extent that a reader can tell where an entry came from and whether it still holds. The
// requirement's three words are the design:
//
//   **可追溯 (traceable)** — an entry names its author, when it was written, and the message it came
//     from when it cites one. A memory that cannot be traced is an assertion nobody can check, and
//     this module refuses to present one as if it were sourced.
//
//   **可纠错 (correctable)** — revising creates a revision rather than overwriting, and the history
//     stays readable. Correcting a memory is normal, not an incident: the point is that the
//     correction is visible, so a Bot that acted on the old text can be understood rather than
//     blamed.
//
//   **可删除 (removable)** — a deletion is recorded and the entry stops being live. The audit row
//     remains, because "this was deleted" is itself a fact the group may need.
//
// What this module is careful about:
//
//   * **A Bot reads as its owner, never as itself.** The Hub authorizes by user; a Bot acting in a
//     workgroup acts for a person, and a retrieval it makes is that person's retrieval. There is no
//     code path here that reads memory "as the Bot", because such a path would be an authorization
//     the Hub never issued.
//   * **A retrieval is filtered by the Hub, not here.** The client passes what the Hub returned; a
//     client-side filter would be a second, weaker authority, and the entries it wrongly allowed
//     through would look exactly like entries the Hub allowed.
//   * **An expired or deleted entry is not presented as current.** The Hub marks `live`; this module
//     surfaces it rather than dropping it, because "this was true until March" is often the answer.

/** The scopes the Hub accepts, as it names them. */
export const MEMORY_SCOPES = Object.freeze(['room', 'author'])

export class MemoryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
  }
}

/**
 * The Hub calls a memory needs.
 *
 * @param {{ client: object }} options
 */
export function createMemoryClient({ client } = {}) {
  if (client === undefined) throw new MemoryError('A Hub client is required', 'NO_HUB_CLIENT')

  return {
    /**
     * Write something down.
     *
     * `sourceMessageId`, when given, must name a message in the same room: the Hub refuses one from
     * elsewhere, because a member quoting across a room boundary they cannot read would be a way to
     * learn what is in it.
     */
    async remember(roomId, { body, scope = 'room', sourceMessageId, expiresAt }) {
      const text = String(body ?? '').trim()
      if (text === '') throw new MemoryError('A memory needs some text', 'EMPTY_BODY')
      const created = await client.request('POST', `/rooms/${roomId}/memories`, {
        body: {
          body: text,
          scope,
          ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        },
      })
      return created.memory
    },

    /** Everything this caller may read in a room, newest first. */
    async list(roomId) {
      const listed = await client.request('GET', `/rooms/${roomId}/memories`)
      return listed.memories
    },

    /**
     * Find entries about something.
     *
     * The Hub filters by what the caller may read *and* by liveness in one query, so a tool call
     * cannot return an entry the caller is not entitled to by paging past its filter.
     */
    async search(roomId, query) {
      const text = String(query ?? '').trim()
      if (text === '') throw new MemoryError('A search needs something to look for', 'EMPTY_QUERY')
      const found = await client.request('GET', `/rooms/${roomId}/memories/search?q=${encodeURIComponent(text)}`)
      return found.memories
    },

    /** One entry, with its revision history. */
    async read(memoryId) {
      const [entry, history] = await Promise.all([
        client.request('GET', `/memories/${memoryId}`),
        client.request('GET', `/memories/${memoryId}/revisions`),
      ])
      return { memory: entry.memory, revisions: history.revisions }
    },

    /** Rewrite an entry. The previous text stays as a revision. */
    async revise(memoryId, body) {
      const text = String(body ?? '').trim()
      if (text === '') throw new MemoryError('A revision needs some text', 'EMPTY_BODY')
      const revised = await client.request('PATCH', `/memories/${memoryId}`, { body: { body: text } })
      return revised.memory
    },

    /** Remove an entry. The deletion is recorded; the audit row stays. */
    async forget(memoryId) {
      const removed = await client.request('DELETE', `/memories/${memoryId}`)
      return removed.memory
    },

    /** The revision history alone, for a UI that shows one entry's changes. */
    async history(memoryId) {
      const listed = await client.request('GET', `/memories/${memoryId}/revisions`)
      return listed.revisions
    },
  }
}

/**
 * Present an entry to a reader with its provenance intact.
 *
 * The shape is deliberately flat and complete. A view that showed only `body` would make a sourced,
 * room-scoped, in-date entry look identical to an unsourced assertion by one person — and the whole
 * point of the records is that a reader can tell.
 *
 * @param {{ memory: object, now?: Date }} input
 */
export function presentMemory({ memory, now = new Date() }) {
  if (memory === null || typeof memory !== 'object') return undefined
  // The Hub's own `live` is trusted rather than recomputed: two implementations of "is this still
  // valid" is how a client shows an expired entry as current while the Hub refuses to return it.
  const live = memory.live !== false && memory.deleted !== true
  return {
    id: memory.id,
    body: memory.body,
    scope: memory.scope,
    authorUserId: memory.authorUserId,
    // Three separate facts, because they answer three different questions: who said it, does it cite
    // something checkable, and what did it say before.
    sourced: memory.sourced === true,
    sourceMessageId: memory.sourceMessageId ?? null,
    revision: memory.revision,
    live,
    // A stale entry is presented, not hidden: "this was the answer until March" is often what a
    // reader needs, and hiding it means they cannot tell "we never wrote that down" from "we did, and
    // it changed".
    staleWhy: live ? null : (memory.deleted === true ? 'deleted' : 'expired'),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    expiresAt: memory.expiresAt ?? null,
  }
}

/**
 * What a Bot may be told, given what the Hub returned for its owner.
 *
 * The Bot is not a second principal. A retrieval is made with the owner's credential, the Hub
 * authorizes it as the owner's, and this function's job is to keep that visible in the answer a Bot
 * acts on: the entries carry their author and whether they are sourced, so a Bot that reasons from
 * one can say where it came from instead of presenting a group's decision as its own knowledge.
 *
 * It refuses to invent an entry, and it refuses to widen: an entry the Hub did not return is not
 * mentioned, because "there may be more you cannot see" is a fact the Bot has no basis to state.
 *
 * @param {{ entries: object[], now?: Date, forUserId: string }} input
 */
export function memoryForBot({ entries, now = new Date(), forUserId }) {
  if (!Array.isArray(entries)) return []
  return entries
    .map(entry => presentMemory({ memory: entry, now }))
    .filter(entry => entry !== undefined)
    .map(entry => ({
      ...entry,
      // Stated on every entry: whose credential retrieved it. A Bot quoting memory in a group must
      // be able to say "I read this as Alice", and a reader must be able to check that Alice could
      // see it.
      retrievedAs: forUserId,
    }))
}

/**
 * The citation line a Bot should attach when it uses a memory entry.
 *
 * Written here rather than left to a prompt so the same words appear whatever produced the answer.
 * An entry with no source is described as unsourced rather than given a fabricated one — a Bot that
 * cited a message id it was never given would be worse than one that said it had nothing.
 */
export function citeMemory(entry) {
  if (entry === null || typeof entry !== 'object') return ''
  const where = entry.sourced && entry.sourceMessageId !== null ? ` (from message ${entry.sourceMessageId})` : ' (unsourced)'
  const revision = entry.revision > 1 ? `, revision ${entry.revision}` : ''
  const validity = entry.live === false ? `, ${entry.staleWhy ?? 'no longer current'}` : ''
  return `group memory authored by ${entry.authorUserId}${revision}${validity}${where}`
}

/**
 * Whether a Bot may use an entry at all.
 *
 * The rule is the Hub's — a Bot acts as its owner, so what the owner may read the Bot may read — and
 * this function exists so the *negative* case is explicit in one place rather than being an implicit
 * consequence of a filter. An expired entry is not usable; a deleted one is not usable.
 */
export function isUsable(entry) {
  return entry !== null && typeof entry === 'object' && entry.live !== false && entry.deleted !== true
}
