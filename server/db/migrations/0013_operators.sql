-- Local-demo Hub operators are separate from application users.
--
-- An operator is not a `users` row: it has no devices, no refresh token, and cannot own a room.
-- Keeping it separate means guest monitoring and room ownership queries do not need to filter a
-- special account out of every user list, and a production deployment can change the admin
-- password or disable the account directly in this table.
--
-- The fixed admin row is a local-demo bootstrap only. `INSERT OR IGNORE` makes the migration safe
-- on an existing database and preserves a password an operator has already changed.
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  user_handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Operator actions are attributed separately from user actions. Existing audit inserts leave this
-- column NULL; operator writes fill it, so a later audit reader can tell who acted without
-- pretending the operator is a user.
ALTER TABLE audit_events ADD COLUMN actor_operator_id TEXT REFERENCES operators(id);
CREATE INDEX IF NOT EXISTS idx_audit_operator ON audit_events (actor_operator_id, occurred_at);

INSERT OR IGNORE INTO operators
  (id, user_handle, display_name, password_hash, status, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'admin',
  'Administrator',
  'scrypt$16384$8$1$yCWEJIv9pao80WyQcGRJsA==$thYmkdr7S13vfcs3eHQhlF4tRXMouGvP6hEAs8865FByCK6Oji91EvdLcuuvb6IdaGw03WPGu5ShTQfcyZT+Yg==',
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
