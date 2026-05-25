-- Align the antigravity agent_command with what `src/lib/agent-presets.ts`
-- now uses. The original 0002 cutover wrote `agy` (interactive prompt for
-- every tool call). Smoke-testing showed the user wants the same
-- "auto-approve" UX that claude-code already has via
-- `--dangerously-skip-permissions`. Scoped to rows still on the bare `agy`
-- command so any operator-customized rows are preserved.

UPDATE "agent_configs"
SET "agent_command" = 'agy --dangerously-skip-permissions',
    "updated_at" = now()
WHERE "preset" = 'antigravity' AND "agent_command" = 'agy';
