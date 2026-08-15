#!/bin/bash
# Ask a human to dispatch another agent. THIS DOES NOT DISPATCH ANYTHING.
#
# Usage:
#   mention.sh '@handle' "what you want them to do"
#   mention.sh '@handle' "prompt" --channel '#channel'
#   echo "prompt" | mention.sh '@handle' -
#   mention.sh '@handle' "prompt" --request-id <id>
#
# READ THIS BEFORE YOU USE IT
#
#   Agent-to-agent dispatch is human-gated. Running this script posts a
#   *pending dispatch card* into the channel: caller, callee, and your proposed
#   prompt, with Approve / Edit & approve / Deny buttons. A human decides.
#   The card can also expire unanswered.
#
#   So:
#     - @handle has NOT been told anything when this command exits.
#     - Nothing lands in their terminal until a human clicks Approve.
#     - The human may EDIT your prompt before approving it, so the peer may
#       receive something different from what you wrote.
#     - Do not block waiting for a reply. Do not write "as @reviewer confirmed"
#       when all you did was file a request.
#
#   The one exception: a channel can have auto-approve turned on, in which case
#   the dispatch skips the hold and the card is written as an after-the-fact
#   record. You cannot rely on that being the case, and you cannot turn it on.
#   Write your prompt as if a human will read it, because usually one will.
#
#   The right shape of work is therefore: file the request, say what you filed
#   in the channel if it matters, and carry on with what you can do yourself.
#   If the peer's answer is genuinely a prerequisite, post that you are blocked
#   on it and stop — a human will unblock you. Sitting in a poll loop burns
#   budget and gets you paused.
#
# Options:
#   --channel '#chan'   Which channel the card lands in. Defaults to the
#                       channel of the run you are currently handling; required
#                       if the server cannot infer one.
#   --request-id <id>   Idempotency key, so a retry does not file the same
#                       request twice. Generated if omitted.
#
# Prints the dispatch request id and its status (normally `pending`). Check the
# channel with read.sh later if you need to know how it was decided.
set -euo pipefail

SELF="mention.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  mention.sh '@handle' "what you want them to do" [--channel '#chan'] [--request-id <id>]
  echo "prompt" | mention.sh '@handle' -

This does NOT dispatch. It files a request as a pending card in the channel;
a human approves, edits, denies, or lets it expire. Assume the peer has not
been told anything, and keep working on what you can do yourself.
USAGE
  exit 2
}

case "${1:-}" in
  "" | -h | --help | help) usage ;;
esac

HANDLE="$1"
PROMPT="${2:-}"
if [ "$#" -lt 2 ]; then usage; fi
shift 2

CHANNEL=""
REQUEST_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      [ -n "$CHANNEL" ] || usage
      shift 2
      ;;
    --channel=*)
      CHANNEL="${1#--channel=}"
      shift
      ;;
    --request-id)
      REQUEST_ID="${2:-}"
      [ -n "$REQUEST_ID" ] || usage
      shift 2
      ;;
    --request-id=*)
      REQUEST_ID="${1#--request-id=}"
      shift
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [ "$PROMPT" = "-" ]; then
  PROMPT=$(cat)
fi

HANDLE="${HANDLE#@}"
CHANNEL="${CHANNEL#\#}"

if [ -z "$HANDLE" ]; then
  echo "$SELF: target handle is required (e.g. '@reviewer'). Run list-channels.sh." >&2
  exit 1
fi

if [ -z "$PROMPT" ]; then
  echo "$SELF: refusing to file an empty request — say what you want done" >&2
  exit 1
fi

if [ -z "$REQUEST_ID" ]; then
  REQUEST_ID=$(openssl rand -hex 16)
fi

PAYLOAD=$(jq -n \
  --arg to "$HANDLE" \
  --arg prompt "$PROMPT" \
  --arg channel "$CHANNEL" \
  --arg request_id "$REQUEST_ID" \
  '{to_handle: $to, prompt: $prompt, request_id: $request_id}
   + (if $channel == "" then {} else {channel: $channel} end)')

RAW=$(curl -sS -X POST "$BLACKHOUSE_URL/api/agent-runtime/dispatches" \
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
  echo "$SELF: POST /api/agent-runtime/dispatches failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  echo "$SELF: nothing was requested. @$HANDLE has not been contacted." >&2
  exit 1
fi

DISPATCH_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // .dispatch_id // empty' 2>/dev/null || true)
DISPATCH_STATUS=$(printf '%s' "$RESPONSE" | jq -r '.status // empty' 2>/dev/null || true)

if [ -z "$DISPATCH_ID" ]; then
  echo "$SELF: server accepted the request but returned no dispatch id:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Filed a dispatch request for @$HANDLE — id=$DISPATCH_ID status=${DISPATCH_STATUS:-pending}"
case "$DISPATCH_STATUS" in
  approved | auto_approved)
    echo "Auto-approved by channel policy — @$HANDLE is being dispatched."
    ;;
  *)
    echo "NOT dispatched. A human must approve the card in the channel."
    echo "Assume @$HANDLE knows nothing about this. Keep working on your own part."
    ;;
esac
