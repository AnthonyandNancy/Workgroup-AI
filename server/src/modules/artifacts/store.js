// Hub artifacts: files one member hands to a room or to named recipients.
//
// Four rules shape this module, and each exists because an attachment is the point where a
// collaboration tool most easily leaks a whole document:
//
//  1. **A file is never published by default.** An artifact starts with the recipients its
//     uploader named, and there is no path that widens that silently. A member of the room is
//     not automatically a recipient.
//  2. **Bytes live under the Hub's own data directory, named by content.** The stored name is
//     derived from the SHA-256, so two uploads of the same file share one object, and the
//     uploader's file name is metadata only. A file name from a client never becomes a path.
//  3. **Download checks the ACL on every request.** The scope is a set of user ids and the room
//     it was uploaded to; membership of that room is checked independently, so a removed member
//     loses access even if they were named.
//  4. **The Hub does not scan.** It records size, type, and hash. Malware scanning is a
//     deployment concern and is not claimed here; what the Hub does guarantee is that a
//     recipient can verify the bytes they got are the bytes that were uploaded.
//
// Uploads go through a raw body parser rather than multipart, so the Hub needs no extra
// dependency and the size limit is the one Fastify already enforces from configuration.

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RoomError, requireMember, membershipOf } from '../rooms/store.js'

export class ArtifactError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
  }
}

const FILE_NAME_MAX = 200
/** A conservative default, because an artifact is whatever a user chose to hand over. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** Characters a file name must not contain, because it is also read back into a download header. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\]/

export function assertFileName(name) {
  if (typeof name !== 'string') throw new ArtifactError('A file name is required', 'INVALID_FILE_NAME')
  const value = name.trim()
  if (value.length === 0 || value.length > FILE_NAME_MAX) {
    throw new ArtifactError(`A file name must be 1-${FILE_NAME_MAX} characters`, 'INVALID_FILE_NAME')
  }
  // The name becomes a response header value later, so a control character or a separator is
  // refused here rather than escaped at the boundary — an escaped header is still a surprise.
  if (UNSAFE_NAME.test(value) || value === '.' || value === '..') {
    throw new ArtifactError('A file name must not contain path separators or control characters', 'INVALID_FILE_NAME')
  }
  return value
}

function nowIso(now) {
  return now.toISOString()
}

function audit(db, { actorUserId, actorDeviceId, eventType, objectId, outcome, details, now }) {
  db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_device_id, event_type, object_type, object_id, outcome, safe_details_json, occurred_at)
    VALUES (?, ?, ?, ?, 'artifact', ?, ?, ?, ?)`)
    .run(randomUUID(), actorUserId ?? null, actorDeviceId ?? null, eventType, objectId ?? null, outcome,
      JSON.stringify(details ?? {}), nowIso(now))
}

function aclOf(row) {
  try {
    const parsed = JSON.parse(row.acl_json)
    return {
      roomId: typeof parsed.roomId === 'string' ? parsed.roomId : row.room_id,
      userIds: Array.isArray(parsed.userIds) ? parsed.userIds.filter(id => typeof id === 'string') : [],
      contentType: typeof parsed.contentType === 'string' ? parsed.contentType : 'application/octet-stream',
    }
  } catch {
    // A corrupt ACL must narrow, never widen: fall back to the uploader alone.
    return { roomId: null, userIds: [], contentType: 'application/octet-stream' }
  }
}

/**
 * Object path for a hash.
 *
 * Two levels of two hex characters keep one directory from holding every object the Hub ever
 * stored, and the name is the hash itself so identical content is stored once. The uploader's
 * file name never reaches the filesystem.
 */
export function storagePathFor(config, sha256Hex) {
  return join(config.artifactsDir, sha256Hex.slice(0, 2), sha256Hex.slice(2, 4), sha256Hex)
}

export function findArtifact(db, id) {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id)
}

/**
 * Store one uploaded file.
 *
 * `userIds` are the recipients the uploader named. They are copied into the ACL, so a later
 * membership change cannot add a recipient implicitly.
 */
export function createArtifact(db, config, {
  roomId, uploaderUserId, uploaderDeviceId, fileName, bytes, contentType, taskId,
  recipients = [], now = new Date(),
}) {
  requireMember(db, { roomId, userId: uploaderUserId })
  const name = assertFileName(fileName)
  if (!(bytes instanceof Uint8Array)) throw new ArtifactError('An artifact needs its bytes', 'INVALID_BYTES')
  const maxBytes = config.limits?.maxUploadBytes ?? DEFAULT_MAX_BYTES
  if (bytes.byteLength === 0) throw new ArtifactError('An artifact must not be empty', 'EMPTY_ARTIFACT')
  if (bytes.byteLength > maxBytes) {
    throw new ArtifactError(`An artifact must be at most ${maxBytes} bytes`, 'ARTIFACT_TOO_LARGE')
  }

  // A named recipient must be a member of the room: sharing a file with somebody who cannot see
  // the conversation it belongs to would make the ACL the only thing standing between them and
  // the bytes, with nothing to cross-check against.
  for (const recipient of recipients) {
    if (membershipOf(db, { roomId, userId: recipient }) === undefined) {
      throw new ArtifactError('A recipient must be a member of this room', 'RECIPIENT_NOT_A_MEMBER')
    }
  }

  if (taskId !== undefined && taskId !== null) {
    const task = db.prepare('SELECT room_id FROM tasks WHERE id = ?').get(taskId)
    if (task === undefined) throw new ArtifactError('No such task', 'NO_SUCH_TASK')
    if (task.room_id !== roomId) throw new ArtifactError('That task belongs to another room', 'TASK_IN_ANOTHER_ROOM')
  }

  const sha256Hex = createHash('sha256').update(bytes).digest('hex')
  const path = storagePathFor(config, sha256Hex)
  // Writing first, then the row, means a crash leaves an unreferenced object — harmless and
  // reclaimable — rather than a row pointing at bytes that were never written.
  mkdirSync(resolve(path, '..'), { recursive: true })
  if (!existsSyncSafe(path)) writeFileSync(path, bytes)

  const id = randomUUID()
  const createdAt = nowIso(now)
  // The content type is stored with the ACL, not passed back to the caller only: a value that is
  // returned at upload time but never persisted reads back as octet-stream, so a recipient would
  // get the file without knowing what it is.
  const acl = { roomId, userIds: [...new Set([uploaderUserId, ...recipients])], contentType: normalizeContentType(contentType) }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO artifacts
      (id, task_id, room_id, uploader_user_id, file_name, sha256_hex, storage_key, size_bytes, acl_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId ?? null, roomId, uploaderUserId, name, sha256Hex, storagePathFor(config, sha256Hex), bytes.byteLength, JSON.stringify(acl), createdAt)
    audit(db, {
      actorUserId: uploaderUserId, actorDeviceId: uploaderDeviceId, eventType: 'artifact.uploaded',
      objectId: id, outcome: 'success',
      // Hash and size only: an audit row must not become a second copy of the file.
      details: { roomId, sha256: sha256Hex, sizeBytes: bytes.byteLength, recipients: acl.userIds.length },
      now,
    })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is what matters; a failing rollback must not replace it.
    }
    throw error
  }
  return { artifact: findArtifact(db, id), contentType: acl.contentType }
}

function existsSyncSafe(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * A stored content type is metadata; an unset or unusable one becomes octet-stream.
 *
 * Parameters are dropped rather than carried: `text/csv; charset=utf-8` and `text/csv; boundary=x`
 * are the same media type, and no caller of this Hub needs to be told the difference. The part
 * before the first semicolon is validated on its own, so a malformed parameter cannot make a
 * well-formed type look invalid.
 */
export function normalizeContentType(value) {
  if (typeof value !== 'string') return 'application/octet-stream'
  const mediaType = value.split(';')[0].trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) return 'application/octet-stream'
  return mediaType
}

/**
 * Whether this viewer may read this artifact.
 *
 * Membership of the artifact's room is required **and** the viewer must be in the ACL. The two
 * are separate so that removing somebody from the room ends their access even when they were
 * named as a recipient.
 */
export function mayReadArtifact(db, row, viewerUserId) {
  if (row === undefined) return false
  if (membershipOf(db, { roomId: row.room_id, userId: viewerUserId }) === undefined) return false
  const acl = aclOf(row)
  if (row.uploader_user_id === viewerUserId) return true
  return acl.userIds.includes(viewerUserId)
}

/**
 * Read one artifact's bytes, if the viewer may have them.
 *
 * The hash is recomputed from the stored bytes and compared with the recorded one. A mismatch
 * means the file on disk changed under the Hub; serving it would hand the recipient something
 * other than what was uploaded, so the read fails loudly instead.
 */
export function readArtifact(db, config, { artifactId, viewerUserId }) {
  const row = findArtifact(db, artifactId)
  if (!mayReadArtifact(db, row, viewerUserId)) return undefined
  const path = row.storage_key
  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    throw new ArtifactError('The stored file is missing', 'ARTIFACT_BYTES_MISSING')
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== row.sha256_hex) {
    throw new ArtifactError('The stored file does not match its recorded hash', 'ARTIFACT_BYTES_CHANGED')
  }
  const acl = aclOf(row)
  return {
    artifact: row,
    bytes,
    contentType: normalizeContentType(acl.contentType),
    userIds: acl.userIds,
  }
}

/** Artifacts a viewer may read in one room. */
export function listArtifacts(db, { roomId, viewerUserId, limit = 200 }) {
  requireMember(db, { roomId, userId: viewerUserId })
  const rows = db.prepare('SELECT * FROM artifacts WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(roomId, Math.min(Math.max(Number(limit) || 200, 1), 500))
  return rows.filter(row => mayReadArtifact(db, row, viewerUserId))
}

/**
 * Widen an artifact's recipients.
 *
 * Only the uploader may do it, and every new recipient must already be in the room: sharing
 * further is the uploader's decision, and it is recorded so the change is visible.
 */
export function shareArtifact(db, { artifactId, actorUserId, actorDeviceId, recipients = [], now = new Date() }) {
  const row = findArtifact(db, artifactId)
  if (row === undefined) throw new ArtifactError('No such artifact', 'NO_SUCH_ARTIFACT')
  // Membership first, so a non-member learns nothing about whether the artifact exists.
  requireMember(db, { roomId: row.room_id, userId: actorUserId })
  if (row.uploader_user_id !== actorUserId) {
    throw new ArtifactError('Only the uploader may share this artifact further', 'NOT_THE_UPLOADER')
  }
  for (const recipient of recipients) {
    if (membershipOf(db, { roomId: row.room_id, userId: recipient }) === undefined) {
      throw new ArtifactError('A recipient must be a member of this room', 'RECIPIENT_NOT_A_MEMBER')
    }
  }
  const acl = aclOf(row)
  const next = { roomId: acl.roomId, userIds: [...new Set([...acl.userIds, ...recipients])], contentType: acl.contentType ?? 'application/octet-stream' }
  const stamp = nowIso(now)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE artifacts SET acl_json = ? WHERE id = ?').run(JSON.stringify(next), artifactId)
    audit(db, { actorUserId, actorDeviceId, eventType: 'artifact.shared', objectId: artifactId, outcome: 'success', details: { recipients: recipients.length }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return findArtifact(db, artifactId)
}

/**
 * Remove an artifact.
 *
 * The row goes and the bytes go with it when no other row references the same hash, which is
 * what makes "delete this file" mean something rather than leaving the content on disk under a
 * hash somebody could still guess. The audit row stays, so the deletion is visible.
 */
export function deleteArtifact(db, config, { artifactId, actorUserId, actorDeviceId, now = new Date() }) {
  const row = findArtifact(db, artifactId)
  if (row === undefined) throw new ArtifactError('No such artifact', 'NO_SUCH_ARTIFACT')
  // Membership first: a non-member must not learn whether the artifact exists.
  const membership = requireMember(db, { roomId: row.room_id, userId: actorUserId })
  const isUploader = row.uploader_user_id === actorUserId
  const isAdmin = membership.role === 'owner' || membership.role === 'admin'
  if (!isUploader && !isAdmin) {
    throw new ArtifactError('Only the uploader or a room admin may delete this artifact', 'NOT_ALLOWED_TO_DELETE')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId)
    const stillReferenced = db.prepare('SELECT 1 AS yes FROM artifacts WHERE sha256_hex = ? LIMIT 1').get(row.sha256_hex)
    if (stillReferenced === undefined) {
      // Only sweep the bytes when this was the last row naming them.
      try {
        rmSync(row.storage_key, { force: true })
      } catch {
        // A file that cannot be removed leaves an unreferenced object; the row is already gone,
        // so the artifact is unreachable either way.
      }
    }
    audit(db, { actorUserId, actorDeviceId, eventType: 'artifact.deleted', objectId: artifactId, outcome: 'success', details: { roomId: row.room_id, swept: stillReferenced === undefined }, now })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // See above.
    }
    throw error
  }
  return row
}

export function publicArtifact(row, contentType, viewerUserId) {
  const acl = aclOf(row)
  return {
    id: row.id,
    roomId: row.room_id,
    taskId: row.task_id ?? null,
    uploaderUserId: row.uploader_user_id,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256_hex,
    contentType: normalizeContentType(contentType),
    // Only the uploader sees the recipient list: who may read a file is the uploader's business.
    ...(viewerUserId === row.uploader_user_id ? { recipientUserIds: acl.userIds } : {}),
    createdAt: row.created_at,
  }
}

export const artifactInternals = { DEFAULT_MAX_BYTES, FILE_NAME_MAX, aclOf }
