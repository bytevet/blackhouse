import { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { getDockerClient } from "../lib/docker.js";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { validateAgentForContainer } from "../lib/agent-ws-auth.js";
import { dataToBuffer } from "../lib/ws-binary.js";
import { configurePtyHub, type PtyDocker, type PtyHub, type PtyPeer } from "../agents/pty-hub.js";

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

let hub: PtyHub | null = null;

/**
 * Wire the process-wide hub against the `agents` table.
 * `resolveContainer` is the only coupling point: the hub itself knows nothing
 * about agents, sessions, or Docker lookups.
 */
function terminalHub(): PtyHub {
  if (hub) return hub;
  hub = configurePtyHub({
    resolveContainer: (agentId) => validateAgentForContainer(agentId),
    getDocker: async () => (await getDockerClient()) as unknown as PtyDocker,
    onDetached: async (agentId) => {
      // Attach stream ended → the container's main process exited.
      await db
        .update(agents)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    },
  });
  return hub;
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
