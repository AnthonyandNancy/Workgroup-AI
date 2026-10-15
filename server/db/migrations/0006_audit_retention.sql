-- H-12: audit querying and retention.
--
-- The audit trail is the Hub's answer to "what happened", and two properties make it usable for
-- that: it must be queryable by the things an operator investigates (who, what, when), and it
-- must outlive the data it describes by a policy the operator chose rather than one the code
-- happened to imply.
--
-- `outcome` gains an index because "show me what was refused" is the first question after a
-- security report, and scanning every row to answer it does not scale past a pilot.

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_events (object_type, object_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_events (outcome, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events (event_type, occurred_at);

-- Retention runs as a recorded decision rather than a silent sweep: the table below keeps what
-- each run did, so "why is this event gone" has an answer.
CREATE TABLE IF NOT EXISTS retention_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  deleted_count INTEGER NOT NULL,
  kept_count INTEGER NOT NULL,
  ran_at TEXT NOT NULL
);

-- A message's audit entry is written once per message, but a long-lived room accumulates many.
-- Indexing the room makes a per-room retention pass possible without a full scan.
CREATE INDEX IF NOT EXISTS idx_audit_time_outcome ON audit_events (occurred_at, outcome);
