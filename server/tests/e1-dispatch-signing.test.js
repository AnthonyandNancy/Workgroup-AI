// E1: dispatch credentials carry an asymmetric signature, and every way of getting it wrong is
// refused **without spending the credential**.
//
// The requirement names four attacks — forged, replayed, expired, revoked — and adds the clause that
// decides the design: a refused presentation must not consume the grant. That clause is why the
// signature cannot be bolted on after the existing one-time-use check. Today a grant is marked
// consumed in the same transaction that verifies its nonce, so a forged signature presented first
// would burn the grant and the real work would never start — a denial of service that costs the
// attacker nothing but a guessed nonce.
//
// So the signature is verified **first**, and only then is the nonce consumed. The two mechanisms
// answer different questions and both must hold:
//
//   * the **signature** answers "did the Hub issue this, unmodified?" — it is the authorization
//     proof, and it is asymmetric because the machine that verifies is not the machine that issues;
//   * the **nonce** answers "is this the first presentation?" — it is the replay defence, and it
//     stays exactly as it was.
//
// The cases below are the attacks plus the do-not-consume property, because a test that only checked
// "the dispatch was refused" would pass against an implementation that burned the grant.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'
import { createGrantSigner, verifyGrantSignature } from '../src/modules/tasks/signing.js'
import { findGrantByNonce } from '../src/modules/tasks/grants.js'

const SIGNING_KEY = 'e1-test-signing-key-long-enough-for-hs256!!'

// The Hub's grant signing key, generated per test run and handed over the way an operator hands it
// over: an environment variable. It is never written to a file, never committed, and never printed.
const GRANT_KEYS = generateKeyPairSync('ed25519')
const GRANT_PRIVATE_PEM = GRANT_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' })

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-e1-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    HUB_DATA_DIR: join(root, 'data'),
    HUB_TOKEN_SIGNING_KEY: SIGNING_KEY,
    HUB_GRANT_SIGNING_KEY: GRANT_PRIVATE_PEM,
    HUB_GRANT_SIGNING_KEY_ID: 'g1',
  })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({
      method, url: `/api/v1${path}`, headers, payload: body === undefined ? undefined : JSON.stringify(body),
    })
    let json
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body }
  }
  try {
    await run({ config, db, server, call })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

// ------------------------------------------------------------------ the signature itself

test('a signature made with the Hub key verifies, and one bit of tampering does not', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signer = createGrantSigner({ privateKey, keyId: 'k1' })
  const payload = { grantId: 'g1', taskId: 't1', botId: 'b1', expiresAt: '2030-01-01T00:00:00.000Z' }
  const signed = signer.sign(payload)
  const keys = new Map([['k1', publicKey]])

  assert.equal(verifyGrantSignature({ payload, signature: signed.signature, keyId: signed.keyId }, { keys }).valid, true)
  // One changed field must invalidate it: otherwise a captured signature could be lifted onto a
  // different task or Bot.
  assert.equal(verifyGrantSignature({ payload: { ...payload, taskId: 't2' }, signature: signed.signature, keyId: signed.keyId }, { keys }).valid, false)
  // One changed character of the signature, likewise.
  const flipped = `${signed.signature.slice(0, -2)}${signed.signature.endsWith('AA') ? 'AB' : 'AA'}`
  assert.equal(verifyGrantSignature({ payload, signature: flipped, keyId: signed.keyId }, { keys }).valid, false)
})

test('a signature from a different key pair is refused, which is the point of asymmetry', () => {
  // The attack this change exists for: an attacker who can read the Hub's database (and therefore
  // forge a nonce hash) still cannot mint a grant, because they do not hold the private key.
  const hub = generateKeyPairSync('ed25519')
  const attacker = generateKeyPairSync('ed25519')
  const payload = { grantId: 'g1', taskId: 't1', botId: 'b1', expiresAt: '2030-01-01T00:00:00.000Z' }
  const forged = createGrantSigner({ privateKey: attacker.privateKey, keyId: 'k1' }).sign(payload)
  const verdict = verifyGrantSignature({ payload, signature: forged.signature, keyId: 'k1' }, { keys: new Map([['k1', hub.publicKey]]) })
  assert.equal(verdict.valid, false)
  assert.match(verdict.reason, /signature/i)
})

test('an unknown key id is refused rather than tried against every key', () => {
  const pair = generateKeyPairSync('ed25519')
  const signed = createGrantSigner({ privateKey: pair.privateKey, keyId: 'k9' }).sign({ grantId: 'g1' })
  const verdict = verifyGrantSignature({ payload: { grantId: 'g1' }, signature: signed.signature, keyId: 'k9' }, { keys: new Map([['k1', pair.publicKey]]) })
  assert.equal(verdict.valid, false)
  assert.match(verdict.reason, /key/i)
})

test('a missing signature, key id, or key set is refused — unsigned is never acceptable', () => {
  const pair = generateKeyPairSync('ed25519')
  const keys = new Map([['k1', pair.publicKey]])
  assert.equal(verifyGrantSignature({ payload: {}, signature: undefined, keyId: 'k1' }, { keys }).valid, false)
  assert.equal(verifyGrantSignature({ payload: {}, signature: 'x', keyId: undefined }, { keys }).valid, false)
  assert.equal(verifyGrantSignature({ payload: {}, signature: 'x', keyId: 'k1' }, { keys: new Map() }).valid, false)
})

// ------------------------------------------------------------------ the attacks, end to end

/** Register two people, open a workgroup, publish a Bot, and approve a task, so a grant can be minted. */
async function taskReadyForGrant(call) {
  const register = async handle => {
    const password = `${handle}-password-long-enough`
    const registered = await call('POST', '/auth/register', { userHandle: handle, displayName: handle, password })
    assert.equal(registered.status, 201, registered.raw)
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: 'ed25519:AAAA', label: `${handle} laptop`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  const alice = await register('e1-alice')
  const bob = await register('e1-bob')
  const room = await call('POST', '/rooms', { name: 'E1', kind: 'workgroup' }, alice.token)
  assert.equal(room.status, 201, room.raw)
  await call('POST', `/rooms/${room.body.room.id}/invitations`, { targetUserId: bob.userId }, alice.token)
  const pending = await call('GET', '/invitations', undefined, bob.token)
  await call('POST', `/invitations/${pending.body.invitations[0].id}/accept`, {}, bob.token)

  // `room` visibility is the contract's cross-user case: Bob's Bot is offered to the workgroup he and
  // Alice share, and is invisible outside it. A `private` entry would not resolve for Alice at all,
  // which the BOT_NOT_AVAILABLE rule reports rather than silently dispatching to nobody.
  const bot = await call('POST', '/bots', {
    botId: 'e1-bot', displayName: 'Helper', description: 'e1', capabilities: ['search'], visibility: 'room',
  }, bob.token)
  assert.equal(bot.status, 201, bot.raw)
  const task = await call('POST', `/rooms/${room.body.room.id}/tasks`, {
    targetBotId: bot.body.bot.botId, ownerUserId: bob.userId, description: 'do the thing',
  }, alice.token)
  assert.equal(task.status, 201, task.raw)
  const approved = await call('POST', `/tasks/${task.body.task.id}/decision`, { decision: 'approve', expectedVersion: task.body.task.version }, bob.token)
  assert.equal(approved.status, 200, approved.raw)
  return { alice, bob, roomId: room.body.room.id, taskId: task.body.task.id, botId: bot.body.bot.botId }
}

test('a minted grant carries a signature and names its key, and the Hub publishes the public half', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const minted = await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)
    assert.equal(minted.status, 201, minted.raw)
    const grant = minted.body.grant
    assert.ok(typeof grant.signature === 'string' && grant.signature.length > 0, 'the grant must carry a signature')
    assert.ok(typeof grant.keyId === 'string' && grant.keyId.length > 0, 'the signature must name its key')
    // The nonce stays. It is not replaced by the signature: it remains the replay defence.
    assert.ok(typeof grant.nonce === 'string' && grant.nonce.length > 0, 'the nonce stays')

    // The verifying machine may never have seen this Hub, so the public half is reachable.
    const keys = await call('GET', '/dispatch/keys', undefined, bob.token)
    assert.equal(keys.status, 200, keys.raw)
    assert.ok(Object.keys(keys.body.keys).includes(grant.keyId), 'the published key set must include the signing key id')
  })
})

test('a forged signature is refused and the grant is NOT consumed', async () => {
  await withHub(async ({ call, db }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const minted = await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)
    const grant = minted.body.grant
    const attacker = generateKeyPairSync('ed25519')
    const forged = createGrantSigner({ privateKey: attacker.privateKey, keyId: grant.keyId })
      .sign({ grantId: grant.id, taskId: grant.taskId, botId, expiresAt: grant.expiresAt })

    const refused = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: forged.signature, keyId: forged.keyId }, bob.token)
    assert.equal(refused.status, 403, refused.raw)

    // The clause that decides the design: the legitimate dispatch still works afterwards.
    assert.equal(findGrantByNonce(db, grant.nonce).consumed_at, null, 'a forged attempt must not spend the credential')
    const legitimate = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }, bob.token)
    assert.equal(legitimate.status, 200, legitimate.raw)
  })
})

test('a grant with no signature at all is refused, and that refusal does not spend it either', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const grant = (await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)).body.grant
    const refused = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId }, bob.token)
    assert.equal(refused.status, 403, refused.raw)
    const legitimate = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }, bob.token)
    assert.equal(legitimate.status, 200, legitimate.raw)
  })
})

test('a replay is refused as already used, so the signature is not what is doing the replay defence', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const grant = (await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)).body.grant
    const body = { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }
    assert.equal((await call('POST', '/dispatch/consume', body, bob.token)).status, 200)
    const replay = await call('POST', '/dispatch/consume', body, bob.token)
    assert.equal(replay.status, 409, replay.raw)
    assert.equal(replay.body.error.code, 'GRANT_ALREADY_USED')
  })
})

test('an expired grant is refused, and expiry is checked separately from the signature', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    // A one-second TTL, then past it. The signature stays valid the whole time, which is exactly why
    // expiry cannot be left to it.
    const grant = (await call('POST', `/tasks/${taskId}/grant`, { botId, ttlSeconds: 1 }, bob.token)).body.grant
    await new Promise(resolve => setTimeout(resolve, 1200))
    const refused = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }, bob.token)
    // 410 Gone, which is the code this route already used for an expired grant before signatures
    // existed. The case is about expiry being enforced at all, not about which 4xx it is.
    assert.equal(refused.status, 410, refused.raw)
    assert.equal(refused.body.error.code, 'GRANT_EXPIRED')
  })
})

test('a revoked grant is refused, and a valid signature does not resurrect it', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const grant = (await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)).body.grant
    const cancelled = await call('POST', `/tasks/${taskId}/cancel`, {}, bob.token)
    assert.equal(cancelled.status, 200, cancelled.raw)
    const refused = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }, bob.token)
    assert.ok(refused.status === 409 || refused.status === 410, `expected a refusal, got ${String(refused.status)}: ${refused.raw}`)
  })
})

test('a grant presented from another device is refused, unchanged by this work', async () => {
  await withHub(async ({ call }) => {
    const { bob, taskId, botId } = await taskReadyForGrant(call)
    const grant = (await call('POST', `/tasks/${taskId}/grant`, { botId }, bob.token)).body.grant
    // A second device for the same person: the grant names the device it was minted for.
    const other = await call('POST', '/auth/login', {
      userHandle: 'e1-bob', password: 'e1-bob-password-long-enough', fingerprint: 'sha256:e1-bob-other', publicKey: 'ed25519:BBBB', label: 'Phone',
    })
    assert.equal(other.status, 200, other.raw)
    const refused = await call('POST', '/dispatch/consume', { nonce: grant.nonce, taskId, signature: grant.signature, keyId: grant.keyId }, other.body.accessToken)
    assert.ok(refused.status >= 400, `expected a refusal, got ${String(refused.status)}: ${refused.raw}`)
  })
})
