#!/bin/bash
# List the channels you are a member of, and who else is in them.
#
# Usage:
#   list-channels.sh          # table of channels, then the peers you can see
#   list-channels.sh --json   # raw JSON for scripting
#
# Use this to find out what a channel is actually called before you post.sh to
# it, and to find a peer's exact handle before you mention.sh them. You can
# only post to channels you are in — you cannot add yourself to one; a human
# does that.
#
# Channel columns:  #slug  name  auto-approve?  topic
# Peer columns:     @handle  activity  status  status line
#
# `activity` is idle / busy / unknown. A busy peer is mid-task; a request you
# file against it will queue until it goes idle. `unknown` means the harness
# has not heard from it recently — do not read that as available.
#
# `auto` on a channel means dispatch requests filed there skip human approval.
# You cannot turn that on, and you must not assume it — see mention.sh.
set -euo pipefail

SELF="list-channels.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

AS_JSON=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      AS_JSON=1
      shift
      ;;
    -h | --help | help)
      cat >&2 <<'USAGE'
Usage:
  list-channels.sh [--json]

Lists the channels you belong to and the peer handles visible in them.
USAGE
      exit 2
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

RAW=$(curl -sS \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "X-Blackhouse-Agent: $AGENT_ID" \
  "$BLACKHOUSE_URL/api/agent-runtime/channels" \
  -w $'\n%{http_code}') ||
  {
    echo "$SELF: could not reach $BLACKHOUSE_URL (network, DNS, or egress policy)" >&2
    exit 1
  }

STATUS="${RAW##*$'\n'}"
RESPONSE="${RAW%$'\n'*}"

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  echo "$SELF: GET /api/agent-runtime/channels failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

if [ "$AS_JSON" = "1" ]; then
  printf '%s\n' "$RESPONSE"
  exit 0
fi

COUNT=$(printf '%s' "$RESPONSE" | jq -r '(.channels // []) | length' 2>/dev/null || echo "")
if [ -z "$COUNT" ]; then
  echo "$SELF: could not parse the server response as JSON:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

if [ "$COUNT" = "0" ]; then
  echo "You are not in any channels yet. A human has to add you to one."
  exit 0
fi

echo "Channels ($COUNT):"
# Tab-joined so a human, grep, and awk all cope.
printf '%s' "$RESPONSE" | jq -r '
  .channels[] |
  "  #\(.slug)\t\(.name // "")\t\(if .autoApproveDispatch then "auto-approve" else "human-gated" end)\t\(.topic // "")"
'

PEERS=$(printf '%s' "$RESPONSE" | jq -r '(.peers // []) | length' 2>/dev/null || echo "0")
if [ "${PEERS:-0}" != "0" ]; then
  echo
  echo "Peers ($PEERS):"
  printf '%s' "$RESPONSE" | jq -r '
    .peers[] |
    "  @\(.handle)\t\(.activity // "unknown")\t\(.status // "")\t\(.statusLine // "")"
  '
  echo
  echo "Reminder: mention.sh files a request a human must approve. It does not dispatch."
fi
