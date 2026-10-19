-- A workgroup message may come from a Bot, not only from a person.
--
-- `sender_user_id` stays NOT NULL because every message still has an accountable human: the Bot's
-- owner. `sender_bot_id` names which of that person's Bots spoke, so a reader renders the Bot's name
-- and character while authorization, moderation and audit keep pointing at the person responsible.
--
-- `tasks.result_text` is where the owner's Host records what a finished task produced. It is not a
-- room-visible field: only the owner reads it, and `POST /tasks/:taskId/share` is the single act that
-- publishes it as a room message. Keeping the text on the task rather than in the progress stream is
-- what stops a result from being published by a progress update.
ALTER TABLE messages ADD COLUMN sender_bot_id TEXT;
ALTER TABLE tasks ADD COLUMN result_text TEXT;

-- A room's Bot messages are readable per room like any other message; the partial index keeps the
-- existing human-message path unchanged.
CREATE INDEX IF NOT EXISTS idx_messages_room_bot
  ON messages (room_id, sender_bot_id)
  WHERE sender_bot_id IS NOT NULL;
