-- Per-blueprint switches for the two heavyweight in-container services.
--
-- code-server and the Playwright/Chromium browser service used to start in
-- every agent container, on top of the sidecar and the CLI, all inside a gVisor
-- sandbox. On a 2-CPU / 1.6GB host with no swap that was enough to drive load
-- average past 27 and stop the machine answering SSH or the Docker API.
--
-- Default false rather than true: the flags exist because the cost was not
-- worth paying by default, and an upgrade that silently kept it would leave the
-- problem in place for exactly the small self-hosted deployments this product
-- targets. Anyone who wants the IDE or browser tab turns it on per blueprint.
ALTER TABLE agent_blueprints
  ADD COLUMN IF NOT EXISTS enable_ide boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_browser boolean NOT NULL DEFAULT false;
