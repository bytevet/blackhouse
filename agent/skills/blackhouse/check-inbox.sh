#!/bin/bash
# Inspect and ack the Blackhouse inbox for this session.
#
# Modes:
#   check-inbox.sh                  Fetch unread + print; NEVER acks.
#                                   Caches fetched IDs to /tmp/.blackhouse-last-fetch
#                                   so a follow-up --ack-all can target them.
#   check-inbox.sh --ack <msg-id>   Ack a single message by id.
#   check-inbox.sh --ack-all        Ack every id in /tmp/.blackhouse-last-fetch,
#                                   then delete the cache file.
#
# Acks are NEVER implicit. After processing a message, run --ack <id> or
# --ack-all. At-least-once delivery: handlers must be idempotent via the
# request_id field on the message.
set -euo pipefail

SESSION_TOKEN="${SESSION_TOKEN:-${CONTAINER_TOKEN:-}}"
CACHE_FILE="/tmp/.blackhouse-last-fetch"

if [ -z "${SESSION_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "$SESSION_TOKEN" ]; then
  echo "Error: SESSION_ID, BLACKHOUSE_URL, and SESSION_TOKEN must be set" >&2
  exit 1
fi

MODE="fetch"
ACK_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ack)
      MODE="ack-one"
      ACK_ID="${2:-}"
      if [ -z "$ACK_ID" ]; then
        echo "Usage: check-inbox.sh --ack <msg-id>" >&2
        exit 1
      fi
      shift 2
      ;;
    --ack-all)
      MODE="ack-all"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  fetch)
    RESPONSE=$(curl -sS \
      -H "Authorization: Bearer $SESSION_TOKEN" \
      "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/inbox?unread=true") \
      || { echo "Failed to fetch inbox" >&2; exit 1; }

    # Cache IDs for --ack-all (one id per line). Empty cache for empty
    # inbox so --ack-all later doesn't accidentally target stale IDs.
    printf '%s' "$RESPONSE" | jq -r '.messages[].id' > "$CACHE_FILE"
    COUNT=$(wc -l < "$CACHE_FILE" | tr -d ' ')
    if [ "${COUNT:-0}" = "0" ]; then
      echo "Inbox empty."
      exit 0
    fi
    echo "Unread messages ($COUNT):"
    printf '%s' "$RESPONSE" | jq -r '
      .messages[] |
      "---\n[\(.id)]\nfrom: \(.fromSessionId)\nsent: \(.createdAt)\nrequest_id: \(.requestId // "<none>")\n\n\(.message)"
    '
    ;;

  ack-one)
    RESPONSE=$(curl -sS -X PUT \
      -H "Authorization: Bearer $SESSION_TOKEN" \
      "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/messages/$ACK_ID/ack") \
      || { echo "Failed to ack $ACK_ID" >&2; exit 1; }
    printf '%s\n' "$RESPONSE"
    ;;

  ack-all)
    if [ ! -f "$CACHE_FILE" ]; then
      echo "no recent fetch to ack"
      exit 0
    fi
    # Build the ID array from the cache. jq -R reads raw lines.
    IDS_JSON=$(jq -R . < "$CACHE_FILE" | jq -s '{ids: .}')
    if [ "$(printf '%s' "$IDS_JSON" | jq '.ids | length')" = "0" ]; then
      echo "no recent fetch to ack"
      rm -f "$CACHE_FILE"
      exit 0
    fi
    RESPONSE=$(curl -sS -X PUT \
      -H "Authorization: Bearer $SESSION_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$IDS_JSON" \
      "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/messages/ack-batch") \
      || { echo "Failed to ack batch" >&2; exit 1; }
    printf '%s\n' "$RESPONSE"
    rm -f "$CACHE_FILE"
    ;;
esac
