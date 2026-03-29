#!/bin/bash
# Update the session title in the Blackhouse UI.
# Usage: ~/.agents/skills/blackhouse/update-title.sh "implementing auth"
set -euo pipefail

SESSION_TOKEN="${SESSION_TOKEN:-${CONTAINER_TOKEN:-}}"

if [ -z "$SESSION_ID" ] || [ -z "$BLACKHOUSE_URL" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "Error: SESSION_ID, BLACKHOUSE_URL, and SESSION_TOKEN must be set" >&2
  exit 1
fi

TITLE="${1:?Usage: update-title.sh \"your status here\"}"

curl -sf -X POST "$BLACKHOUSE_URL/api/container/title" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg sid "$SESSION_ID" --arg tok "$SESSION_TOKEN" --arg title "$TITLE" \
    '{sessionId: $sid, token: $tok, title: $title}')" \
  && echo "Title updated: $TITLE" \
  || { echo "Failed to update title" >&2; exit 1; }
