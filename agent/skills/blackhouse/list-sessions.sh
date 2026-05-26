#!/bin/bash
# List every Blackhouse session belonging to this user. Cheap wrapper for
# agent discovery — use the IDs returned here as the target of send-msg.sh.
# Usage: list-sessions.sh
set -euo pipefail

SESSION_TOKEN="${SESSION_TOKEN:-${CONTAINER_TOKEN:-}}"

if [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "Error: BLACKHOUSE_URL and SESSION_TOKEN must be set" >&2
  exit 1
fi

RESPONSE=$(curl -sS \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  "$BLACKHOUSE_URL/api/sessions/list-mine") \
  || { echo "Failed to list sessions" >&2; exit 1; }

# Table-ish layout. jq -r tab-joins so the human + grep + awk all work.
printf '%s\n' "$RESPONSE" | jq -r '
  .sessions[] |
  "\(.id)\t\(.status)\t\(.preset)\t\(.name)\(.agentTitle as $t | if $t then " — " + $t else "" end)"
'
