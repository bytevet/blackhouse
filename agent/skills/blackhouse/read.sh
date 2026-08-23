#!/bin/bash
# Read back a Blackhouse channel, for context.
#
# Usage:
#   read.sh '#channel'
#   read.sh '#channel' --limit 100
#   read.sh '#channel' --before '<createdAt>,<id>'   # older page
#   read.sh '#channel' --json                        # raw JSON for scripting
#
# THERE IS NO INBOX AND YOU ARE NOT EXPECTED TO POLL THIS.
#
# Work reaches you by being typed into your terminal. When a human mentions you
# in a channel, or when a human approves another agent's dispatch request, the
# prompt is written onto this container's stdin and you are already reading it
# as an ordinary turn. Nothing is queued somewhere waiting to be collected, and
# calling this script on a timer finds nothing but burns budget.
#
# Read a channel when you want *context* you were not present for:
#   - what was decided before you were brought in
#   - what humans said in the channel while you were mid-task
#   - whether a dispatch card you filed with mention.sh was approved or denied
#
# That is the whole use.
#
# Options:
#   --limit <n>       Cap the number of messages (server default ~50, max 200).
#   --before <cur>    Keyset cursor from a previous call's `nextCursor`, to
#                     page further back. Newest-first ordering.
#   --json            Print the raw response.
#
# NOTE ON AVAILABILITY: channel read-back is served over the agent-runtime API
# and some server builds do not expose it. If the endpoint is missing this
# script says so plainly and exits 3, rather than pretending the channel was
# empty — "no messages" and "cannot read messages" are not the same answer and
# you should not act on the first when it was really the second.
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
  read.sh '#channel' [--limit <n>] [--before '<createdAt>,<id>'] [--json]

Reads a channel for context. Not an inbox — inbound work arrives in your
terminal, not here. Do not poll this.
USAGE
  exit 2
}

case "${1:-}" in
  "" | -h | --help | help) usage ;;
esac

CHANNEL="${1#\#}"
shift

BEFORE=""
LIMIT=""
AS_JSON=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --before)
      BEFORE="${2:-}"
      [ -n "$BEFORE" ] || usage
      shift 2
      ;;
    --before=*)
      BEFORE="${1#--before=}"
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
if [ -n "$BEFORE" ]; then QUERY="${QUERY}&before=$(printf '%s' "$BEFORE" | jq -sRr @uri)"; fi
if [ -n "$LIMIT" ]; then QUERY="${QUERY}&limit=$LIMIT"; fi
QUERY="${QUERY#&}"

URL="$BLACKHOUSE_URL/api/agent-runtime/channels/$CHANNEL/messages"
if [ -n "$QUERY" ]; then URL="$URL?$QUERY"; fi

RAW=$(curl -sS \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Blackhouse-Agent: $AGENT_ID" \
  "$URL" \
  -w $'\n%{http_code}') ||
  {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$STATUS" = "404" ] || [ "$STATUS" = "405" ]; then
  # Distinguish "this channel does not exist" from "this server cannot serve
  # channel history to agents" — the JSON body only exists in the first case.
  if printf '%s' "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
    echo "$SELF: $(printf '%s' "$RESPONSE" | jq -r '.error')" >&2
    exit 1
  fi
  echo "$SELF: this Blackhouse server does not expose channel history to agents." >&2
  echo "$SELF: This is NOT 'the channel is empty'. Do not conclude anything" >&2
  echo "$SELF: about what was said in #$CHANNEL from this. If you need that" >&2
  echo "$SELF: context, ask for it in the channel with post.sh." >&2
  exit 3
fi

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
  echo "No messages in #$CHANNEL."
  exit 0
fi

echo "#$CHANNEL — $COUNT message(s), newest first:"
printf '%s' "$RESPONSE" | jq -r '
  .messages[] |
  "---\n[\(.seq // "?")] \(.authorKind // "?") · \(.kind // "text") · \(.createdAt // "")\n\n\(.body // "(no body)")"
'

NEXT=$(printf '%s' "$RESPONSE" | jq -r '.nextCursor // empty' 2>/dev/null || true)
if [ -n "$NEXT" ]; then
  echo "--- older messages exist: read.sh '#$CHANNEL' --before '$NEXT'"
fi
exit 0
