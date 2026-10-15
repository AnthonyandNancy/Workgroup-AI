// Artifact routes: upload, list, download, share, delete.
//
// Upload takes a raw body (`application/octet-stream`, or any other type) rather than multipart,
// so the Hub needs no extra dependency and the size ceiling is the one Fastify already enforces
// from `HUB_MAX_UPLOAD_BYTES`. The file name and recipients travel as query parameters and
// headers, which is where small metadata belongs; the body is only bytes.
//
// The authorization shape matches the rest of the Hub:
//
//  * a room-scoped route resolves the caller's membership first, and a non-member is answered as
//    if the room did not exist;
//  * a download re-checks the caller's membership **and** their place in the ACL on every
//    request, so a removed member loses access even when they were named as a recipient;
//  * a refusal never says whether the artifact exists.

import {
  ArtifactError,
  createArtifact, findArtifact, readArtifact, listArtifacts, shareArtifact, deleteArtifact,
  publicArtifact, normalizeContentType, artifactInternals,
} from '../modules/artifacts/store.js'
import { RoomError } from '../modules/rooms/store.js'
import { makeEvent } from '../realtime/events.js'

function artifactFailure(reply, error) {
  if (error instanceof RoomError) {
    return reply.code(404).send({ error: { code: 'NO_SUCH_ROOM', message: error.message } })
  }
  if (error instanceof ArtifactError) {
    switch (error.code) {
      case 'NO_SUCH_ARTIFACT':
      case 'NO_SUCH_TASK':
        return reply.code(404).send({ error: { code: error.code, message: error.message } })
      case 'NOT_THE_UPLOADER':
      case 'NOT_ALLOWED_TO_DELETE':
      case 'RECIPIENT_NOT_A_MEMBER':
      case 'TASK_IN_ANOTHER_ROOM':
        return reply.code(403).send({ error: { code: error.code, message: error.message } })
      case 'ARTIFACT_TOO_LARGE':
        return reply.code(413).send({ error: { code: error.code, message: error.message } })
      case 'ARTIFACT_BYTES_MISSING':
      case 'ARTIFACT_BYTES_CHANGED':
        // The row says the file is there and it is not, or it is not what was uploaded. That is a
        // Hub-side integrity failure, not a client error.
        return reply.code(500).send({ error: { code: error.code, message: error.message } })
      default:
        return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }
  }
  throw error
}

/**
 * An `attachment` disposition that survives a non-ASCII file name.
 *
 * A raw non-ASCII character cannot appear in an HTTP header, so the name is also offered in the
 * RFC 5987 form. The ASCII fallback replaces anything outside the printable range with `_`, which
 * keeps a client that reads only `filename` from receiving a broken name.
 */
export function contentDisposition(fileName) {
  // Anything outside printable ASCII becomes `_`, and a quote or backslash (which would end the
  // quoted string early) becomes `_` as well.
  const ascii = fileName.replace(/[^ -~]/g, '_').split('"').join('_').split(String.fromCharCode(92)).join('_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

/** Tell the room's sockets that an artifact appeared or moved. No bytes and no file name. */
function publishArtifactChange(fastify, roomId, reason, artifactId) {
  fastify.hub.realtime.publishToRoom(roomId, makeEvent('message.created', {
    artifactId, reason, kind: 'artifact',
  }, { roomId }))
}

/**
 * Read a raw body up to the configured ceiling.
 *
 * Registered for `application/octet-stream` and for any `*​/*` the caller sends that is not JSON,
 * because a browser's `fetch` with a `Blob` sets the blob's own type. A JSON body keeps the
 * default parser, so the two never collide.
 */
export function registerArtifactBodyParser(fastify, config) {
  const maxBytes = config.limits?.maxUploadBytes ?? artifactInternals.DEFAULT_MAX_BYTES
  const binary = { parseAs: 'buffer', bodyLimit: maxBytes }
  const asBuffer = (request, body, done) => { done(null, body) }

  // `'*'` is Fastify's own catch-all: it handles every type no other parser claims, which is what
  // makes an unusual content type a legitimate upload instead of a 415. Registering concrete
  // types by name does not work — Fastify 5 rejects an unlisted one before any parser runs, and
  // `application/*` is not a wildcard here.
  fastify.addContentTypeParser('*', binary, asBuffer)
  // `text/plain` is the exception: Fastify ships a string parser for it, which would hand the
  // route a string rather than the bytes. Replacing it keeps one shape for every upload.
  fastify.addContentTypeParser('text/plain', binary, asBuffer)
}


export function makeArtifactRoutes({ requireAuth }) {
  return async function artifactRoutes(fastify) {
    const { db, config } = fastify.hub
    registerArtifactBodyParser(fastify, config)

    /** Upload one file. The body is the bytes; name and recipients are parameters. */
    fastify.post('/api/v1/rooms/:roomId/artifacts', { preHandler: requireAuth, bodyLimit: config.limits.maxUploadBytes }, async (request, reply) => {
      const query = request.query ?? {}
      // A raw body arrives as a Buffer; a JSON body (a test or a script) may carry base64 instead.
      let bytes
      if (Buffer.isBuffer(request.body)) {
        bytes = request.body
      } else if (request.body !== null && typeof request.body === 'object' && typeof request.body.base64 === 'string') {
        bytes = Buffer.from(request.body.base64, 'base64')
      } else {
        return reply.code(400).send({ error: { code: 'INVALID_BYTES', message: 'Send the file as a binary body, or as { base64 }' } })
      }
      const recipients = typeof query.recipients === 'string' && query.recipients.length > 0
        ? query.recipients.split(',').map(value => value.trim()).filter(Boolean)
        : []
      try {
        const created = createArtifact(db, config, {
          roomId: request.params.roomId,
          uploaderUserId: request.auth.user.id,
          uploaderDeviceId: request.auth.deviceId,
          fileName: typeof query.fileName === 'string' ? query.fileName : request.headers['x-file-name'],
          bytes,
          contentType: request.headers['content-type'],
          taskId: typeof query.taskId === 'string' && query.taskId.length > 0 ? query.taskId : undefined,
          recipients,
        })
        publishArtifactChange(fastify, request.params.roomId, 'uploaded', created.artifact.id)
        return reply.code(201).send({ artifact: publicArtifact(created.artifact, created.contentType, request.auth.user.id) })
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })

    /** Artifacts the caller may read in one room. */
    fastify.get('/api/v1/rooms/:roomId/artifacts', { preHandler: requireAuth }, async (request, reply) => {
      const query = request.query ?? {}
      try {
        const rows = listArtifacts(db, {
          roomId: request.params.roomId,
          viewerUserId: request.auth.user.id,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        })
        return reply.code(200).send({
          artifacts: rows.map(row => publicArtifact(row, undefined, request.auth.user.id)),
        })
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })

    fastify.get('/api/v1/artifacts/:artifactId', { preHandler: requireAuth }, async (request, reply) => {
      const row = findArtifact(db, request.params.artifactId)
      try {
        const read = readArtifact(db, config, { artifactId: request.params.artifactId, viewerUserId: request.auth.user.id })
        // A null read is a refusal; an unknown id is the same answer, so neither confirms the other.
        if (read === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_ARTIFACT', message: 'No such artifact' } })
        return reply.code(200).send({ artifact: publicArtifact(read.artifact, read.contentType, request.auth.user.id) })
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })

    /** Download the bytes, with the hash so the recipient can verify what they got. */
    fastify.get('/api/v1/artifacts/:artifactId/content', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const read = readArtifact(db, config, { artifactId: request.params.artifactId, viewerUserId: request.auth.user.id })
        if (read === undefined) return reply.code(404).send({ error: { code: 'NO_SUCH_ARTIFACT', message: 'No such artifact' } })
        // The name is echoed as an attachment name. An HTTP header carries only ASCII, so a name
        // with any non-ASCII character would make Node refuse the response outright — which is
        // what happened with a Chinese file name before this encoding was added.
        //
        // RFC 6266 covers it: a plain `filename` for ASCII clients, plus `filename*` with the
        // percent-encoded UTF-8 form for everything else. Both are sent because older clients read
        // only the first; a client that understands `filename*` prefers it.
        const disposition = contentDisposition(read.artifact.file_name)
        return reply
          .code(200)
          .header('content-type', normalizeContentType(read.contentType))
          .header('content-disposition', disposition)
          .header('x-artifact-sha256', read.artifact.sha256_hex)
          .send(Buffer.from(read.bytes))
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })

    fastify.post('/api/v1/artifacts/:artifactId/share', { preHandler: requireAuth }, async (request, reply) => {
      const body = request.body ?? {}
      try {
        const row = shareArtifact(db, {
          artifactId: request.params.artifactId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
          recipients: Array.isArray(body.recipients) ? body.recipients : [],
        })
        publishArtifactChange(fastify, row.room_id, 'shared', row.id)
        return reply.code(200).send({ artifact: publicArtifact(row, undefined, request.auth.user.id) })
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })

    fastify.delete('/api/v1/artifacts/:artifactId', { preHandler: requireAuth }, async (request, reply) => {
      try {
        const row = deleteArtifact(db, config, {
          artifactId: request.params.artifactId,
          actorUserId: request.auth.user.id,
          actorDeviceId: request.auth.deviceId,
        })
        publishArtifactChange(fastify, row.room_id, 'deleted', row.id)
        return reply.code(200).send({ artifact: publicArtifact(row, undefined, request.auth.user.id) })
      } catch (error) {
        return artifactFailure(reply, error)
      }
    })
  }
}
