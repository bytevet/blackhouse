#!/bin/bash
# A fake agent CLI, for testing the harness without agent credentials.
#
# Replaces `tests/fixtures/mock-agent.sh`, which polled `/tmp/.blackhouse-hint`
# for the DM inbox that channels replaced.
#
# It stands in for Claude Code well enough to exercise the entire vertical
# slice, and it proves three separate things that are otherwise only testable
# with a real API key:
#
#   (a) INJECTION LANDED. It reads stdin and echoes `> <line>`. If a channel
#       mention reaches the container's PTY, that echo appears in the terminal
#       tab and in the PTY scrollback. If the entrypoint ever regresses to
#       handing the PTY to a shell, `> ...` is replaced by a shell error or,
#       worse, by the prompt executing — either is loudly visible.
#
#   (b) THE ADAPTER WORKS. It appends Claude-Code-shaped records to
#       $CLAUDE_CONFIG_DIR/projects/mock/<session-uuid>.jsonl — a user turn, an
#       assistant turn with a tool call, a tool result, then a closing
#       assistant turn with usage. The sidecar tails that file exactly as it
#       would a real one, so the events, the transcript rows, and the token
#       accounting are all real code paths.
#
#   (c) BUSY -> IDLE GATING WORKS. Each turn takes MOCK_TURN_SECONDS
#       (default 4) with the log deliberately quiet in the middle, which is
#       long enough for the sidecar's 1500ms idle window to matter. A second
#       prompt sent during a turn must queue rather than interleave.
#
# Usage (as AGENT_COMMAND):
#   AGENT_COMMAND="bash /opt/blackhouse/mock-agent-tui.sh"
#
# Env:
#   CLAUDE_CONFIG_DIR   where to write the session log (default $HOME/.claude)
#   MOCK_TURN_SECONDS   seconds of "thinking" per turn (default 4)
#   MOCK_SESSION_ID     fixed session uuid, if a test wants a predictable path
set -uo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PROJECT_DIR="$CONFIG_DIR/projects/mock"
TURN_SECONDS="${MOCK_TURN_SECONDS:-4}"

uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    # Good enough for a test fixture: 32 hex nibbles in uuid layout.
    od -xN16 /dev/urandom | head -1 | awk '{print $2$3"-"$4"-"$5"-"$6"-"$7$8$9}'
  fi
}

SESSION_ID="${MOCK_SESSION_ID:-$(uuid)}"
LOG="$PROJECT_DIR/$SESSION_ID.jsonl"

mkdir -p "$PROJECT_DIR"
: >"$LOG"

now() { date -u +"%Y-%m-%dT%H:%M:%S.000Z"; }

# jq does the JSON escaping. Hand-rolled escaping is how test fixtures start
# emitting invalid JSON the moment someone types a quote.
emit() {
  jq -c -n "$@" >>"$LOG"
}

echo "mock-agent-tui — session $SESSION_ID"
echo "session log: $LOG"
echo "ready. lines typed here (or injected onto this PTY) become turns."

TURN=0
while IFS= read -r LINE; do
  # Ignore blank lines the way a TUI ignores a bare Enter.
  if [ -z "${LINE//[[:space:]]/}" ]; then
    continue
  fi

  TURN=$((TURN + 1))

  # (a) Proof the bytes reached this process's stdin.
  echo "> $LINE"

  USER_UUID="$(uuid)"
  emit --arg t "$(now)" --arg u "$USER_UUID" --arg s "$SESSION_ID" --arg text "$LINE" \
    '{type:"user", uuid:$u, parentUuid:null, sessionId:$s, timestamp:$t, cwd:"/workspace",
      message:{role:"user", content:[{type:"text", text:$text}]}}'

  # Assistant opens the turn with a tool call. stop_reason "tool_use" means the
  # turn is NOT over — the sidecar must keep reporting busy here.
  TOOL_UUID="$(uuid)"
  TOOL_USE_ID="toolu_$(uuid | tr -d '-' | cut -c1-16)"
  emit --arg t "$(now)" --arg u "$TOOL_UUID" --arg s "$SESSION_ID" --arg tid "$TOOL_USE_ID" \
    '{type:"assistant", uuid:$u, sessionId:$s, timestamp:$t,
      message:{role:"assistant", model:"mock-1", stop_reason:"tool_use",
        content:[
          {type:"text", text:"Let me look at that."},
          {type:"tool_use", id:$tid, name:"Read",
           input:{file_path:"/workspace/README.md", limit:120}}
        ],
        usage:{input_tokens:120, output_tokens:18,
               cache_read_input_tokens:0, cache_creation_input_tokens:0}},
      costUSD:0.0004, durationMs:900}'

  # (c) The quiet middle. Long enough that the sidecar's idle window is a real
  # test rather than a race: the log does not move, but the last event was a
  # tool call, so "quiet" must NOT be read as "idle".
  sleep "$TURN_SECONDS"

  RESULT_UUID="$(uuid)"
  emit --arg t "$(now)" --arg u "$RESULT_UUID" --arg s "$SESSION_ID" --arg tid "$TOOL_USE_ID" \
    '{type:"user", uuid:$u, sessionId:$s, timestamp:$t,
      message:{role:"user", content:[
        {type:"tool_result", tool_use_id:$tid, is_error:false,
         content:"# Blackhouse\n\nA mock file, read by a mock agent.\n"}
      ]}}'

  REPLY="Handled turn $TURN: $LINE"
  FINAL_UUID="$(uuid)"
  emit --arg t "$(now)" --arg u "$FINAL_UUID" --arg s "$SESSION_ID" --arg text "$REPLY" \
    '{type:"assistant", uuid:$u, sessionId:$s, timestamp:$t,
      message:{role:"assistant", model:"mock-1", stop_reason:"end_turn",
        content:[{type:"text", text:$text}],
        usage:{input_tokens:340, output_tokens:64,
               cache_read_input_tokens:128, cache_creation_input_tokens:0}},
      costUSD:0.0021, durationMs:1400}'

  # And a record type the adapter has never heard of, every third turn — the
  # transcript must keep working, degrading that line to a `raw` event.
  if [ $((TURN % 3)) -eq 0 ]; then
    emit --arg t "$(now)" --arg u "$(uuid)" --arg s "$SESSION_ID" \
      '{type:"mock_future_record", uuid:$u, sessionId:$s, timestamp:$t,
        payload:{invented:true, note:"the adapter must not choke on this"}}'
  fi

  echo "$REPLY"
done

echo "mock-agent-tui: stdin closed after $TURN turn(s), exiting."
