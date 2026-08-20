-- Backfill: whoever created a channel is a member of it.
--
-- `channels.created_by` recorded who made the room and gated nothing. Once
-- private channels became members-only, a channel with no members became a
-- channel nobody could open, and the creator was the first one locked out —
-- 404 on their own room, absent from their own channel list, with no delete
-- endpoint to undo it. Reproduced against the live deployment before the fix.
--
-- Existing rooms need the same repair, or anything created before this ships
-- keeps that hole. `created_by` is nullable — a channel seeded rather than
-- created by a person has no creator to add — so the NULL check is load-bearing
-- rather than defensive.
INSERT INTO channel_members (channel_id, user_id, role)
SELECT c.id, c.created_by, 'owner'
FROM channels c
WHERE c.created_by IS NOT NULL
ON CONFLICT DO NOTHING;
