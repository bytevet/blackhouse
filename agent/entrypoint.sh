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

# 2) Install Blackhouse MCP server (provides submit_result + update_title tools)
if [ -n "$SESSION_ID" ] && [ -n "$BLACKHOUSE_URL" ]; then
  mkdir -p /opt/blackhouse
  cat > /opt/blackhouse/mcp-server.mjs << 'MCPSERVER'
import { createInterface } from "node:readline";

const BLACKHOUSE_URL = process.env.BLACKHOUSE_URL ?? "http://host.docker.internal:3000";
const SESSION_ID = process.env.SESSION_ID ?? "";
const CONTAINER_TOKEN = process.env.CONTAINER_TOKEN ?? "";

function send(r) { process.stdout.write(JSON.stringify(r) + "\n"); }

async function callApi(path, body) {
  const res = await fetch(`${BLACKHOUSE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

function handle(req) {
  switch (req.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: req.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "blackhouse", version: "1.0.0" },
      }});
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: req.id, result: { tools: [
        {
          name: "submit_result",
          description: "Display rich HTML content to the user in the Blackhouse session viewer. Use this to show dashboards, charts, reports, tables, previews, or any formatted output. The HTML is rendered in a sandboxed iframe. Proactively use this for visual results.",
          inputSchema: { type: "object", properties: { html: { type: "string", description: "A complete, self-contained HTML document with inline CSS/JS." } }, required: ["html"] },
        },
        {
          name: "update_title",
          description: "Update the session title to show what you are currently working on. Displayed next to the session name in the UI. Call this when you start a new task or reach a milestone.",
          inputSchema: { type: "object", properties: { title: { type: "string", description: "Short status text (~50 chars max), e.g. 'implementing auth', 'running tests'" } }, required: ["title"] },
        },
      ]}});
      break;
    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (name === "submit_result" && args.html) {
        callApi("/api/sessions/result", { sessionId: SESSION_ID, html: args.html, token: CONTAINER_TOKEN })
          .then(() => send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Result submitted." }] } }))
          .catch(e => send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true } }));
      } else if (name === "update_title" && args.title) {
        callApi("/api/sessions/title", { sessionId: SESSION_ID, title: args.title, token: CONTAINER_TOKEN })
          .then(() => send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Title updated: ${args.title}` }] } }))
          .catch(e => send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true } }));
      } else {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      }
      break;
    }
    case "notifications/initialized": break;
    default:
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", line => { try { handle(JSON.parse(line)); } catch {} });
MCPSERVER

  # Install Blackhouse skills from the server's .well-known endpoint
  # Falls back to inline SKILL.md if npx skills is unavailable
  if command -v npx &> /dev/null; then
    echo "[blackhouse] Installing skills from $BLACKHOUSE_URL..."
    npx -y skills add "$BLACKHOUSE_URL" --global 2>/dev/null || true
  else
    # Fallback: write SKILL.md directly
    mkdir -p "$HOME/.claude/skills/blackhouse"
    curl -sf "$BLACKHOUSE_URL/.well-known/agent-skills/blackhouse/SKILL.md" \
      -o "$HOME/.claude/skills/blackhouse/SKILL.md" 2>/dev/null || true
  fi

  # Configure Claude Code: permissions + MCP server registration
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
  },
  "mcpServers": {
    "blackhouse": {
      "command": "node",
      "args": ["/opt/blackhouse/mcp-server.mjs"]
    }
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
