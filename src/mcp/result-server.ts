#!/usr/bin/env node
/**
 * MCP Result Server — injected into coding session containers.
 * Exposes a `submit_result` tool that posts HTML back to the Blackhouse API.
 *
 * Usage: BLACKHOUSE_URL=http://host:3000 SESSION_ID=xxx CONTAINER_TOKEN=yyy node result-server.js
 *
 * This file is compiled separately and copied into session container images.
 */

import { createInterface } from "node:readline";

const BLACKHOUSE_URL = process.env.BLACKHOUSE_URL ?? "http://host.docker.internal:3000";
const SESSION_ID = process.env.SESSION_ID ?? "";
const CONTAINER_TOKEN = process.env.CONTAINER_TOKEN ?? "";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function send(response: object) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function handleRequest(req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "blackhouse-result", version: "1.0.0" },
        },
      });
      break;

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "submit_result",
              description:
                "Display rich HTML content to the user in the Blackhouse session viewer. " +
                "Use this tool whenever you want to show the user something visual — " +
                "dashboards, charts, reports, tables, documentation, diagrams, previews, " +
                "or any formatted output that benefits from rich rendering. " +
                "The HTML will be rendered in a sandboxed iframe in the user's browser. " +
                "You SHOULD proactively use this tool to present results, summaries, " +
                "and visual artifacts rather than only outputting plain text. " +
                "The content must be a single self-contained HTML file (inline CSS/JS, no external resources).",
              inputSchema: {
                type: "object",
                properties: {
                  html: {
                    type: "string",
                    description:
                      "A complete, self-contained HTML document. Include all CSS and JS inline. " +
                      "Use modern HTML5. For charts, use inline SVG or a CDN like Chart.js/D3 via <script> tag. " +
                      "For styling, prefer clean minimal design with system fonts. " +
                      "Example: '<html><body><h1>Results</h1><table>...</table></body></html>'",
                  },
                },
                required: ["html"],
              },
            },
          ],
        },
      });
      break;

    case "tools/call": {
      const toolName = (req.params as { name: string })?.name;
      const args = (req.params as { arguments: Record<string, string> })?.arguments;

      if (toolName === "submit_result" && args?.html) {
        submitResult(args.html)
          .then(() => {
            send({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                content: [{ type: "text", text: "Result submitted successfully." }],
              },
            });
          })
          .catch((err: Error) => {
            send({
              jsonrpc: "2.0",
              id: req.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Failed to submit result: ${err.message}`,
                  },
                ],
                isError: true,
              },
            });
          });
      } else {
        send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
      }
      break;
    }

    case "notifications/initialized":
      // ignore
      break;

    default:
      send({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
  }
}

async function submitResult(html: string) {
  const response = await fetch(`${BLACKHOUSE_URL}/api/sessions/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      html,
      token: CONTAINER_TOKEN,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

// Read JSON-RPC from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const req = JSON.parse(line) as JsonRpcRequest;
    handleRequest(req);
  } catch {
    // ignore parse errors
  }
});
