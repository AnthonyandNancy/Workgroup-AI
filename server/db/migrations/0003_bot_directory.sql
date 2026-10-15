-- H-07: the publishable remote Bot directory.
--
-- A directory entry is metadata only: a Bot's display name, who owns it, how visible it is,
-- and whether its owner's client is currently reachable. It deliberately carries no model
-- name, no Session id, no file path, and no capability list — those belong to the owner's
-- machine, and a colleague browsing the directory must not be able to enumerate them.
--
-- `last_seen_at` is what makes presence trustworthy. A client that crashes cannot send
-- "I am offline", so the Hub treats a stale heartbeat as offline rather than believing the
-- last value it was told. `published_at` records when visibility last became broader than
-- private, which is the fact an owner needs in order to audit what they have shared.

ALTER TABLE bot_directory ADD COLUMN last_seen_at TEXT;
ALTER TABLE bot_directory ADD COLUMN published_at TEXT;

-- Directory listing queries filter by visibility and owner, so index both.
CREATE INDEX IF NOT EXISTS idx_bot_directory_visibility ON bot_directory (visibility);
CREATE INDEX IF NOT EXISTS idx_bot_directory_owner ON bot_directory (owner_user_id);

-- The Bot a task names must resolve to an entry the owner actually published, in one lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_directory_owner_bot ON bot_directory (owner_user_id, bot_id);
