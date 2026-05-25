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
 * at `ws://127.0.0.1:<hostPort>/browser/ws` and binary-pipe screencast
 * frames to the client.
 *
 * For input events the client sends text JSON `{type:"input", input:{...}}`
 * on the same WS; we forward those as fire-and-forget POSTs to the
 * browser-service's `/browser/input` endpoint. This collapses what was
 * ~300 HTTP round-trips per scroll into 0 — see #58.
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
      // Hoisted so `onMessage` can reuse the port lookup from `onOpen`
      // instead of calling `getContainerHostPort` on every input event.
      let upstreamPort: number | null = null;
      // Serial chain: input events must reach the page in the order the
      // user produced them (a `mouseMove` before its `mouseDown` is a
      // hover, not a drag). Each handler awaits the previous before
      // issuing its localhost POST.
      let inputChain: Promise<unknown> = Promise.resolve();

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

          try {
            upstreamPort = await getContainerHostPort(sessionId, 9223);
          } catch (err) {
            try {
              ws.send(`[Browser unavailable: ${err instanceof Error ? err.message : String(err)}]`);
            } catch {
              /* peer gone */
            }
            ws.close(4002, "browser_unavailable");
            return;
          }

          upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}/browser/ws`);

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
          // Only text frames are meaningful client→server today: a JSON
          // `{type:"input", input:{...}}` envelope that we forward to the
          // in-container browser-service's REST `/browser/input` endpoint.
          // Binary frames have no protocol meaning yet and are dropped.
          const message: unknown = evt.data;
          if (typeof message !== "string") return;
          if (upstreamPort == null) return; // onOpen hasn't completed
          let parsed: unknown;
          try {
            parsed = JSON.parse(message);
          } catch {
            return;
          }
          if (
            !parsed ||
            typeof parsed !== "object" ||
            (parsed as { type?: unknown }).type !== "input"
          ) {
            return;
          }
          const input = (parsed as { input?: unknown }).input;
          if (!input || typeof input !== "object") return;
          const port = upstreamPort;
          inputChain = inputChain.then(() =>
            fetch(`http://127.0.0.1:${port}/browser/input`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(input),
            }).catch(() => {
              // Fire-and-forget; nothing the client could do about a
              // failed input event anyway. The browser-service's own
              // logging will surface real problems.
            }),
          );
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
