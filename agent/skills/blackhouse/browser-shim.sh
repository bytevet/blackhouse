#!/bin/bash
# $BROWSER / xdg-open shim — routes any URL passed by an external tool into
# the Blackhouse embedded browser. Installed in the agent container at
# /opt/blackhouse/browser-shim.sh and pointed at via:
#
#   ENV BROWSER=/opt/blackhouse/browser-shim.sh
#
# Tools like `npm`, `gh`, and various dev servers respect $BROWSER and will
# invoke us with the URL as the first arg.
set -euo pipefail

# The actual browser skill is installed under one of these paths depending on
# how `npx skills add` was run (global vs per-user). Try both.
for candidate in \
  "/opt/blackhouse/skills/blackhouse/browser.sh" \
  "$HOME/.agents/skills/blackhouse/browser.sh" \
  "$HOME/.claude/skills/blackhouse/browser.sh"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" navigate "$@"
  fi
done

# Fall back to talking directly to the browser service if the skill file
# isn't where we expected — still better than failing silently.
exec curl -fsS -X POST "${BROWSER_SERVICE_URL:-http://127.0.0.1:9223}/browser/control" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg u "${1:-about:blank}" '{action:"navigate", url:$u}')"
