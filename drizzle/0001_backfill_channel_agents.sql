-- Backfill: every existing agent joins every existing channel.
--
-- Mentions now resolve only against an agent that is a member of the channel.
-- Before this, they resolved against every agent in the workspace, so no one
-- ever had to add anyone — and the live deployment proved the cost of ignoring
-- that: `#general` carried `@scout` and `@reviewer` but not `@warden`, which
-- had been mentioned there perfectly happily. Enforcing without this migration
-- would have broken that channel on deploy.
--
-- Public channels only in spirit but all channels in fact: there are no private
-- ones yet, and an agent already in a room it should not be in is a membership
-- someone can remove in the dialog. The alternative — guessing which pairs were
-- "really" intended — is not knowable from the data.
--
-- Destroyed agents are skipped; they cannot be mentioned and would only clutter
-- the roster.
--
-- Humans are deliberately not backfilled. Nothing gates on human membership
-- except private channels, of which there are none, so adding every user to
-- every channel would invent state rather than preserve it.
INSERT INTO channel_members (channel_id, agent_id)
SELECT c.id, a.id
FROM channels c
CROSS JOIN agents a
WHERE a.status <> 'destroyed'
ON CONFLICT DO NOTHING;
