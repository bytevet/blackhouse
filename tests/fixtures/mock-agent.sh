#!/bin/bash
# Mock agent for e2e testing — simulates the system-prompt convention that
# the real agent CLIs (Claude / Codex / Antigravity) follow. Polls for
# `/tmp/.blackhouse-hint` (the file the entrypoint.sh:2c sidecar daemon
# writes when unread > 0), runs `check-inbox.sh` to read pending messages,
# then `--ack-all` to clear them.
#
# Used by `tests/e2e/messaging.spec.ts` to validate the full messaging
# wiring (send → DB → sidecar → hint → agent → check-inbox → ack-batch)
# without requiring real agent credentials.
#
# The 2s poll cadence is tighter than the sidecar's 5s — guarantees we
# react to the hint within one sidecar cycle, so the e2e's 60s budget
# isn't dominated by the mock's own polling interval.
set -e
LOG=/tmp/mock-agent-inbox.log
SKILL=$HOME/.agents/skills/blackhouse
while true; do
  if [ -f /tmp/.blackhouse-hint ]; then
    bash "$SKILL/check-inbox.sh" >>"$LOG" 2>&1 || true
    bash "$SKILL/check-inbox.sh" --ack-all >>"$LOG" 2>&1 || true
  fi
  sleep 2
done
