#!/bin/bash

# 0) Symlink auth files from config volumes (named volumes can't target single files)
# Claude Code: ~/.claude.json stored in a separate volume directory
if [ -d "$HOME/.config/claude-auth" ]; then
  # If auth file exists in volume, symlink it to where Claude expects it
  if [ -f "$HOME/.config/claude-auth/.claude.json" ]; then
    ln -sf "$HOME/.config/claude-auth/.claude.json" "$HOME/.claude.json"
  fi
  # After Claude authenticates, copy the file into the volume for persistence
  trap 'if [ -f "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then cp "$HOME/.claude.json" "$HOME/.config/claude-auth/.claude.json"; fi' EXIT
fi

# 1) Git clone (shallow, only if URL provided and not already cloned)
if [ -n "$GIT_REPO_URL" ]; then
  REPO_DIR="/workspace/$(basename "$GIT_REPO_URL" .git)"
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "[blackhouse] Cloning $GIT_REPO_URL (branch: ${GIT_BRANCH:-main})..."
    git clone --depth=1 --branch "${GIT_BRANCH:-main}" "$GIT_REPO_URL" "$REPO_DIR" 2>&1 ||
      git clone --depth=1 "$GIT_REPO_URL" "$REPO_DIR" 2>&1
  fi
  cd "$REPO_DIR" || true
fi

# 2a) Start the in-container browser service in the background — opt-in.
# Listens on 127.0.0.1:9223. The Blackhouse server proxies its screencast WS
# and REST control endpoints to the React Browser tab. If this exits the
# Browser tab shows "unavailable" — the agent keeps working.
#
# node + Playwright + Chromium is the heaviest resident thing in this container
# and most agents never open the Browser tab, so it starts only when the server
# asks for it. Anything other than an explicit 1 — including the variable being
# absent — means off. That direction matters: an older server that has never
# heard of this variable then produces a light container instead of the heavy
# one that drove a 2-CPU host to load 27 and stopped it answering the Docker
# API. Failing safe here means failing light.
if [ "$BLACKHOUSE_ENABLE_BROWSER" = "1" ]; then
  if [ -f /opt/blackhouse/browser-service/service.mjs ]; then
    echo "[blackhouse] Starting browser service (BLACKHOUSE_ENABLE_BROWSER=1)."
    mkdir -p "$HOME/.cache"
    (
      cd /opt/blackhouse/browser-service && node service.mjs >>"$HOME/.cache/browser-service.log" 2>&1
    ) &
    BROWSER_SERVICE_PID=$!
    export BROWSER_SERVICE_PID
  else
    # Asked for, but not built into this image — say so, because from the SPA
    # this is indistinguishable from the service having crashed.
    echo "[blackhouse] BLACKHOUSE_ENABLE_BROWSER=1 but no browser service in this image; Browser tab unavailable." >&2
  fi
else
  echo "[blackhouse] Browser service not started: BLACKHOUSE_ENABLE_BROWSER is '${BLACKHOUSE_ENABLE_BROWSER:-unset}', not 1. Browser tab unavailable."
fi

# 2b) Start code-server in the background — opt-in. Listens on 127.0.0.1:8443;
# the Blackhouse server proxies it to the IDE tab in the SPA. Auth-disabled
# because the proxy is the only path in and is itself auth-gated.
#
# A whole VS Code server resident behind a tab nobody opened is the other half
# of the footprint described in 2a, and it is gated the same way and for the
# same reason: only an explicit 1 starts it.
if [ "$BLACKHOUSE_ENABLE_IDE" != "1" ]; then
  echo "[blackhouse] code-server not started: BLACKHOUSE_ENABLE_IDE is '${BLACKHOUSE_ENABLE_IDE:-unset}', not 1. IDE tab unavailable."
elif ! command -v code-server >/dev/null 2>&1; then
  # Asked for, but not installed in this image. Same reasoning as 2a: without
  # this line an absent IDE tab is a support question rather than a log entry.
  echo "[blackhouse] BLACKHOUSE_ENABLE_IDE=1 but code-server is not installed in this image; IDE tab unavailable." >&2
else
  echo "[blackhouse] Starting code-server (BLACKHOUSE_ENABLE_IDE=1)."
  mkdir -p "$HOME/.cache"
  # Seed the user settings if a baseline file is shipped in the image (#33).
  # `cp -n` (no-clobber) means an existing user-mounted settings.json wins
  # — that's the upgrade path when we add per-user settings later.
  if [ -f /opt/blackhouse/code-server-config/settings.json ]; then
    mkdir -p "$HOME/.local/share/code-server/User"
    cp -n /opt/blackhouse/code-server-config/settings.json \
      "$HOME/.local/share/code-server/User/settings.json" 2>/dev/null || true
  fi
  # Bind to 0.0.0.0 inside the container so Podman/Docker port mapping
  # (`HostConfig.PortBindings`) can forward host traffic to us — services on
  # the container's loopback aren't reachable via the bridge interface.
  # External exposure is constrained by `HostIp: "127.0.0.1"` on the host
  # side, which only opens the port to the Blackhouse proxy on localhost.
  #
  # `--disable-workspace-trust` bypasses VS Code's "do you trust the authors
  # of this folder" prompt. Every workspace here is /workspace inside a
  # Blackhouse-managed container — the trust gate adds no security here and
  # blocks editor UX until clicked.
  code-server \
    --auth none \
    --bind-addr 0.0.0.0:8443 \
    --disable-telemetry \
    --disable-update-check \
    --disable-workspace-trust \
    /workspace >>"$HOME/.cache/code-server.log" 2>&1 &
  CODE_SERVER_PID=$!
  export CODE_SERVER_PID
fi

# 2c) Fetch-on-boot sidecar override.
#
# The sidecar is baked into the image at /opt/blackhouse/sidecar, but the
# images are ~3GB each and there are three of them, so rebuilding all of them
# to change one line of the JSONL adapter is an unacceptable iteration cost.
# The server serves a tarball of agent/sidecar/; if we can reach it we prefer
# that copy, and if we can't we silently keep the baked-in one. A container
# with no network still starts a working sidecar.
#
# Note this is the same trick the skills install below uses, and it has the
# same trust model: the tarball comes from the Blackhouse server, which is
# already the thing holding this container's auth token.
#
# Expected layout: the contents of agent/sidecar/ at the tarball root, so
# index.mjs sits at the top level. Anything else is treated as a bad download
# and discarded — the check below is what makes a truncated or wrongly-rooted
# tarball harmless instead of fatal.
SIDECAR_DIR=/opt/blackhouse/sidecar
if [ -n "$BLACKHOUSE_URL" ]; then
  mkdir -p "$HOME/.cache"
  SIDECAR_OVERRIDE="$HOME/.cache/blackhouse-sidecar-src"
  if curl -fsS --max-time 15 "$BLACKHOUSE_URL/.well-known/blackhouse/sidecar.tar" \
    -o "$HOME/.cache/sidecar.tar" 2>/dev/null; then
    rm -rf "$SIDECAR_OVERRIDE"
    mkdir -p "$SIDECAR_OVERRIDE"
    if tar -xf "$HOME/.cache/sidecar.tar" -C "$SIDECAR_OVERRIDE" 2>/dev/null &&
      [ -f "$SIDECAR_OVERRIDE/index.mjs" ]; then
      echo "[blackhouse] Using sidecar override fetched from $BLACKHOUSE_URL"
      SIDECAR_DIR="$SIDECAR_OVERRIDE"
    else
      # A truncated or unexpected tarball must not take out the baked-in copy.
      rm -rf "$SIDECAR_OVERRIDE"
    fi
    rm -f "$HOME/.cache/sidecar.tar"
  fi
fi

# 2d) Start the sidecar. It tails the agent CLI's structured session log and
# POSTs events to the server, which renders them as the channel transcript.
# Detached background process, same idiom as 2a / 2b: if it dies the agent is
# unaffected, the channel just stops updating. Adapters that don't exist for a
# given CLI make it exit 0 immediately — those agents inherit the server-side
# PTY scraper instead, which needs nothing in here.
if [ -f "$SIDECAR_DIR/index.mjs" ] && [ -n "$AGENT_ID" ] && [ -n "$AGENT_TOKEN" ]; then
  mkdir -p "$HOME/.cache"
  (
    cd "$SIDECAR_DIR" && node index.mjs >>"$HOME/.cache/sidecar.log" 2>&1
  ) &
  SIDECAR_PID=$!
  export SIDECAR_PID
fi

# 2) Install Blackhouse skills from the server.
#
# Nothing here may block starting the agent. This used to run
# `npx -y skills add "$BLACKHOUSE_URL"` with no timeout and stderr discarded,
# which hung the entrypoint outright: `npx -y` fetches a package from
# registry.npmjs.org, and an agent under gVisor cannot resolve it — Docker's
# embedded DNS is unreachable from a runsc sandbox, so only the names pinned
# into /etc/hosts resolve. The container sat at "Installing skills…" forever,
# never reached the `exec` below, and presented as an agent that started and did
# nothing. With stderr silenced there was no way to see why.
#
# So: the harness first, because `$BLACKHOUSE_URL` is one of the pinned names
# and is therefore the one host an agent can always reach. `npx` is attempted
# only afterwards, only if the direct fetch failed, and under a hard timeout.
# Both paths keep their output — a skills install that quietly did nothing is
# how this stayed invisible.
# Fetch every file the harness lists, not just the documentation.
#
# This used to pull `SKILL.md` alone and then report "Skills installed". SKILL.md
# is the file that *describes* `post.sh`, `mention.sh`, `submit-result.sh` and
# the rest — so the agent read a manual for seven scripts that were never
# downloaded. Observed on the deployment: an agent finished a report and said it
# "couldn't submit this as a channel card" because the scripts named in its own
# instructions did not exist. Posting back to a channel is the product; it had
# been silently impossible, behind a success message.
#
# The file list comes from the harness index rather than being repeated here,
# for the same reason the index is now read off disk: a third copy of the list
# is a third thing to drift.
fetch_skill_files() {
  index=$(curl -sf --max-time 15 "$BLACKHOUSE_URL/.well-known/agent-skills/index.json") || return 1
  [ -n "$index" ] || return 1

  # Minimal JSON walk: emit "<skill> <file>" per line. Tracks the current skill
  # name and whether it is inside that skill's "files" array, so it does not
  # confuse a skill's `name`/`description` strings for file names.
  pairs=$(printf '%s' "$index" | tr -d '\n' | awk '
    { gsub(/[{}]/, "\n&\n"); print }
  ' | awk '
    /"name"[[:space:]]*:/ {
      line = $0
      sub(/.*"name"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*/, "", line)
      skill = line
    }
    /"files"[[:space:]]*:/ {
      line = $0
      sub(/.*"files"[[:space:]]*:[[:space:]]*\[/, "", line)
      sub(/\].*/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) {
        f = parts[i]
        gsub(/[^A-Za-z0-9._-]/, "", f)
        if (f != "" && skill != "") print skill " " f
      }
    }
  ')
  [ -n "$pairs" ] || return 1

  got=0
  printf '%s\n' "$pairs" | while read -r skill file; do
    [ -n "$skill" ] && [ -n "$file" ] || continue
    dest="$HOME/.claude/skills/$skill"
    mkdir -p "$dest"
    if curl -sf --max-time 15 \
        "$BLACKHOUSE_URL/.well-known/agent-skills/$skill/$file" -o "$dest/$file"; then
      # The scripts are invoked directly by the agent, so they have to be
      # runnable. Checking out a repo preserves the mode bit; an HTTP body has
      # no mode to preserve.
      case "$file" in *.sh) chmod +x "$dest/$file" ;; esac
    else
      echo "[blackhouse] WARNING: skill file $skill/$file could not be fetched" >&2
    fi
  done

  # The subshell above cannot set `got`, so count what actually landed.
  count=$(find "$HOME/.claude/skills" -type f -name '*.sh' 2>/dev/null | wc -l | tr -d ' ')
  [ "${count:-0}" -gt 0 ]
}

install_skills() {
  mkdir -p "$HOME/.claude/skills/blackhouse"
  if fetch_skill_files; then
    echo "[blackhouse] Skills installed from $BLACKHOUSE_URL"
    return 0
  fi
  echo "[blackhouse] WARNING: skill index fetch failed or yielded no scripts" >&2

  if command -v npx >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    echo "[blackhouse] Direct skills fetch failed; trying npx (60s cap)..."
    if timeout 60 npx -y skills add "$BLACKHOUSE_URL" --yes --global; then
      echo "[blackhouse] Skills installed via npx"
      return 0
    fi
  fi

  # Not fatal. An agent without the skill scripts can still be mentioned, run,
  # and be watched — it just cannot post back on its own initiative.
  echo "[blackhouse] WARNING: could not install skills; continuing without them" >&2
  return 0
}

if [ -n "$AGENT_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  echo "[blackhouse] Installing skills from $BLACKHOUSE_URL..."
  install_skills
fi

# 3) Hand the PTY to the agent CLI — and to nothing else.
#
# THIS `exec` IS LOAD-BEARING. This script used to end in `exec /bin/bash`.
#
# The product's core feature is that a channel mention is typed onto this
# container's PTY. Whatever process owns the PTY receives it. When the agent
# CLI was run as a child and the script then fell through to a login shell,
# everything still *looked* fine — the terminal tab worked, the container
# stayed up — but the moment the CLI exited (a crash, a `/exit`, an OOM kill)
# the thing reading injected prompts became bash. A mention would then run as
# a shell command, silently, with the agent's credentials. Nobody would see an
# error; the transcript would simply stop and the container would keep
# accepting input.
#
# So: the agent CLI *is* PID 1's payload. Container-exit means agent-exit,
# which the server already observes and reports as the agent stopping. The
# only way to get a shell here is to ask for one explicitly, which is a
# debugging affordance and not a fallback.
if [ -n "$AGENT_COMMAND" ]; then
  # The system prompt goes to a FILE, not to stdin.
  #
  # It used to be fed in as a heredoc (`eval "$AGENT_COMMAND" <<< "$SYSTEM_PROMPT"`),
  # which replaces stdin with a temp file — and stdin is precisely the channel
  # mentions are written to. A CLI started that way can never receive an
  # injected prompt. Blueprints reference the file from AGENT_COMMAND instead,
  # e.g. `claude --append-system-prompt "$(cat "$BLACKHOUSE_SYSTEM_PROMPT_FILE")"`.
  #
  # THE FILE IS ALWAYS CREATED, empty if the server sent nothing. It used to be
  # written only when $SYSTEM_PROMPT was non-empty, which left the variable
  # unset — and a blueprint containing `$(cat "$BLACKHOUSE_SYSTEM_PROMPT_FILE")`
  # then expands to `$(cat "")`, `cat` fails, and the `exec` below hands the PTY
  # to a command line missing an argument. The container dies with no CLI in it
  # at all: the same class of failure the refusal at the bottom of this file
  # exists to prevent, arrived at by a different road.
  mkdir -p "$HOME/.cache"
  BLACKHOUSE_SYSTEM_PROMPT_FILE="$HOME/.cache/system-prompt.txt"
  printf '%s\n' "$SYSTEM_PROMPT" >"$BLACKHOUSE_SYSTEM_PROMPT_FILE"
  export BLACKHOUSE_SYSTEM_PROMPT_FILE

  # 3a) Deliver that file to the CLI. Only one of the three takes it on the
  # command line; the others read a fixed path in their config directory.
  #
  # Those config directories sit inside the per-agent STATE VOLUME, which
  # survives restart, so every copy below is unconditional — `cp`, never
  # `cp -n`. A no-clobber copy would mean an operator edits the prompt, restarts
  # the agent, and is silently outlived by the copy written on first boot.
  case "$BLACKHOUSE_ADAPTER" in
  claude-code)
    # `--append-system-prompt <prompt>` is real: verified against the installed
    # @anthropic-ai/claude-code's own `--help`. "Append" is the point — the
    # harness facts are added to Claude Code's default system prompt rather
    # than replacing it.
    #
    # This is a FALLBACK for blueprints written before the flag existed, and it
    # is why changing `server/db/seed.ts` alone would have fixed nothing: seed
    # inserts blueprints only into an empty table, so every install that has
    # ever booted keeps `claude --dangerously-skip-permissions` forever. The
    # `contains` guard is what makes the two mechanisms safe side by side — a
    # command that already names the file (the new seed default, or an
    # operator's own edit) is left exactly as written, so the flag can never be
    # applied twice.
    case "$AGENT_COMMAND" in
    *BLACKHOUSE_SYSTEM_PROMPT_FILE*) ;;
    *)
      AGENT_COMMAND="$AGENT_COMMAND --append-system-prompt \"\$(cat \"\$BLACKHOUSE_SYSTEM_PROMPT_FILE\")\""
      echo "[blackhouse] AGENT_COMMAND predates the system prompt; appending --append-system-prompt."
      ;;
    esac
    ;;
  codex)
    # Codex exposes no system-prompt flag, so the prompt is delivered as its
    # user-global instructions file. `$HOME/.codex/AGENTS.md` is the path a
    # Codex install creates for itself; that it is loaded into every session is
    # (unverified) here, in the same sense as the timings in
    # `server/agents/adapters/profiles.ts`.
    mkdir -p "$HOME/.codex"
    cp "$BLACKHOUSE_SYSTEM_PROMPT_FILE" "$HOME/.codex/AGENTS.md" ||
      echo "[blackhouse] WARNING: could not write \$HOME/.codex/AGENTS.md; agent starts without the harness prompt." >&2
    ;;
  antigravity)
    # Same shape. `agy --help` lists no system-prompt flag (verified), and the
    # CLI inherits Gemini's config layout — its global context file is
    # `$HOME/.gemini/GEMINI.md`. (unverified: the binary carries the string but
    # we have not watched it load the global copy.)
    mkdir -p "$HOME/.gemini"
    cp "$BLACKHOUSE_SYSTEM_PROMPT_FILE" "$HOME/.gemini/GEMINI.md" ||
      echo "[blackhouse] WARNING: could not write \$HOME/.gemini/GEMINI.md; agent starts without the harness prompt." >&2
    ;;
  *)
    # `custom`, or an adapter newer than this image. Guessing another CLI's
    # flags is how you get an `exec` that fails on an unknown option, so we do
    # not: the file is written and exported above, and a custom blueprint can
    # reference it from AGENT_COMMAND like the claude-code default does.
    echo "[blackhouse] Adapter '${BLACKHOUSE_ADAPTER:-unset}' has no known system-prompt mechanism;" \
      "the prompt is in \$BLACKHOUSE_SYSTEM_PROMPT_FILE for AGENT_COMMAND to use."
    ;;
  esac

  echo "[blackhouse] Starting agent: $AGENT_COMMAND"
  # `bash -c "exec ..."` rather than bare `exec $AGENT_COMMAND`: AGENT_COMMAND
  # is a command *line* and needs shell parsing for quoting, `$VAR`, and the
  # `$(cat ...)` above — but the inner `exec` guarantees the CLI still replaces
  # the shell rather than running under it. Nothing after this line is
  # reachable, which is the entire point.
  exec bash -c "exec $AGENT_COMMAND"
fi

# 4) No agent command configured. That is a misconfiguration, not a mode.
if [ "$BLACKHOUSE_DEBUG_SHELL" = "1" ]; then
  echo "[blackhouse] BLACKHOUSE_DEBUG_SHELL=1 — dropping to a shell."
  echo "[blackhouse] Prompts injected into this PTY will run as SHELL COMMANDS."
  exec /bin/bash
fi

echo "[blackhouse] No AGENT_COMMAND set and BLACKHOUSE_DEBUG_SHELL is not 1." >&2
echo "[blackhouse] Refusing to hand this PTY to a shell — an injected mention" >&2
echo "[blackhouse] would execute as a shell command. Set AGENT_COMMAND on the" >&2
echo "[blackhouse] blueprint, or set BLACKHOUSE_DEBUG_SHELL=1 to debug." >&2
exit 1
