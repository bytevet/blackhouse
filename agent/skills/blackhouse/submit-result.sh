#!/bin/bash
# Submit HTML to the Blackhouse result viewer.
# Usage: cat result.html | ~/.agents/skills/blackhouse/submit-result.sh
#    or: echo "<html>...</html>" | ~/.agents/skills/blackhouse/submit-result.sh
set -euo pipefail

SESSION_TOKEN="${SESSION_TOKEN:-${CONTAINER_TOKEN:-}}"

if [ -z "$SESSION_ID" ] || [ -z "$BLACKHOUSE_URL" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "Error: SESSION_ID, BLACKHOUSE_URL, and SESSION_TOKEN must be set" >&2
  exit 1
fi

HTML=$(cat)
if [ -z "$HTML" ]; then
  echo "Error: No HTML provided on stdin" >&2
  exit 1
fi

curl -sf -X POST "$BLACKHOUSE_URL/api/container/result" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg sid "$SESSION_ID" --arg tok "$SESSION_TOKEN" --arg html "$HTML" \
    '{sessionId: $sid, token: $tok, html: $html}')" \
  && echo "Result submitted successfully" \
  || { echo "Failed to submit result" >&2; exit 1; }
