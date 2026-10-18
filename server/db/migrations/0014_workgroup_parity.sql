-- Workgroup parity: room notice and explicit room Bot membership.
--
-- A Bot directory entry says a Bot exists and who may discover it. It does not say the Bot
-- belongs to a particular room. The two facts are separate: a public Bot is not a member of every
-- room, and a private Bot can still be added to one room by its owner. room_bots is the room
-- membership fact; bot_directory remains the discovery/presence fact.
--
-- Existing workgroups derived their Bot list from active members' public/room directory entries.
-- The backfill below preserves exactly that visible set so an upgrade does not silently remove a
-- Bot from an existing conversation. It also preserves Bots already named by historical tasks while
-- their owner is still an active member.

ALTER TABLE rooms ADD COLUMN notice TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS room_bots (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  bot_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (room_id, owner_user_id, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_room_bots_room_active
  ON room_bots (room_id, removed_at, owner_user_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_room_bots_owner
  ON room_bots (owner_user_id, bot_id);

CREATE TABLE IF NOT EXISTS room_bot_invitations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  bot_id TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_bot_invitations_pending
  ON room_bot_invitations (room_id, owner_user_id, bot_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_room_bot_invitations_owner
  ON room_bot_invitations (owner_user_id, status, expires_at);

-- Preserve the current derived visible set. `removed_at IS NULL` and membership checks match
-- the current openRoom behavior: active room members' public/room directory entries.
INSERT OR IGNORE INTO room_bots
  (room_id, owner_user_id, bot_id, display_name, added_by_user_id, added_at, removed_at)
SELECT r.id, d.owner_user_id, d.bot_id, d.display_name, d.owner_user_id, r.created_at, NULL
FROM rooms r
JOIN bot_directory d
  ON d.visibility IN ('public','room')
JOIN room_members m
  ON m.room_id = r.id AND m.user_id = d.owner_user_id AND m.removed_at IS NULL
WHERE r.kind = 'workgroup';

-- Preserve Bots already referenced by historical tasks. The owner must still be a room member;
-- a task whose owner left is historical data, not a reason to add a new active Bot.
INSERT OR IGNORE INTO room_bots
  (room_id, owner_user_id, bot_id, display_name, added_by_user_id, added_at, removed_at)
SELECT r.id, d.owner_user_id, d.bot_id, d.display_name, d.owner_user_id, r.created_at, NULL
FROM tasks t
JOIN rooms r ON r.id = t.room_id AND r.kind = 'workgroup'
JOIN bot_directory d
  ON d.owner_user_id = t.owner_user_id
 AND d.bot_id = COALESCE(t.assigned_bot_id, t.target_bot_id)
JOIN room_members m
  ON m.room_id = r.id AND m.user_id = t.owner_user_id AND m.removed_at IS NULL
WHERE COALESCE(t.assigned_bot_id, t.target_bot_id) IS NOT NULL;
