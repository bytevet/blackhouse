#!/bin/bash
# Ask a human to dispatch another agent. THIS DOES NOT DISPATCH ANYTHING.
#
# Usage:
#   mention.sh '@handle' "what you want them to do" --channel '#channel'
#   echo "prompt" | mention.sh '@handle' - --channel '#channel'
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
#   --channel '#chan'   Which channel the card lands in. REQUIRED — the server
#                       does not infer it. If you don't know, run
#                       list-channels.sh; you can only file into a channel you
#                       are a member of.
#
# There is a cap on how many dispatch requests can sit pending in one channel
# at a time. Past it the server refuses with an explanation rather than
# queueing — that cap is the only backstop against an @a → @b → @a loop when a
# channel has auto-approve on.
#
# Prints the dispatch request id and its status (normally `pending`).
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
  mention.sh '@handle' "what you want them to do" --channel '#chan'
  echo "prompt" | mention.sh '@handle' - --channel '#chan'

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

if [ -z "$CHANNEL" ]; then
  echo "$SELF: --channel is required. Run list-channels.sh to see yours." >&2
  exit 1
fi

PAYLOAD=$(jq -n \
  --arg handle "$HANDLE" \
  --arg prompt "$PROMPT" \
  --arg channel "$CHANNEL" \
  '{channel: $channel, handle: $handle, prompt: $prompt}')

RAW=$(curl -sS -X POST "$BLACKHOUSE_URL/api/agent-runtime/mention" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Blackhouse-Agent: $AGENT_ID" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  -w $'\n%{http_code}') ||
  {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  echo "$SELF: POST /api/agent-runtime/mention failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  echo "$SELF: nothing was requested. @$HANDLE has not been contacted." >&2
  exit 1
fi

DISPATCH_ID=$(printf '%s' "$RESPONSE" | jq -r '.dispatchId // empty' 2>/dev/null || true)
DISPATCH_STATUS=$(printf '%s' "$RESPONSE" | jq -r '.status // empty' 2>/dev/null || true)
AUTO=$(printf '%s' "$RESPONSE" | jq -r '.autoApproved // false' 2>/dev/null || true)
NOTE=$(printf '%s' "$RESPONSE" | jq -r '.message // empty' 2>/dev/null || true)

# An empty dispatchId with a 2xx is the "too many pending in this channel"
# refusal — a real outcome, not a malformed response. Surface it as failure so
# a caller that checks the exit code does not think it filed something.
if [ -z "$DISPATCH_ID" ]; then
  echo "$SELF: the request was NOT filed." >&2
  printf '%s\n' "${NOTE:-$RESPONSE}" >&2
  exit 1
fi

echo "Filed a dispatch request for @$HANDLE — id=$DISPATCH_ID status=${DISPATCH_STATUS:-pending}"
if [ -n "$NOTE" ]; then echo "$NOTE"; fi
if [ "$AUTO" = "true" ]; then
  echo "Auto-approved by #$CHANNEL policy — @$HANDLE is being dispatched."
  echo "It may still be busy; delivery happens when it next goes idle."
else
  echo "NOT dispatched. A human must approve the card in #$CHANNEL."
  echo "Assume @$HANDLE knows nothing about this. Keep working on your own part."
fi
exit 0
