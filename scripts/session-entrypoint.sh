#!/bin/bash
set -e

# Clone git repo if provided
if [ -n "$GIT_REPO_URL" ]; then
  BRANCH="${GIT_BRANCH:-main}"
  REPO_DIR="/workspace/$(basename "$GIT_REPO_URL" .git)"

  echo "[blackhouse] Cloning $GIT_REPO_URL (branch: $BRANCH)..."
  git clone --branch "$BRANCH" "$GIT_REPO_URL" "$REPO_DIR" 2>&1 || {
    echo "[blackhouse] Clone failed, trying without branch..."
    git clone "$GIT_REPO_URL" "$REPO_DIR" 2>&1
  }
  cd "$REPO_DIR"
fi

# Configure MCP result server for the coding agent
if [ -n "$SESSION_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  mkdir -p /root/.claude

  # Create Claude Code MCP config
  cat > /root/.claude/settings.json << EOF
{
  "mcpServers": {
    "blackhouse-result": {
      "command": "node",
      "args": ["/opt/blackhouse/result-server.js"],
      "env": {
        "SESSION_ID": "$SESSION_ID",
        "CONTAINER_TOKEN": "$CONTAINER_TOKEN",
        "BLACKHOUSE_URL": "$BLACKHOUSE_URL"
      }
    }
  }
}
EOF
fi

# Start the coding agent if configured
if [ -n "$AGENT_COMMAND" ]; then
  echo "[blackhouse] Starting agent: $AGENT_COMMAND"
  eval "$AGENT_COMMAND" &
fi

# Execute the CMD
exec "$@"
