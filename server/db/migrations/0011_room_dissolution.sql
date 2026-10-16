-- D: a workgroup can be dissolved, and dissolution is a state rather than a deletion.
--
-- `DELETE FROM rooms` was the obvious implementation and it is the wrong one. `room_members` and
-- `messages` reference `rooms(id) ON DELETE CASCADE`, so deleting the row would take the conversation
-- with it, and the requirement is explicit that history and audit are retained: people need to be able
-- to read what was decided in a workgroup after it closes, and an audit trail that vanishes with its
-- subject is not an audit trail.
--
-- So the room enters a terminal state. `dissolved_at` is the whole mechanism: NULL means the
-- workgroup is live, a timestamp means it ended at that moment and refuses new messages and tasks.
-- Nothing about existing rows changes, which also means the migration cannot lose data by
-- construction.
--
-- `dissolved_by` names who ended it. It is separate from `dissolved_at` because the two answer
-- different questions ("when" and "by whom"), and an owner who dissolves and then leaves the
-- workgroup must still be recorded as the one who ended it.
--
-- No index: dissolution is read with the room row itself, which is already a primary-key lookup.

ALTER TABLE rooms ADD COLUMN dissolved_at TEXT;
ALTER TABLE rooms ADD COLUMN dissolved_by TEXT REFERENCES users(id);
