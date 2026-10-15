-- A-05: a message may answer an earlier one.
--
-- The workgroup view offers a reply affordance, and the Hub must record what a reply answers or the
-- feature is a lie: the client would send a `replyToMessageId`, the Hub would ignore the unknown
-- field (Fastify does not reject extra keys), and the message would arrive as an unrelated one. The
-- sender would see a reply, everyone else would see a message with no context, and nothing anywhere
-- would report a problem.
--
-- Why a column and not a payload field: what a message answers is part of the message's identity for
-- every reader, forever. It has to survive a reconnect, a catch-up page, an export, and a restore
-- from backup, which means it belongs in the row.
--
-- No foreign key to `messages(id)`: a reply must be able to survive the deletion of the message it
-- answers. Cascading or requiring the parent would either delete a reply's context along with the
-- original or refuse to remove the original at all. The reader resolves the reference when it can
-- and shows the reply without a quoted parent when it cannot, which is what `publicMessage` does.

ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;

-- Resolving a reply's parent is a lookup by id, which the primary key already serves. This index is
-- for the other direction — "which messages answer this one" — which a deletion path or a UI that
-- shows replies in place would ask.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
