-- Workgroup parity v2: group governance on the room row, the chief-Bot mirror, and reactions.
--
-- Four facts this migration lets the Hub own, each of which a client cannot be trusted with:
--
--   * `reply_mode` / `admin_bot_*` — which member answers an unmentioned message, and which Bot
--     leads. The original group chat keeps a single local `room.admin`; a workgroup's leader is a
--     Bot that belongs to a person on another machine, so the pair `(owner, botId)` is stored
--     rather than a bare id: a Bot id is only unique inside its owner's namespace, and a leader
--     column that could name two different Bots would authorize the wrong machine.
--
--   * `work_dir` / `permission` — the group's execution environment. The requirement is explicit
--     that these behave as the original group chat does, which means they apply to every member
--     (including other people's Bots). They are recorded here so every member's Host reads the same
--     value, and they remain defaults: a cross-user task is still approved by its owner.
--
--   * `is_chief` on both tables — the fact that a Bot is its owner's Main Bot is produced on the
--     owner's machine (`mainBotIds`) and can only be mirrored here. `bot_directory.is_chief` is what
--     the owner last reported; `room_bots.is_chief` is the snapshot taken when the Bot joined that
--     room, because a Bot that stops being a Main Bot must not silently take a room's leadership
--     history with it.
--
--   * `message_reactions` — the original stores reactions in the reader's localStorage, which cannot
--     satisfy "every member sees the same reactions". A row per (message, person, emoji) is the
--     smallest shape that both answers "who reacted" and makes a repeated reaction idempotent.
--
-- The defaults are the load-bearing part. Every workgroup created before this migration keeps
-- `reply_mode = 'everyone'` and no leader, which is exactly how it behaved: nothing that already
-- exists starts answering messages differently because an upgrade happened.

ALTER TABLE rooms ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'everyone'
  CHECK (reply_mode IN ('admin','everyone'));
ALTER TABLE rooms ADD COLUMN admin_bot_owner_user_id TEXT REFERENCES users(id);
ALTER TABLE rooms ADD COLUMN admin_bot_id TEXT;
ALTER TABLE rooms ADD COLUMN work_dir TEXT;
ALTER TABLE rooms ADD COLUMN permission TEXT;

-- Only a reported Main Bot can be a room's leader, so the mirror is written by the publish path and
-- read by every leadership check. `0` is the honest default: a Host that predates this field has not
-- said its Bot is a chief, so no Bot is one.
ALTER TABLE room_bots ADD COLUMN is_chief INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_directory ADD COLUMN is_chief INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS message_reactions (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Reactions are read a page at a time with their messages, never one message per query.
CREATE INDEX IF NOT EXISTS idx_message_reactions_message
  ON message_reactions (message_id);
