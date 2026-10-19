// A workgroup fixture for suites that only need a room to exist.
//
// A workgroup requires two Bots and one of them must be its owner's Main Bot, so a test that wants
// nothing but "a room Alice owns" still has to satisfy that. Repeating the three calls in every suite
// made each one carry a copy of the rule; this module is the one place they agree on what a legal
// workgroup is.
//
// The Bot ids are numbered per call so a suite that makes several rooms in one Hub does not collide
// with itself, and the names are derived from the same number so a failure message stays readable.

let sequence = 0

/**
 * Publish two Bots for `owner` and create a workgroup led by the first.
 *
 * @param {(method: string, path: string, body?: object, token?: string) => Promise<{status: number, body: any, raw: string}>} call
 *   the suite's request helper.
 * @param {{ userId: string, token: string }} owner the person who creates the room.
 * @param {{ name?: string }} [options] the room name; defaults to a numbered one.
 * @returns the `POST /rooms` answer, so a caller asserts status the same way it would unaided.
 */
export async function makeWorkgroup(call, owner, { name } = {}) {
  sequence += 1
  const chief = `chief-${sequence}`
  const worker = `worker-${sequence}`
  for (const [botId, isChief] of [[chief, true], [worker, false]]) {
    const published = await call('POST', '/bots', { botId, displayName: botId, visibility: 'public', isChief }, owner.token)
    if (published.status !== 201) throw new Error(`fixture could not publish ${botId}: ${published.raw}`)
  }
  return call('POST', '/rooms', {
    name: name ?? `Room ${sequence}`,
    kind: 'workgroup',
    botIds: [chief, worker],
    adminBotId: chief,
  }, owner.token)
}
