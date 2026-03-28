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

# 2) Install Blackhouse skill for result submission (works across all agents)
if [ -n "$SESSION_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  # Create skill config that any agent can discover
  mkdir -p "$HOME/.skills"
  cat > "$HOME/.skills/blackhouse-result.json" << EOF
{
  "name": "blackhouse-result",
  "description": "Display rich HTML content to the user in the Blackhouse session viewer. Use this to show dashboards, charts, reports, tables, previews, or any formatted output. Proactively use this for visual results instead of plain text.",
  "endpoint": "${BLACKHOUSE_URL}/api/sessions/result",
  "session_id": "${SESSION_ID}",
  "container_token": "${CONTAINER_TOKEN}"
}
EOF

  # Also configure Claude Code MCP if this is a Claude session
  if command -v claude &> /dev/null; then
    mkdir -p "$HOME/.claude"
    cat > "$HOME/.claude/settings.json" << MCPEOF
{
  "permissions": {
    "allow": [
      "Bash(curl:*)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(node:*)",
      "Bash(npx:*)",
      "Bash(python*:*)",
      "Bash(pip*:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(find:*)",
      "Bash(grep:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
      "Bash(rm:*)",
      "Bash(chmod:*)",
      "Bash(echo:*)",
      "Bash(touch:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(sort:*)",
      "Bash(sed:*)",
      "Bash(awk:*)",
      "Bash(tar:*)",
      "Bash(unzip:*)",
      "Bash(wget:*)"
    ]
  }
}
MCPEOF
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
