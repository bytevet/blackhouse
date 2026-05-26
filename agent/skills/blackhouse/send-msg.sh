#!/bin/bash
# Send a message to another Blackhouse session belonging to the same user.
# Usage:
#   send-msg.sh <target-session-id> <message>
#   send-msg.sh <target-session-id> <message> --wait=30s
#   echo "msg" | send-msg.sh <target-session-id> -
#
# --wait=<N>s polls for a reply referencing this send's request_id every
# 5s for up to N seconds. Exit 0 on reply received, 2 on timeout.
set -euo pipefail

SESSION_TOKEN="${SESSION_TOKEN:-${CONTAINER_TOKEN:-}}"

if [ -z "${SESSION_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "Error: SESSION_ID, BLACKHOUSE_URL, and SESSION_TOKEN must be set" >&2
  exit 1
fi

if [ "$#" -lt 2 ]; then
  echo "Usage: send-msg.sh <target-session-id> <message> [--wait=30s]" >&2
  echo "       echo 'msg' | send-msg.sh <target-session-id> - [--wait=30s]" >&2
  exit 1
fi

TARGET="$1"
MESSAGE="$2"
shift 2

WAIT_SEC=0
for arg in "$@"; do
  case "$arg" in
    --wait=*s) WAIT_SEC="${arg#--wait=}"; WAIT_SEC="${WAIT_SEC%s}";;
    --wait=*)  WAIT_SEC="${arg#--wait=}";;
    *) echo "Unknown arg: $arg" >&2; exit 1;;
  esac
done

# Allow piping the message body via `-`
if [ "$MESSAGE" = "-" ]; then
  MESSAGE=$(cat)
fi

# Generate a request_id so the receiver (or --wait poller) can correlate.
# Cheap source — 32 hex from /dev/urandom is collision-resistant for the
# 60s dedup window without dragging in uuidgen.
REQUEST_ID=$(head -c16 /dev/urandom | xxd -p)

PAYLOAD=$(jq -n \
  --arg t "$TARGET" \
  --arg m "$MESSAGE" \
  --arg r "$REQUEST_ID" \
  '{target_session_id: $t, message: $m, request_id: $r}')

RESPONSE=$(curl -sS -X POST "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/send-message" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD") || { echo "Failed to send message" >&2; exit 1; }

MSG_ID=$(printf '%s' "$RESPONSE" | jq -r '.message_id // empty')
if [ -z "$MSG_ID" ]; then
  echo "Send failed: $RESPONSE" >&2
  exit 1
fi
echo "Sent message_id=$MSG_ID request_id=$REQUEST_ID"

if [ "$WAIT_SEC" -gt 0 ]; then
  echo "Waiting up to ${WAIT_SEC}s for reply..."
  DEADLINE=$(( $(date +%s) + WAIT_SEC ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    REPLY=$(curl -sS \
      -H "Authorization: Bearer $SESSION_TOKEN" \
      "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/inbox?unread=true&reply_to=$REQUEST_ID") \
      || true
    COUNT=$(printf '%s' "$REPLY" | jq -r '.messages | length // 0')
    if [ "${COUNT:-0}" -gt 0 ]; then
      printf '%s\n' "$REPLY" | jq '.messages[0]'
      exit 0
    fi
    sleep 5
  done
  echo "Timeout waiting for reply" >&2
  exit 2
fi
