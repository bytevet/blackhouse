#!/bin/bash
# Read back a Blackhouse channel.
#
# Usage:
#   read.sh '#channel'                  # everything since your stored cursor
#   read.sh '#channel' --since 1420     # from an explicit seq, cursor untouched
#   read.sh '#channel' --limit 200
#   read.sh '#channel' --json           # raw JSON instead of the text layout
#
# This is NOT an inbox and you are NOT expected to poll it. Work reaches you by
# being typed into your terminal — if a human or an approved peer wants
# something from you, you are already reading it. There is nothing queued up
# somewhere waiting to be collected.
#
# Read a channel when you want *context*: what was decided before you were
# brought in, what the humans said while you were working, whether a dispatch
# card you filed with mention.sh was approved or denied. That is the whole use.
#
# Cursor behaviour:
#   With no --since, you get messages after your stored cursor and the cursor
#   advances past what you were shown, so a second call returns only what is
#   new. With --since <seq>, you read from that point and the cursor is left
#   alone — use it to re-read history without losing your place.
#
# Options:
#   --since <seq>   Start after this message seq (does not move your cursor).
#   --limit <n>     Cap the number of messages returned (server default ~50).
#   --json          Print the raw response for scripting.
#
# Exits 0 with "No new messages." when the channel is quiet.
set -euo pipefail

SELF="read.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  read.sh '#channel' [--since <seq>] [--limit <n>] [--json]

Reads a channel for context. Not an inbox — inbound work arrives in your
terminal, not here. With no --since, reads from your stored cursor and
advances it.
USAGE
  exit 2
}

case "${1:-}" in
  "" | -h | --help | help) usage ;;
esac

CHANNEL="${1#\#}"
shift

SINCE=""
LIMIT=""
AS_JSON=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --since)
      SINCE="${2:-}"
      [ -n "$SINCE" ] || usage
      shift 2
      ;;
    --since=*)
      SINCE="${1#--since=}"
      shift
      ;;
    --limit)
      LIMIT="${2:-}"
      [ -n "$LIMIT" ] || usage
      shift 2
      ;;
    --limit=*)
      LIMIT="${1#--limit=}"
      shift
      ;;
    --json)
      AS_JSON=1
      shift
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [ -z "$CHANNEL" ]; then
  echo "$SELF: channel is required (e.g. '#general'). Run list-channels.sh." >&2
  exit 1
fi

QUERY=""
if [ -n "$SINCE" ]; then QUERY="${QUERY}&since=$SINCE"; fi
if [ -n "$LIMIT" ]; then QUERY="${QUERY}&limit=$LIMIT"; fi
QUERY="${QUERY#&}"

URL="$BLACKHOUSE_URL/api/agent-runtime/channels/$CHANNEL/messages"
if [ -n "$QUERY" ]; then URL="$URL?$QUERY"; fi

RAW=$(curl -sS \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  "$URL" \
  -w $'\n%{http_code}') \
  || {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  echo "$SELF: GET $URL failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

if [ "$AS_JSON" = "1" ]; then
  printf '%s\n' "$RESPONSE"
  exit 0
fi

COUNT=$(printf '%s' "$RESPONSE" | jq -r '(.messages // []) | length' 2>/dev/null || echo "")
if [ -z "$COUNT" ]; then
  echo "$SELF: could not parse the server response as JSON:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

if [ "$COUNT" = "0" ]; then
  echo "No new messages in #$CHANNEL."
  exit 0
fi

echo "#$CHANNEL — $COUNT message(s):"
printf '%s' "$RESPONSE" | jq -r '
  .messages[] |
  "---\n[\(.seq // "?")] \(.author // .author_handle // "unknown") · \(.kind // "text") · \(.created_at // .createdAt // "")\n\n\(.body // "")"
'

CURSOR=$(printf '%s' "$RESPONSE" | jq -r '.cursor // empty' 2>/dev/null || true)
if [ -n "$CURSOR" ]; then
  echo "--- (cursor now at seq $CURSOR)"
fi
exit 0
