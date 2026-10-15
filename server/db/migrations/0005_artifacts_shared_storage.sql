-- H-11: several artifacts may name the same stored object.
--
-- Artifacts are stored once per content hash, so two uploads of the same file produce two rows
-- that must both point at one object. The original `storage_key UNIQUE` made the second insert
-- fail, which turned "upload a file somebody else already uploaded" into a 500.
--
-- Uniqueness belongs on the content, not on the reference to it: `(room_id, uploader_user_id,
-- file_name)` would still be wrong, because a user may legitimately upload the same name twice
-- with different content. What actually needs to hold is that a row always names a real object,
-- which the read path checks by recomputing the hash.

CREATE TABLE artifacts_new (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  sha256_hex TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  acl_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO artifacts_new (id, task_id, room_id, uploader_user_id, file_name, sha256_hex, storage_key, size_bytes, acl_json, created_at)
  SELECT id, task_id, room_id, uploader_user_id, file_name, sha256_hex, storage_key, size_bytes, acl_json, created_at FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

-- Lookup is by room, and by hash when deciding whether an object may be swept.
CREATE INDEX IF NOT EXISTS idx_artifacts_room ON artifacts (room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts (sha256_hex);
