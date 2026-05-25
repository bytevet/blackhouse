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
    git clone --depth=1 --branch "${GIT_BRANCH:-main}" "$GIT_REPO_URL" "$REPO_DIR" 2>&1 || \
    git clone --depth=1 "$GIT_REPO_URL" "$REPO_DIR" 2>&1
  fi
  cd "$REPO_DIR"
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

# 2) Install Blackhouse skills via `npx skills add` from the server
if [ -n "$SESSION_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  if command -v npx &> /dev/null; then
    echo "[blackhouse] Installing skills from $BLACKHOUSE_URL..."
    npx -y skills add "$BLACKHOUSE_URL" --yes --global 2>/dev/null || true
  else
    # Fallback: fetch SKILL.md directly
    mkdir -p "$HOME/.claude/skills/blackhouse"
    curl -sf "$BLACKHOUSE_URL/.well-known/agent-skills/blackhouse/SKILL.md" \
      -o "$HOME/.claude/skills/blackhouse/SKILL.md" 2>/dev/null || true
  fi

fi

# 3) Run agent command interactively (if set)
if [ -n "$AGENT_COMMAND" ]; then
  echo "[blackhouse] Starting agent: $AGENT_COMMAND"
  if [ -n "$SYSTEM_PROMPT" ]; then
    # Pipe system prompt as initial input to the agent
    eval "$AGENT_COMMAND" <<< "$SYSTEM_PROMPT" || true
  else
    eval "$AGENT_COMMAND" || true
  fi
  echo "[blackhouse] Agent exited. Dropping to shell."
fi

# 4) Drop to bash shell after agent exits
exec /bin/bash
