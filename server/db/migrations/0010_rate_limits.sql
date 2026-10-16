-- M1/S2: throttling counters that survive a restart.
--
-- The limiter from H-03 keeps its counters in an in-memory `Map`, and its own module comment says
-- what that means: a restart forgets them. That is honest, but it is also the property an attacker
-- uses — a spray that trips the lockout only has to outlive one deploy, or wait for one, to resume
-- with a full budget. A Hub that colleagues reach across a company network must treat its own
-- restarts as ordinary events rather than as amnesty.
--
-- Two more things changed at the same time, and both shaped this table:
--
--   * **Registration is counted too.** Until now `login` was the only throttled route, so the one
--     route that mints identities had no ceiling at all. With `admin_secret` admission the
--     bootstrap secret is the only gate, which makes an unthrottled register route the weakest link
--     in that story. The `key` column's prefix distinguishes which route a row counts.
--   * **The key set stays bounded.** A limiter keyed on a client-influenced value (a handle, a
--     source address) is a storage amplifier unless it is capped, so `maxKeys` still applies: past
--     the cap the oldest rows are evicted, which is what stops a spray from being the thing that
--     grows this table without limit.
--
-- `stamps_json` is a JSON array of epoch milliseconds rather than one row per failed attempt. The
-- limiter's question is "how many failures inside the window", which one row per key answers
-- directly; a row per attempt would make the table's size track the attack instead of the attack's
-- distinct keys.

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  stamps_json TEXT NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Pruning walks the table asking "is this entry stale", which is a scan of rows in the order the
-- limiter last touched them.
CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON rate_limits (updated_at);
