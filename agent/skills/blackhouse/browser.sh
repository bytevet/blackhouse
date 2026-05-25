#!/bin/bash
# Drive the Blackhouse embedded browser from inside the agent container.
#
# Usage:
#   browser.sh navigate <url>
#   browser.sh back
#   browser.sh forward
#   browser.sh reload
#
# Talks to the in-container browser service on 127.0.0.1:9223. The Blackhouse
# server proxies its screencast to the React Browser tab, so anything you
# navigate here is visible to the user immediately.
set -euo pipefail

BROWSER_SERVICE_URL="${BROWSER_SERVICE_URL:-http://127.0.0.1:9223}"

usage() {
  cat >&2 <<'USAGE'
Usage:
  browser.sh navigate <url>
  browser.sh back
  browser.sh forward
  browser.sh reload
USAGE
  exit 2
}

post_control() {
  local payload="$1"
  curl -fsS -X POST "${BROWSER_SERVICE_URL}/browser/control" \
    -H 'content-type: application/json' \
    -d "$payload"
}

action="${1:-}"
case "$action" in
  navigate)
    url="${2:-}"
    [ -n "$url" ] || usage
    post_control "$(jq -nc --arg u "$url" '{action:"navigate", url:$u}')"
    ;;
  back)
    post_control '{"action":"back"}'
    ;;
  forward)
    post_control '{"action":"forward"}'
    ;;
  reload)
    post_control '{"action":"reload"}'
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "browser.sh: unknown subcommand: $action" >&2
    usage
    ;;
esac
echo
