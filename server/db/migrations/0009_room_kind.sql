-- M1/S1: a room has a kind, and the Hub is the authority on it.
--
-- The client asks for a workgroup by sending `kind: 'workgroup'` at creation, and until this
-- column existed Fastify dropped the unknown field: the Hub stored an ordinary room while the
-- client drew workgroup affordances from its own guess. Two sides disagreeing about what a room
-- *is* is the kind of divergence that later shows up as a permission that applies to the wrong
-- room, so the fact lives in the row and comes back in every response.
--
-- The default is the load-bearing part. Every room created before this migration, and every
-- caller that does not ask for a workgroup, becomes `ordinary` — which is what they already were.
-- A migration that re-labelled existing rooms would silently turn today's Hub rooms into a
-- different entity with different rules.
--
-- The CHECK mirrors the module's own allowed list. It is here rather than only in JavaScript
-- because a second writer (an operator script, a future route) must not be able to invent a
-- third kind that no code path handles.

ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary','workgroup'));
