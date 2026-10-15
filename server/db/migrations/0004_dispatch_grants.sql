-- H-09: one-time dispatch grants.
--
-- A grant is what turns the owner's approval into something their machine can present once.
-- It is deliberately not a bearer token that keeps working: the task id and the owner's
-- approval are the durable facts, while this row is the *single use* of that approval. A
-- second presentation must fail, which is what `consumed_at` records.
--
-- `nonce_hash` rather than the nonce itself: the Hub never needs to read a grant back, only
-- to recognise one it issued, so a leaked database must not yield usable grants.
--
-- `expires_at` is separate from the approval's own expiry. The approval says "I agree to
-- this"; the grant says "and this particular dispatch is valid until T". A grant minted near
-- the end of an approval's window cannot outlive it, because the mint clamps to the earlier
-- of the two.

CREATE TABLE IF NOT EXISTS dispatch_grants (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  bot_id TEXT,
  nonce_hash TEXT NOT NULL UNIQUE,
  -- The revocation version this grant was minted against. A later bump makes it stale.
  revocation_version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispatch_grants_task ON dispatch_grants (task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_grants_owner ON dispatch_grants (owner_user_id, expires_at);

-- The scope the owner approved, copied onto the grant at mint time so verification does not
-- have to join `approvals` and so a later scope change cannot silently widen a grant that was
-- already handed out.
ALTER TABLE dispatch_grants ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';

-- Grants are the dispatch path, so every lookup is by task or by owner device.
CREATE INDEX IF NOT EXISTS idx_dispatch_grants_device ON dispatch_grants (device_id, expires_at);
