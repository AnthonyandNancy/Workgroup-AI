-- E: a message can summon a member or a colleague's Bot, and can carry attachments.
--
-- Both belong in the message row rather than in a side table or only in the response.
--
-- **Mentions** are part of what the message means to every reader, forever: the Hub turns a Bot
-- mention into a pending approval, and a reader shown the message later has to see the same summons.
-- A mention names a **user id** (and optionally a bot id), never a display name. A name-based mention
-- breaks on a rename, and — worse — makes the text "@Writer" in ordinary prose indistinguishable from
-- a summons, which is exactly the confusion that would let a stray mention propose work.
--
-- **Attachments** name an artifact that already exists in this room. Storing the id rather than the
-- file keeps one copy of the bytes; validation on write refuses an artifact from another room, because
-- publishing its *name* to people who cannot read it is already a disclosure.
--
-- JSON arrays rather than join tables: nothing queries "which messages mention X" yet, and a table per
-- list would be structure ahead of a consumer (see the package rules on requiring a current owner).
-- When a query needs one, it can be added with the index that query wants.

ALTER TABLE messages ADD COLUMN mentions_json TEXT;
ALTER TABLE messages ADD COLUMN attachments_json TEXT;
