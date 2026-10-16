// E1: what the Hub signs must be exactly what the executor verifies.
//
// The two halves live in projects that cannot import each other — `server/` must deploy alone, and the
// application must not reach into it — so the encoding rule exists twice. Two copies of a rule that
// must agree byte for byte is the case where silent drift is most expensive: the Hub keeps signing
// happily, every executor refuses every real dispatch, and neither project's own suite fails, because
// each copy is internally consistent.
//
// The check is behavioural, and the Hub's own signer is the producer: it is invoked **as a subprocess**
// against its shipped source, which is how a deployment runs it and avoids the import the boundary
// forbids. The signature it emits is then verified by the application's verifier. A drift in field
// order, in the separator, or in how an absent field is written makes that verification fail here.
//
// The control case below refuses a signature over different bytes. Without it, the cases above would
// also pass against a verifier that returned `valid: true` unconditionally.

import { execFileSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SIGNED_GRANT_FIELDS, verifyGrantSignature } from '../policy/grant-signature.mjs'

const SERVER_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', 'server')
const NODE = process.env.WORKGROUP_TEST_NODE ?? process.execPath
const scratch = []

afterAll(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // A temp directory the OS still holds open is residue, not a test result.
    }
  }
})

/** A key pair for one case: the private half goes to the Hub's signer, the public half to the check. */
function newKey() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: createPublicKey(pair.publicKey.export({ type: 'spki', format: 'pem' })),
  }
}

/**
 * Have the Hub's own implementation sign a record, without importing it.
 *
 * The driver is written to a temp file and run with plain Node against the Hub's source, so the bytes
 * under test come from the shipped signer rather than from a copy kept in this file. The key travels
 * through the child's environment, the way an operator supplies it, and is never written to disk.
 */
function signWithHubImplementation(record, privatePem) {
  const dir = mkdtempSync(join(tmpdir(), 'wg-e1-parity-'))
  scratch.push(dir)
  const driver = join(dir, 'driver.mjs')
  writeFileSync(driver, [
    // A `file://` URL, not a bare Windows path: an ESM specifier must be a URL, and a `C:\...` string
    // is read as a scheme named `c`.
    `import { createGrantSigner } from ${JSON.stringify(pathToFileURL(join(SERVER_ROOT, 'src', 'modules', 'tasks', 'signing.js')).href)}`,
    "const signer = createGrantSigner({ privateKey: process.env.PARITY_KEY, keyId: 'g1' })",
    `process.stdout.write(JSON.stringify(signer.sign(${JSON.stringify(record)})))`,
  ].join('\n'))
  const out = execFileSync(NODE, [driver], { env: { ...process.env, PARITY_KEY: privatePem }, encoding: 'utf8' })
  return JSON.parse(out)
}

describe('E1 signature parity across the two projects', () => {
  it('accepts a signature the Hub implementation produced for a fully populated grant', () => {
    const { privatePem, publicKey } = newKey()
    const record = { grantId: 'g-1', taskId: 't-1', botId: 'b-1', expiresAt: '2030-01-01T00:00:00.000Z' }
    const signed = signWithHubImplementation(record, privatePem)

    expect(signed.keyId).toBe('g1')
    const verdict = verifyGrantSignature(
      { grant: { id: 'g-1', taskId: 't-1', botId: 'b-1', expiresAt: '2030-01-01T00:00:00.000Z', signature: signed.signature, keyId: signed.keyId } },
      { keys: new Map([['g1', publicKey]]) },
    )
    expect(verdict.valid).toBe(true)
  })

  it('agrees on how a nullable field is written, which is where an encoding silently drifts', () => {
    // `botId` is nullable: a task with no Bot assigned leaves it out. If one side omitted the field
    // and the other wrote an empty string, every later field would shift — and only a real dispatch
    // would notice, which is too late.
    const { privatePem, publicKey } = newKey()
    const signed = signWithHubImplementation(
      { grantId: 'g-2', taskId: 't-2', botId: null, expiresAt: '2030-01-01T00:00:00.000Z' },
      privatePem,
    )
    const verdict = verifyGrantSignature(
      { grant: { id: 'g-2', taskId: 't-2', botId: null, expiresAt: '2030-01-01T00:00:00.000Z', signature: signed.signature, keyId: signed.keyId } },
      { keys: new Map([['g1', publicKey]]) },
    )
    expect(verdict.valid).toBe(true)
  })

  it('refuses a signature over different bytes, so the cases above cannot pass by accident', () => {
    // The control. A verifier that returned `valid: true` without checking would pass the two cases
    // above; it cannot pass this one.
    const { privatePem, publicKey } = newKey()
    const pair = generateKeyPairSync('ed25519')
    expect(privatePem).toBeDefined()
    const overSomethingElse = signBytes(null, Buffer.from('a different record entirely', 'utf8'), pair.privateKey)
    const verdict = verifyGrantSignature(
      { grant: { id: 'g-1', taskId: 't-1', botId: 'b-1', expiresAt: '2030-01-01T00:00:00.000Z', signature: overSomethingElse.toString('base64'), keyId: 'g1' } },
      { keys: new Map([['g1', publicKey]]) },
    )
    expect(verdict.valid).toBe(false)
    expect(verdict.reason).toMatch(/signature/i)
  })

  it('covers the same four fields the Hub covers', () => {
    expect([...SIGNED_GRANT_FIELDS]).toEqual(['grantId', 'taskId', 'botId', 'expiresAt'])
  })
})
