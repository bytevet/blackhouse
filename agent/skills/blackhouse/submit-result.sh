#!/bin/bash
# Publish an artifact into a Blackhouse channel.
#
# Usage:
#   cat report.html | submit-result.sh '#channel'
#   cat report.html | submit-result.sh '#channel' --title "Q3 latency report"
#   submit-result.sh '#channel' --url https://example.com/build/123 --title "CI run"
#   submit-result.sh '#channel' --kind text --title "diff summary" < summary.txt
#
# An artifact is a *rendered result*, not a message. It lands in the channel as
# a card the humans can expand and look at inline — a chart, a report, a game,
# a mockup. Use it whenever you produce something meant to be LOOKED at rather
# than read as prose.
#
# If you produce HTML, submit it here. Do not tell a human to open a file: they
# are not on the machine you are on, there is no desktop, and a path in a
# message is a dead end for them.
#
# Options:
#   --title <text>   Card heading. Strongly recommended — an untitled card is
#                    hard to find again once the channel scrolls.
#   --kind <k>       html (default) | text | link | file
#   --url <url>      For --kind link. Mutually exclusive with stdin content.
#
# HTML must be a complete self-contained document: inline your CSS and JS.
# External stylesheets and scripts may not load in the viewer.
set -euo pipefail

SELF="submit-result.sh"

if [ -z "${AGENT_ID:-}" ] || [ -z "${BLACKHOUSE_URL:-}" ] || [ -z "${AGENT_TOKEN:-}" ]; then
  echo "$SELF: AGENT_ID, BLACKHOUSE_URL, and AGENT_TOKEN must be set" >&2
  echo "$SELF: these are injected by the Blackhouse entrypoint; if they are" >&2
  echo "$SELF: missing you are probably not running inside an agent container." >&2
  exit 1
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  cat result.html | submit-result.sh '#channel' [--title "..."] [--kind html|text|file]
  submit-result.sh '#channel' --kind link --url https://... [--title "..."]

Publishes a rendered artifact as a card in the channel.
USAGE
  exit 2
}

case "${1:-}" in
  "" | -h | --help | help) usage ;;
esac

CHANNEL="${1#\#}"
shift

TITLE=""
KIND="html"
URL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --title=*)
      TITLE="${1#--title=}"
      shift
      ;;
    --kind)
      KIND="${2:-}"
      shift 2
      ;;
    --kind=*)
      KIND="${1#--kind=}"
      shift
      ;;
    --url)
      URL="${2:-}"
      shift 2
      ;;
    --url=*)
      URL="${1#--url=}"
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

BODY=""
if [ -z "$URL" ]; then
  BODY=$(cat)
  if [ -z "$BODY" ]; then
    echo "$SELF: nothing on stdin and no --url given — nothing to publish" >&2
    exit 1
  fi
fi

PAYLOAD=$(jq -n \
  --arg channel "$CHANNEL" \
  --arg title "$TITLE" \
  --arg kind "$KIND" \
  --arg body "$BODY" \
  --arg url "$URL" \
  '{channel: $channel, kind: $kind}
   + (if $title == "" then {} else {title: $title} end)
   + (if $body  == "" then {} else {body: $body} end)
   + (if $url   == "" then {} else {url: $url} end)')

RAW=$(curl -sS -X POST "$BLACKHOUSE_URL/api/agent-runtime/artifacts" \
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
  echo "$SELF: POST /api/agent-runtime/artifacts failed with HTTP $STATUS" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

ARTIFACT_ID=$(printf '%s' "$RESPONSE" | jq -r '.artifact.id // empty' 2>/dev/null || true)
if [ -z "$ARTIFACT_ID" ]; then
  echo "$SELF: server accepted the request but returned no artifact id:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Published ${TITLE:-artifact} to #$CHANNEL — id=$ARTIFACT_ID kind=$KIND"
