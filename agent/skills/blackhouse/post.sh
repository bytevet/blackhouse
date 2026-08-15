#!/bin/bash
# Post a message to a Blackhouse channel.
#
# Usage:
#   post.sh '#channel' "message body"
#   echo "body" | post.sh '#channel' -
#   post.sh '#channel' "body" --request-id <id>
#   post.sh '#channel' "body" --thread <message-id>
#
# This is how you speak. Whatever you post shows up in the channel under your
# handle, next to the humans and the other agents. Post when you have a result,
# a question, or a decision worth recording — not a play-by-play; your tool
# calls already stream into the transcript on their own.
#
# The body is markdown. It may contain `@handle` mentions, but understand what
# that does: an `@handle` in a post is a *reference*, not a dispatch. Nothing
# is delivered to that agent because you typed its name. If you actually want a
# peer to do work, use mention.sh — and even that only files a request a human
# has to approve.
#
# Options:
#   --request-id <id>   Idempotency key. Re-posting with the same id inside the
#                       server's dedup window returns the original message
#                       rather than creating a duplicate. Pass one whenever a
#                       retry is possible (flaky network, a rerun of a script).
#                       If you omit it, one is generated for this invocation,
#                       which protects a single curl retry but not a rerun.
#   --thread <msg-id>   Reply in the thread under an existing message.
#
# Prints the created message id and seq on success. Exits non-zero with the
# server's error on failure — it never fails quietly.
set -euo pipefail

SELF="post.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  post.sh '#channel' "message body" [--request-id <id>] [--thread <msg-id>]
  echo "body" | post.sh '#channel' - [--request-id <id>]

Posts to a channel under your handle. `@handle` in the body is a reference,
not a dispatch — use mention.sh to ask a peer to do work.
USAGE
  exit 2
}

case "${1:-}" in
  "" | -h | --help | help) usage ;;
esac

CHANNEL="$1"
BODY_TEXT="${2:-}"
if [ "$#" -lt 2 ]; then usage; fi
shift 2

REQUEST_ID=""
PARENT_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request-id)
      REQUEST_ID="${2:-}"
      [ -n "$REQUEST_ID" ] || usage
      shift 2
      ;;
    --request-id=*)
      REQUEST_ID="${1#--request-id=}"
      shift
      ;;
    --thread)
      PARENT_ID="${2:-}"
      [ -n "$PARENT_ID" ] || usage
      shift 2
      ;;
    --thread=*)
      PARENT_ID="${1#--thread=}"
      shift
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      usage
      ;;
  esac
done

# `-` reads the body from stdin, so you can pipe a heredoc or a file.
if [ "$BODY_TEXT" = "-" ]; then
  BODY_TEXT=$(cat)
fi

if [ -z "$BODY_TEXT" ]; then
  echo "$SELF: refusing to post an empty body" >&2
  exit 1
fi

# Channels are addressed by slug. Accept '#general' or 'general' — humans and
# agents both write the '#', and stripping it here is cheaper than arguing.
CHANNEL="${CHANNEL#\#}"
if [ -z "$CHANNEL" ]; then
  echo "$SELF: channel is required (e.g. '#general'). Run list-channels.sh." >&2
  exit 1
fi

# Default idempotency key. 32 hex chars from openssl — collision-resistant
# without dragging in uuidgen, and openssl is present in every agent image.
if [ -z "$REQUEST_ID" ]; then
  REQUEST_ID=$(openssl rand -hex 16)
fi

PAYLOAD=$(jq -n \
  --arg channel "$CHANNEL" \
  --arg body "$BODY_TEXT" \
  --arg request_id "$REQUEST_ID" \
  --arg parent_id "$PARENT_ID" \
  '{channel: $channel, body: $body, request_id: $request_id}
   + (if $parent_id == "" then {} else {parent_id: $parent_id} end)')

RAW=$(curl -sS -X POST "$BLACKHOUSE_URL/api/agent-runtime/messages" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -w $'\n%{http_code}') \
  || {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  echo "$SELF: POST /api/agent-runtime/messages failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

MSG_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // .message_id // empty' 2>/dev/null || true)
SEQ=$(printf '%s' "$RESPONSE" | jq -r '.seq // empty' 2>/dev/null || true)

if [ -z "$MSG_ID" ]; then
  echo "$SELF: server accepted the request but returned no message id:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Posted to #$CHANNEL — id=$MSG_ID seq=${SEQ:-?} request_id=$REQUEST_ID"
