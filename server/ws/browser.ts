import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { createNodeWebSocket } from "@hono/node-ws";
import WebSocket, { type RawData } from "ws";
import { validateSessionForContainer } from "../lib/session-auth.js";
import { getContainerHostPort } from "../lib/docker.js";
import { rawDataToArrayBuffer } from "../lib/ws-binary.js";

/**
 * Browser WebSocket proxy.
 *
 * Client connects to `ws://server/api/browser-ws/:sessionId?token=<sess>`.
 * After auth, we open a server-side WS to the in-container browser-service
 * at `ws://127.0.0.1:<hostPort>/browser/ws` and binary-pipe both directions.
 *
 * Single-peer per WS — code-server and the screencast both deliver to one
 * viewer at a time. We do not replicate the multi-peer/scrollback complexity
 * of the terminal WS (no historical frames worth replaying).
 */
export function createBrowserWsRoute(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
) {
  const app = new Hono();

  app.get(
    "/:sessionId",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("sessionId")!;
      const token = c.req.query("token");

      let upstream: WebSocket | null = null;

      return {
        async onOpen(_evt, ws) {
          const auth = await validateSessionForContainer(sessionId, token);
          if (!auth) {
            try {
              ws.send("[Auth failed or session not running]");
            } catch {
              /* peer gone */
            }
            ws.close(4001, "Unauthorized");
            return;
          }

          let port: number;
          try {
            port = await getContainerHostPort(sessionId, 9223);
          } catch (err) {
            try {
              ws.send(`[Browser unavailable: ${err instanceof Error ? err.message : String(err)}]`);
            } catch {
              /* peer gone */
            }
            ws.close(4002, "browser_unavailable");
            return;
          }

          upstream = new WebSocket(`ws://127.0.0.1:${port}/browser/ws`);

          upstream.on("open", () => {
            // Connection live; nothing else to do — frames flow inbound.
          });

          upstream.on("message", (data: RawData, isBinary: boolean) => {
            try {
              // Preserve the WS frame type: H.264 NAL units are sent as
              // binary, but the encoder also emits a JSON `config` message
              // (codec metadata for VideoDecoder.configure) as a TEXT frame.
              // Converting everything to binary breaks the decoder.
              if (isBinary) {
                ws.send(rawDataToArrayBuffer(data));
              } else {
                const buf = Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data);
                ws.send(buf.toString("utf8"));
              }
            } catch {
              // peer closed mid-frame; will be cleaned up by close handler
            }
          });

          upstream.on("close", (code: number, reason: Buffer) => {
            try {
              ws.close(code || 1000, reason?.toString() || "upstream_closed");
            } catch {
              /* already closed */
            }
          });

          upstream.on("error", (err: Error) => {
            try {
              ws.send(`[Upstream error: ${err.message}]`);
            } catch {
              /* peer gone */
            }
            try {
              ws.close(1011, "upstream_error");
            } catch {
              /* already closed */
            }
          });
        },

        onMessage(evt, _ws: WSContext) {
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
          const message: unknown = evt.data;
          // Forward bytes to upstream as-is. Browser-service mainly receives
          // input via REST; this is here for completeness and future use.
          if (typeof message === "string") {
            upstream.send(message);
          } else if (Buffer.isBuffer(message)) {
            upstream.send(message);
          } else if (message instanceof ArrayBuffer) {
            upstream.send(Buffer.from(message));
          } else if (message instanceof Uint8Array) {
            upstream.send(Buffer.from(message.buffer, message.byteOffset, message.byteLength));
          }
        },

        onClose() {
          if (upstream) {
            try {
              upstream.close();
            } catch {
              /* already closed */
            }
            upstream = null;
          }
        },
      };
    }),
  );

  return app;
}
