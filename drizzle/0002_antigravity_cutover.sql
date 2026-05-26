-- Cutover: Gemini → Antigravity, and reconcile codex agent_command for users
-- whose existing row still has the deprecated `--full-auto` flag.
--
-- Data-only migration. No schema change; runs after server startup via
-- drizzle migrator. Idempotent: re-running has no effect (WHERE clauses
-- match nothing the second time).

-- 1. agent_configs: rename gemini → antigravity (preset, display_name, volume_mounts).
UPDATE "agent_configs"
SET "preset" = 'antigravity',
    "display_name" = 'Antigravity',
    "agent_command" = 'agy',
    "volume_mounts" = '[{"name":"antigravity-config","mountPath":"/home/workspace/.antigravity"}]'::jsonb,
    "updated_at" = now()
WHERE "preset" = 'gemini';
--> statement-breakpoint

-- 2. coding_sessions: re-tag existing gemini sessions to antigravity so historical
--    sessions remain inspectable and the preset filter in the UI keeps working.
UPDATE "coding_sessions"
SET "preset" = 'antigravity',
    "updated_at" = now()
WHERE "preset" = 'gemini';
--> statement-breakpoint

-- 3. codex: replace the deprecated `--full-auto` flag with the current
--    sandbox + approval flags. Scoped to rows still on the old command so
--    operator-customized rows are preserved.
UPDATE "agent_configs"
SET "agent_command" = 'codex --sandbox workspace-write --ask-for-approval on-request',
    "updated_at" = now()
WHERE "preset" = 'codex' AND "agent_command" = 'codex --full-auto';
