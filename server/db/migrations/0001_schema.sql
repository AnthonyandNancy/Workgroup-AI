-- Workgroup AI Hub: proposal for first SQLite schema.
-- 只用于 server/；不包含任何私人 DSH Session 数据表。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_seq INTEGER NOT NULL CHECK (room_seq >= 1),
  sender_user_id TEXT NOT NULL REFERENCES users(id),
  client_message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, room_seq),
  UNIQUE (room_id, sender_user_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages (room_id, room_seq);
CREATE TABLE IF NOT EXISTS bot_directory (
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  bot_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','room','public')),
  state TEXT NOT NULL DEFAULT 'offline',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, bot_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  target_bot_id TEXT,
  assigned_bot_id TEXT,
  assignment_mode TEXT CHECK (assignment_mode IN ('existing_bot','chief_auto','create_bot')),
  description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING_APPROVAL','APPROVED','QUEUED','RUNNING','REVIEW_REQUIRED','COMPLETED','SHARED','REJECTED','CANCELLING','CANCELLED','EXPIRED','FAILED')),
  version INTEGER NOT NULL DEFAULT 0,
  revocation_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  approver_user_id TEXT NOT NULL REFERENCES users(id),
  approver_device_id TEXT NOT NULL REFERENCES devices(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  scope_json TEXT NOT NULL,
  grant_nonce_hash TEXT,
  expires_at TEXT,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor_user_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  public_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, created_at);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,
  sha256_hex TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  acl_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_memories (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  source_message_id TEXT REFERENCES messages(id),
  body TEXT NOT NULL,
  acl_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES group_memories(id),
  revision INTEGER NOT NULL,
  editor_user_id TEXT NOT NULL REFERENCES users(id),
  previous_body TEXT,
  new_body TEXT,
  changed_at TEXT NOT NULL,
  UNIQUE (memory_id, revision)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_device_id TEXT REFERENCES devices(id),
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  outcome TEXT NOT NULL,
  safe_details_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events (occurred_at);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
