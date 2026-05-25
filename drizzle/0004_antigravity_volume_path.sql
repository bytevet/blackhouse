-- Antigravity's `agy` CLI inherits Gemini's config layout — it writes to
-- ~/.gemini (config, auth, brain, knowledge, mcp_config, …), NOT to
-- ~/.antigravity. The named volume `antigravity-config` was previously
-- mounted at the wrong path, so any auth or config persisted in the
-- container's ephemeral filesystem and was lost on restart.
--
-- Scoped to the old mount path so any operator-customized rows are
-- preserved. Existing users who set up auth on the old mount path lose
-- it — no regression vs the no-mount case, since the old path never had
-- a persistent volume backing it anyway.

UPDATE "agent_configs"
SET "volume_mounts" = jsonb_set(
      "volume_mounts",
      '{0,mountPath}',
      '"/home/workspace/.gemini"'
    ),
    "updated_at" = now()
WHERE "preset" = 'antigravity'
  AND "volume_mounts" -> 0 ->> 'mountPath' = '/home/workspace/.antigravity';
