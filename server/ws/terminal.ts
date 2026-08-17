import { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { validateAgentForContainer } from "../lib/agent-ws-auth.js";
import { dataToBuffer } from "../lib/ws-binary.js";
import type { PtyHub, PtyPeer } from "../agents/pty-hub.js";
import { ensurePtyHubConfigured } from "../agents/pty-config.js";

/**
 * Terminal WebSocket route — a thin subscriber over `PtyHub`.
 *
 * The PTY itself (attach stream, scrollback, broadcast, write mutex) lives in
 * `server/agents/pty-hub.ts` so the injector can share it. This file only
 * speaks the binary protocol and authorizes peers:
 *
 *   0x00  terminal data (both directions)
 *   0x01  resize, payload "cols:rows" (client → server)
 *   0x02  system notice, JSON payload (server → client, e.g. injecting…)
 */

/**
 * The hub is configured at server startup (`ensurePtyHubConfigured`), because
 * the injector needs it whether or not anyone has opened a terminal. This call
 * is idempotent and only guards against the route being mounted standalone in
 * a test.
 */
function terminalHub(): PtyHub {
  return ensurePtyHubConfigured();
}

/**
 * Create the terminal WebSocket route.
 * Requires the upgradeWebSocket helper from @hono/node-ws.
 */
export function createTerminalRoute(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
) {
  const app = new Hono();

  app.get(
    "/:agentId",
    upgradeWebSocket((c) => {
      const agentId = c.req.param("agentId")!;
      const token = c.req.query("token");

      return {
        async onOpen(_evt, ws) {
          const result = await validateAgentForContainer(agentId, token);
          if (!result) {
            ws.send("[Auth failed or agent not running]");
            ws.close(4001, "Unauthorized");
            return;
          }

          try {
            const pty = terminalHub();
            await pty.ensureAttached(agentId);
            // Replays scrollback to this peer, then subscribes it.
            pty.addPeer(agentId, ws as PtyPeer);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Failed to create terminal";
            ws.send(`[Error: ${msg}]`);
            ws.close(4002, msg);
          }
        },

        async onMessage(evt) {
          const pty = terminalHub();
          if (!pty.isAttached(agentId)) return;

          const raw = dataToBuffer(evt.data);
          if (!raw || raw.length === 0) return;

          const type = raw[0];
          const payload = raw.subarray(1);

          switch (type) {
            case 0x00: {
              // Terminal input -> container stdin, serialized against the
              // injector and buffered if an injection is in flight.
              await pty.write(agentId, payload, { source: "peer" });
              break;
            }
            case 0x01: {
              // Resize command -> payload is "cols:rows"
              const parts = payload.toString("utf-8").split(":");
              if (parts.length === 2) {
                await pty.resize(agentId, parseInt(parts[0], 10), parseInt(parts[1], 10));
              }
              break;
            }
            default:
              // Unknown type prefix - drop silently
              break;
          }
        },

        onClose(_evt, ws) {
          terminalHub().removePeer(agentId, ws as PtyPeer);
        },
      };
    }),
  );

  return app;
}
