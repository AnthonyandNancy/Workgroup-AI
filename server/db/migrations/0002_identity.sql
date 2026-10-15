-- H-03: credentials the Hub issues to a device.
--
-- The Hub stores no usable credential. An access token is verified by signature and never
-- stored; a refresh token is stored only as a lookup id plus a SHA-256 hash, so a database
-- leak does not hand over live sessions.
--
-- `used_at` exists so rotation on use can treat a second presentation of the same token as
-- the reuse signal it is, instead of silently accepting it.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  -- A short, non-secret prefix of the hash, used only to find the row without scanning.
  lookup_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device ON refresh_tokens (device_id);

-- Devices gain the columns the identity flow needs for a stable, auditable machine record.
-- `label` is what the user sees in their device list; nothing here is a filesystem path.
ALTER TABLE devices ADD COLUMN label TEXT;
ALTER TABLE devices ADD COLUMN app_version TEXT;
ALTER TABLE devices ADD COLUMN platform TEXT;

-- The last time this device successfully completed a login, as opposed to merely being
-- seen on a request. Separating the two keeps "last active" from being trivially spoofable
-- by a stolen token held by an attacker.
ALTER TABLE devices ADD COLUMN last_login_at TEXT;
