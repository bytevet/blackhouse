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

# 2a) Start the in-container browser service in the background.
# Listens on 127.0.0.1:9223. The Blackhouse server proxies its screencast WS
# and REST control endpoints to the React Browser tab. If this exits the
# Browser tab shows "unavailable" — the agent keeps working.
if [ -f /opt/blackhouse/browser-service/service.mjs ]; then
  mkdir -p "$HOME/.cache"
  (
    cd /opt/blackhouse/browser-service && node service.mjs >>"$HOME/.cache/browser-service.log" 2>&1
  ) &
  BROWSER_SERVICE_PID=$!
  export BROWSER_SERVICE_PID
fi

# 2b) Start code-server in the background. Listens on 127.0.0.1:8443; the
# Blackhouse server proxies it to the IDE tab in the SPA. Auth-disabled
# because the proxy is the only path in and is itself auth-gated.
if command -v code-server >/dev/null 2>&1; then
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

# 2) Install Blackhouse skills via `npx skills add` from the server
if [ -n "$AGENT_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  if command -v npx >/dev/null 2>&1; then
    echo "[blackhouse] Installing skills from $BLACKHOUSE_URL..."
    npx -y skills add "$BLACKHOUSE_URL" --yes --global 2>/dev/null || true
  else
    # Fallback: fetch SKILL.md directly
    mkdir -p "$HOME/.claude/skills/blackhouse"
    curl -sf "$BLACKHOUSE_URL/.well-known/agent-skills/blackhouse/SKILL.md" \
      -o "$HOME/.claude/skills/blackhouse/SKILL.md" 2>/dev/null || true
  fi
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
  mkdir -p "$HOME/.cache"
  if [ -n "$SYSTEM_PROMPT" ]; then
    BLACKHOUSE_SYSTEM_PROMPT_FILE="$HOME/.cache/system-prompt.txt"
    printf '%s\n' "$SYSTEM_PROMPT" >"$BLACKHOUSE_SYSTEM_PROMPT_FILE"
    export BLACKHOUSE_SYSTEM_PROMPT_FILE
  fi

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
