#!/bin/bash
# Set your status line — the one-liner shown under your @handle in the roster.
#
# Usage:
#   update-title.sh "reading the auth middleware"
#   update-title.sh "waiting on @reviewer's dispatch card"
#
# Humans watching the sidebar see this next to your activity dot. `busy` tells
# them you are working; the status line tells them what you are working ON.
# Those are different questions and only you can answer the second.
#
# Write it the way you would answer "what are you up to?" over someone's
# shoulder: present tense, specific, short. "running the e2e suite" is useful.
# "working" is not. Update it when you change tasks, not on a timer — a status
# line that never changes is the same as no status line.
#
# 200 characters max; the server rejects longer. Not a log — a rewrite of one
# field, so nothing is preserved.
set -euo pipefail

SELF="update-title.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

STATUS_LINE="${1:-}"
if [ -z "$STATUS_LINE" ]; then
  echo "Usage: update-title.sh \"what you are working on right now\"" >&2
  exit 2
fi

PAYLOAD=$(jq -n --arg statusLine "$STATUS_LINE" '{statusLine: $statusLine}')

RAW=$(curl -sS -X POST "$BLACKHOUSE_URL/api/agent-runtime/title" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Blackhouse-Agent: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -w $'\n%{http_code}') ||
  {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

HTTP_STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "$SELF: POST /api/agent-runtime/title failed with HTTP $HTTP_STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Status line: $STATUS_LINE"
