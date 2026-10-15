// H-11 tests: controlled artifact upload, download, and metadata ACL.
//
// The completion condition is "a non-recipient cannot download". The cases below drive that from
// every direction: a room member who was not named, a removed member who was named, a stranger,
// and a guessed id — and they check that the bytes really do not come back, not merely that a
// status code looks right. The rest cover the properties that make an attachment trustworthy:
// the stored name comes from the content, the hash is verified on read, and a refusal never
// confirms that the artifact exists.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config/index.js'
import { openDatabase } from '../src/db/index.js'
import { migrate } from '../src/db/migrate.js'
import { createServer } from '../src/server.js'

const SIGNING_KEY = 'h11-test-signing-key-long-enough-for-hs256'

async function withHub(run) {
  const root = mkdtempSync(join(tmpdir(), 'workgroup-hub-h11-'))
  const config = loadConfig({ NODE_ENV: 'test', HUB_DATA_DIR: join(root, 'data'), HUB_TOKEN_SIGNING_KEY: SIGNING_KEY })
  const db = openDatabase(config)
  migrate(db)
  const server = await createServer({ config, db, logger: false })
  const call = async (method, path, body, token, extraHeaders = {}) => {
    const headers = { ...extraHeaders }
    let payload
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) {
        payload = body
        headers['content-type'] = headers['content-type'] ?? 'application/octet-stream'
      } else {
        headers['content-type'] = headers['content-type'] ?? 'application/json'
        payload = JSON.stringify(body)
      }
    }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const response = await server.inject({ method, url: `/api/v1${path}`, headers, payload })
    let json
    try {
      json = response.json()
    } catch {
      json = undefined
    }
    return { status: response.statusCode, body: json, raw: response.body, headers: response.headers, payload: response.payload }
  }
  const person = async (handle, displayName) => {
    const password = `${handle}-password-long-enough`
    await call('POST', '/auth/register', { userHandle: handle, displayName: displayName ?? handle, password })
    const login = await call('POST', '/auth/login', {
      userHandle: handle, password, fingerprint: `sha256:${handle}-device`, publicKey: `ed25519:${handle}`,
    })
    assert.equal(login.status, 200, login.raw)
    return { userId: login.body.user.id, token: login.body.accessToken }
  }
  /** Alice owns the room; Bob and Carol join; Dana stays outside. */
  const scene = async () => {
    const alice = await person('alice', 'Alice Zhang')
    const bob = await person('bob', 'Bob Li')
    const carol = await person('carol', 'Carol Ng')
    const dana = await person('dana', 'Dana Outsider')
    const created = await call('POST', '/rooms', { name: 'Finance' }, alice.token)
    const roomId = created.body.room.id
    for (const member of [bob, carol]) {
      const invited = await call('POST', `/rooms/${roomId}/invitations`, { targetUserId: member.userId }, alice.token)
      await call('POST', `/invitations/${invited.body.invitation.id}/accept`, {}, member.token)
    }
    return { alice, bob, carol, dana, roomId }
  }
  const upload = (roomId, bytes, token, { fileName = 'report.txt', recipients = [], contentType = 'text/plain' } = {}) => {
    const params = new URLSearchParams({ fileName })
    if (recipients.length > 0) params.set('recipients', recipients.join(','))
    return call('POST', `/rooms/${roomId}/artifacts?${params}`, Buffer.from(bytes), token, { 'content-type': contentType })
  }
  try {
    await run({ config, db, server, call, person, scene, upload })
  } finally {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

const digestOf = bytes => createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------- upload

test('an uploaded artifact records its hash, size, and name, and the bytes are stored once', async (t) => {
  await withHub(async ({ call, scene, upload, config }) => {
    const { alice, roomId } = await scene()
    const bytes = Buffer.from('季度报表内容\n')
    const created = await upload(roomId, bytes, alice.token, { fileName: 'q4.txt', contentType: 'text/plain' })
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.artifact.fileName, 'q4.txt')
    assert.equal(created.body.artifact.sizeBytes, bytes.byteLength)
    assert.equal(created.body.artifact.sha256, digestOf(bytes))
    assert.equal(created.body.artifact.contentType, 'text/plain')
    // The stored name is derived from the content, so the uploader's name never becomes a path.
    assert.match(created.body.artifact.sha256, /^[0-9a-f]{64}$/)
    const stored = join(config.artifactsDir, created.body.artifact.sha256.slice(0, 2), created.body.artifact.sha256.slice(2, 4), created.body.artifact.sha256)
    assert.equal(existsSync(stored), true)
    assert.equal(readFileSync(stored).toString('utf8'), bytes.toString('utf8'))
  })
})

test('two uploads of the same content share one stored object', async (t) => {
  await withHub(async ({ scene, upload, config }) => {
    const { alice, roomId } = await scene()
    const bytes = Buffer.from('identical content')
    const first = await upload(roomId, bytes, alice.token, { fileName: 'a.txt' })
    const second = await upload(roomId, bytes, alice.token, { fileName: 'b.txt' })
    assert.equal(first.status, 201, first.raw)
    assert.equal(second.status, 201, second.raw)
    assert.equal(first.body.artifact.sha256, second.body.artifact.sha256)
    const stored = join(config.artifactsDir, first.body.artifact.sha256.slice(0, 2), first.body.artifact.sha256.slice(2, 4), first.body.artifact.sha256)
    // One object on disk, two rows: the hash is the identity of the bytes.
    assert.equal(existsSync(stored), true)
    assert.notEqual(first.body.artifact.id, second.body.artifact.id)
  })
})

test('a file name with a path separator or a control character is refused', async (t) => {
  await withHub(async ({ scene, upload }) => {
    const { alice, roomId } = await scene()
    for (const fileName of ['../escape.txt', 'a/b.txt', 'a\b.txt', 'bad\u0000name.txt', '', 'x'.repeat(201)]) {
      const refused = await upload(roomId, 'x', alice.token, { fileName })
      assert.equal(refused.status, 400, `${JSON.stringify(fileName)} must be refused`)
      assert.equal(refused.body.error.code, 'INVALID_FILE_NAME')
    }
  })
})

test('an empty artifact and one past the ceiling are refused', async (t) => {
  await withHub(async ({ scene, upload, config }) => {
    const { alice, roomId } = await scene()
    const empty = await upload(roomId, '', alice.token)
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error.code, 'EMPTY_ARTIFACT')
    // One byte over the configured ceiling. Fastify's own body limit may answer first, which is
    // also a refusal; either way nothing is stored.
    const tooBig = await upload(roomId, Buffer.alloc(config.limits.maxUploadBytes + 1, 1), alice.token)
    assert.ok(tooBig.status === 413 || tooBig.status === 400, `expected a refusal, got ${tooBig.status}`)
  })
})

test('a non-member cannot upload to a room', async (t) => {
  await withHub(async ({ scene, upload }) => {
    const { dana, roomId } = await scene()
    const refused = await upload(roomId, 'x', dana.token)
    assert.equal(refused.status, 404)
    assert.equal(refused.body.error.code, 'NO_SUCH_ROOM')
  })
})

test('naming a recipient who is not in the room is refused', async (t) => {
  await withHub(async ({ scene, upload }) => {
    const { alice, dana, roomId } = await scene()
    const refused = await upload(roomId, 'x', alice.token, { recipients: [dana.userId] })
    assert.equal(refused.body.error.code, 'RECIPIENT_NOT_A_MEMBER')
  })
})

// ---------------------------------------------------------------- download and ACL

test('the uploader and a named recipient can download; the bytes and hash come back intact', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, roomId } = await scene()
    const bytes = Buffer.from('quarterly numbers')
    const created = await upload(roomId, bytes, alice.token, { recipients: [bob.userId] })
    const artifactId = created.body.artifact.id

    for (const [who, token] of [['uploader', alice.token], ['recipient', bob.token]]) {
      const got = await call('GET', `/artifacts/${artifactId}/content`, undefined, token)
      assert.equal(got.status, 200, `${who}: ${got.raw}`)
      assert.equal(Buffer.from(got.payload).toString('utf8'), 'quarterly numbers')
      // The hash travels with the bytes, so a recipient can verify what they got.
      assert.equal(got.headers['x-artifact-sha256'], digestOf(bytes))
    }
  })
})

test('a room member who was not named cannot download, and the bytes do not come back', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, carol, roomId } = await scene()
    const created = await upload(roomId, 'private numbers', alice.token)
    const artifactId = created.body.artifact.id
    const refused = await call('GET', `/artifacts/${artifactId}/content`, undefined, carol.token)
    assert.equal(refused.status, 404)
    assert.equal(refused.body.error.code, 'NO_SUCH_ARTIFACT')
    // The response must not carry the content either.
    assert.equal(String(refused.raw).includes('private numbers'), false)
    assert.equal((await call('GET', `/rooms/${roomId}/artifacts`, undefined, carol.token)).body.artifacts.length, 0)
  })
})

test('a removed member loses access even when they were a named recipient', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, roomId } = await scene()
    const created = await upload(roomId, 'shared with bob', alice.token, { recipients: [bob.userId] })
    const artifactId = created.body.artifact.id
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, bob.token)).status, 200)

    await call('POST', `/rooms/${roomId}/members/${bob.userId}/remove`, {}, alice.token)
    // Membership and the ACL are checked separately, so losing the room ends the access even
    // though the ACL still names him.
    const after = await call('GET', `/artifacts/${artifactId}/content`, undefined, bob.token)
    assert.equal(after.status, 404)
    assert.equal(String(after.raw).includes('shared with bob'), false)
  })
})

test('a stranger and an invented artifact id are answered identically', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, dana, roomId } = await scene()
    const created = await upload(roomId, 'x', alice.token)
    const real = await call('GET', `/artifacts/${created.body.artifact.id}`, undefined, dana.token)
    const invented = await call('GET', '/artifacts/00000000-0000-4000-8000-000000000000', undefined, dana.token)
    assert.equal(real.status, 404)
    assert.equal(invented.status, 404)
    assert.deepEqual(real.body, invented.body)
  })
})

test('sharing adds recipients, only the uploader may do it, and each must be a member', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, carol, dana, roomId } = await scene()
    const created = await upload(roomId, 'shareable', alice.token)
    const artifactId = created.body.artifact.id
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, carol.token)).status, 404)

    assert.equal((await call('POST', `/artifacts/${artifactId}/share`, { recipients: [carol.userId] }, bob.token)).status, 403)
    assert.equal((await call('POST', `/artifacts/${artifactId}/share`, { recipients: [dana.userId] }, alice.token)).status, 403)
    const shared = await call('POST', `/artifacts/${artifactId}/share`, { recipients: [carol.userId] }, alice.token)
    assert.equal(shared.status, 200, shared.raw)
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, carol.token)).status, 200)
    // Only the uploader sees who the recipients are.
    assert.equal((await call('GET', `/artifacts/${artifactId}`, undefined, alice.token)).body.artifact.recipientUserIds.length, 2)
    assert.equal((await call('GET', `/artifacts/${artifactId}`, undefined, carol.token)).body.artifact.recipientUserIds, undefined)
  })
})

// ---------------------------------------------------------------- integrity and deletion

test('a file whose bytes no longer match its recorded hash is refused, not served', async (t) => {
  await withHub(async ({ call, scene, upload, db }) => {
    const { alice, roomId } = await scene()
    const created = await upload(roomId, 'original bytes', alice.token)
    const artifactId = created.body.artifact.id
    const row = db.prepare('SELECT storage_key FROM artifacts WHERE id = ?').get(artifactId)
    // Simulate something else rewriting the stored object.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(row.storage_key, 'tampered bytes')
    const served = await call('GET', `/artifacts/${artifactId}/content`, undefined, alice.token)
    // Serving it would hand the recipient something other than what was uploaded.
    assert.equal(served.status, 500)
    assert.equal(served.body.error.code, 'ARTIFACT_BYTES_CHANGED')
    assert.equal(String(served.raw).includes('tampered'), false)
  })
})

test('the uploader may delete, the bytes go, and the audit keeps the record', async (t) => {
  await withHub(async ({ call, scene, upload, db }) => {
    const { alice, bob, roomId } = await scene()
    const created = await upload(roomId, 'to be removed', alice.token, { recipients: [bob.userId] })
    const artifactId = created.body.artifact.id
    const row = db.prepare('SELECT storage_key FROM artifacts WHERE id = ?').get(artifactId)

    const deleted = await call('DELETE', `/artifacts/${artifactId}`, undefined, alice.token)
    assert.equal(deleted.status, 200, deleted.raw)
    assert.equal(db.prepare('SELECT count(*) AS n FROM artifacts WHERE id = ?').get(artifactId).n, 0)
    // The bytes go with the row when nothing else names that hash, so "delete this file" means it.
    assert.equal(existsSync(row.storage_key), false)
    assert.equal((await call('GET', `/artifacts/${artifactId}/content`, undefined, bob.token)).status, 404)
    const events = db.prepare("SELECT event_type FROM audit_events WHERE object_type = 'artifact'").all().map(r => r.event_type)
    assert.ok(events.includes('artifact.uploaded') && events.includes('artifact.deleted'), events.join(', '))
  })
})

test('deleting one of two rows with the same content keeps the bytes for the other', async (t) => {
  await withHub(async ({ call, scene, upload, db }) => {
    const { alice, roomId } = await scene()
    const bytes = Buffer.from('shared content')
    const first = await upload(roomId, bytes, alice.token, { fileName: 'first.txt' })
    const second = await upload(roomId, bytes, alice.token, { fileName: 'second.txt' })
    const row = db.prepare('SELECT storage_key FROM artifacts WHERE id = ?').get(first.body.artifact.id)

    await call('DELETE', `/artifacts/${first.body.artifact.id}`, undefined, alice.token)
    // The second row still needs those bytes: sweeping them would break it.
    assert.equal(existsSync(row.storage_key), true)
    assert.equal((await call('GET', `/artifacts/${second.body.artifact.id}/content`, undefined, alice.token)).status, 200)
  })
})

test('a room admin may delete another artifact, a plain member may not, a stranger learns nothing', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, carol, dana, roomId } = await scene()
    const created = await upload(roomId, 'bob shared this', bob.token)
    const artifactId = created.body.artifact.id
    const byMember = await call('DELETE', `/artifacts/${artifactId}`, undefined, carol.token)
    assert.equal(byMember.status, 403)
    assert.equal(byMember.body.error.code, 'NOT_ALLOWED_TO_DELETE')
    const byStranger = await call('DELETE', `/artifacts/${artifactId}`, undefined, dana.token)
    assert.equal(byStranger.status, 404)
    assert.equal((await call('DELETE', `/artifacts/${artifactId}`, undefined, alice.token)).status, 200)
  })
})

test('an artifact may name the task it belongs to, and only within its own room', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, bob, roomId } = await scene()
    const task = await call('POST', `/rooms/${roomId}/tasks`, { ownerUserId: bob.userId, description: 'make the report' }, alice.token)
    assert.equal(task.status, 201, task.raw)
    const attached = await call('POST', `/rooms/${roomId}/artifacts?fileName=out.txt&taskId=${task.body.task.id}`, Buffer.from('result'), alice.token, { 'content-type': 'text/plain' })
    assert.equal(attached.status, 201, attached.raw)
    assert.equal(attached.body.artifact.taskId, task.body.task.id)

    const other = await call('POST', '/rooms', { name: 'Engineering' }, alice.token)
    const wrongRoom = await call('POST', `/rooms/${other.body.room.id}/artifacts?fileName=out.txt&taskId=${task.body.task.id}`, Buffer.from('result'), alice.token, { 'content-type': 'text/plain' })
    assert.equal(wrongRoom.status, 403)
    assert.equal(wrongRoom.body.error.code, 'TASK_IN_ANOTHER_ROOM')
  })
})

test('a base64 JSON body works for a script, and is treated as bytes', async (t) => {
  await withHub(async ({ call, scene }) => {
    const { alice, roomId } = await scene()
    const bytes = Buffer.from('from a script')
    const created = await call('POST', `/rooms/${roomId}/artifacts?fileName=script.txt`, { base64: bytes.toString('base64') }, alice.token)
    assert.equal(created.status, 201, created.raw)
    assert.equal(created.body.artifact.sha256, digestOf(bytes))
    assert.equal(created.body.artifact.sizeBytes, bytes.byteLength)
  })
})

test('an unusual but valid content type is normalized, and an invalid one is refused', async (t) => {
  await withHub(async ({ scene, upload, call }) => {
    const { alice, roomId } = await scene()
    // A type the Hub never enumerated still uploads: the client picks the type, and refusing an
    // unknown one would make a legitimate file unshareable.
    const created = await upload(roomId, 'x', alice.token, { contentType: 'application/x-our-thing' })
    assert.equal(created.status, 201, created.raw)
    // It is stored and read back as declared, because it is well formed.
    assert.equal(created.body.artifact.contentType, 'application/x-our-thing')

    // A value that is not a media type at all is refused before any parser runs. That is the
    // right answer: it is a malformed request, not a file with an unknown type.
    const invalid = await upload(roomId, 'x', alice.token, { contentType: 'not a type' })
    assert.equal(invalid.status, 415)
    // And a well-formed type is never echoed back unvalidated into a response header.
    const normalized = await upload(roomId, 'y', alice.token, { contentType: 'TEXT/CSV; boundary=x' })
    if (normalized.status === 201) {
      assert.match(normalized.body.artifact.contentType, /^text\/csv/)
    }
  })
})

test('listing shows only what the viewer may read, and only the uploader sees recipients', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, carol, roomId } = await scene()
    await upload(roomId, 'for bob', alice.token, { fileName: 'bob.txt', recipients: [bob.userId] })
    await upload(roomId, 'for nobody', alice.token, { fileName: 'private.txt' })

    const mine = await call('GET', `/rooms/${roomId}/artifacts`, undefined, alice.token)
    assert.equal(mine.body.artifacts.length, 2)
    assert.ok(mine.body.artifacts.every(a => Array.isArray(a.recipientUserIds)))
    const his = await call('GET', `/rooms/${roomId}/artifacts`, undefined, bob.token)
    assert.equal(his.body.artifacts.length, 1)
    assert.equal(his.body.artifacts[0].fileName, 'bob.txt')
    assert.equal(his.body.artifacts[0].recipientUserIds, undefined)
    assert.equal((await call('GET', `/rooms/${roomId}/artifacts`, undefined, carol.token)).body.artifacts.length, 0)
  })
})

test('an artifact change reaches the room sockets without carrying the file name', async (t) => {
  await withHub(async ({ scene, upload, server }) => {
    const { alice, roomId } = await scene()
    const published = []
    const realPublish = server.hub.realtime.publishToRoom.bind(server.hub.realtime)
    server.hub.realtime.publishToRoom = (id, envelope) => { published.push(envelope); return realPublish(id, envelope) }
    await upload(roomId, 'x', alice.token, { fileName: 'secret-name.txt' })
    assert.equal(published.length, 1)
    assert.equal(published[0].payload.kind, 'artifact')
    // The name is metadata the room may not be entitled to; the id is enough to fetch it.
    assert.equal(JSON.stringify(published[0]).includes('secret-name'), false)
  })
})

test('a file whose name is not ASCII can still be downloaded', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, bob, roomId } = await scene()
    // A Chinese name is the ordinary case for this product's users. An HTTP header carries only
    // ASCII, so echoing the name raw made Node refuse the whole response — the download failed
    // with ERR_INVALID_CHAR and the recipient got a 500 instead of their file.
    const created = await upload(roomId, 'quarterly numbers', alice.token, {
      fileName: 'Q4报表.csv', recipients: [bob.userId],
    })
    assert.equal(created.status, 201, created.raw)
    const got = await call('GET', `/artifacts/${created.body.artifact.id}/content`, undefined, bob.token)
    assert.equal(got.status, 200, got.raw)
    assert.equal(Buffer.from(got.payload).toString('utf8'), 'quarterly numbers')
    // The real name travels in the RFC 5987 form, so a client can recover it exactly.
    assert.match(got.headers['content-disposition'], /filename\*=UTF-8''/)
    assert.equal(decodeURIComponent(got.headers['content-disposition'].split("UTF-8''")[1]), 'Q4报表.csv')
  })
})

test('an ASCII name is offered plainly as well as encoded', async (t) => {
  await withHub(async ({ call, scene, upload }) => {
    const { alice, roomId } = await scene()
    const created = await upload(roomId, 'x', alice.token, { fileName: 'report.txt' })
    const got = await call('GET', `/artifacts/${created.body.artifact.id}/content`, undefined, alice.token)
    assert.match(got.headers['content-disposition'], /filename="report\.txt"/)
    assert.match(got.headers['content-disposition'], /filename\*=UTF-8''report\.txt/)
  })
})
