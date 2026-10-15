-- A-01: a device fingerprint identifies a device *for one account*, not for the whole Hub.
--
-- The original `fingerprint TEXT NOT NULL UNIQUE` said a fingerprint may appear once in the
-- database. But every query that uses it scopes it to a user — `login` looks up
-- `(user_id, fingerprint)`, `findDeviceByFingerprint` takes a `userId`, and
-- `DEVICE_ALREADY_REGISTERED` is raised when *this user's* fingerprint exists. The constraint and
-- the queries therefore disagree about what a fingerprint means.
--
-- What that disagreement costs in practice: two employees signing in on one shared workstation,
-- or one employee with a work account and a test account on their own laptop, cannot both register.
-- The second one is refused with "This device is already registered" for a device that is not
-- theirs, and no operator action short of deleting the other user's row can fix it.
--
-- The right constraint is the one the code already assumes: a user has at most one device per
-- fingerprint. Uniqueness across users is not a property this product wants, because the Hub is
-- explicitly multi-user and the A-series requires two identities to be able to act from two
-- clients on one machine during development and testing.

CREATE TABLE devices_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  -- Added by 0002, in the order that migration left them. Every one of them is listed: a
  -- rebuild that forgets a column silently drops it, and the failure appears later as a 500 on
  -- whichever route reads it (`login` reads `last_login_at`).
  label TEXT,
  app_version TEXT,
  platform TEXT,
  last_login_at TEXT
);

INSERT INTO devices_new (id, user_id, public_key, fingerprint, revoked_at, last_seen_at, created_at, label, app_version, platform, last_login_at)
  SELECT id, user_id, public_key, fingerprint, revoked_at, last_seen_at, created_at, label, app_version, platform, last_login_at FROM devices;

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

-- The lookup that login and device registration both perform. It is UNIQUE because the pair is
-- what the application treats as one device: a duplicate would make `login`'s `SELECT *` pick an
-- arbitrary row and hand out a token for whichever one it happened to find.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_user_fingerprint ON devices (user_id, fingerprint);

-- Resolving a token checks `id`, which the primary key already covers; this index serves the
-- per-user device listing.
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id, created_at);
