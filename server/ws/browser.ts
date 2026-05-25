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
 * frames downstream + text-pipe input events upstream.
 *
 * The browser-service WS itself accepts text frames shaped
 * `{type:"input", input:{...}}` and dispatches them to CDP — so the proxy
 * is a pure byte-pipe in both directions and never has to parse, JSON-decode,
 * or HTTP-forward per event (was the cost in #58).
 *
 * Single-peer per WS — code-server and the screencast both deliver to one
 * viewer at a time. We do not replicate the multi-peer/scrollback complexity
 * of the terminal WS (no historical frames worth replaying).
 */

// Drop input frames if the upstream socket is already this far behind.
// 64 KB is comfortably above any single input payload (input JSON is
// ~50–100 B per event); reaching the cap means the upstream encoder /
// browser-service can't keep up with the client. Better to lose the
// stale event than to grow an unbounded queue.
const UPSTREAM_BACKPRESSURE_LIMIT = 64 * 1024;
// Larger threshold downstream — a single H.264 keyframe is ~50 KB, and we
// don't want to drop them prematurely. But if the client falls 2 MB
// behind, skip the next chunk; it'll resync on the next keyframe.
const CLIENT_BACKPRESSURE_LIMIT = 2 * 1024 * 1024;

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

          let upstreamPort: number;
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

          // `perMessageDeflate: false` — H.264 is already entropy-coded;
          // permessage-deflate just burns CPU re-compressing it and adds
          // latency on every frame. Bilateral negotiation means the
          // browser-service WS server doesn't need its own opt-out.
          upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}/browser/ws`, {
            perMessageDeflate: false,
          });

          upstream.on("message", (data: RawData, isBinary: boolean) => {
            try {
              if (isBinary) {
                // Drop video frames if the client can't keep up. The stream
                // self-resyncs at the next keyframe (#59 item 6 — 2 s GOP),
                // so a few dropped P-frames are recoverable; an unbounded
                // ws.send queue is not. hono/ws's WSContext doesn't expose
                // bufferedAmount directly, but `.raw` is the underlying
                // `ws` WebSocket which does.
                const raw = ws.raw as WebSocket | undefined;
                if (raw && raw.bufferedAmount > CLIENT_BACKPRESSURE_LIMIT) return;
                ws.send(rawDataToArrayBuffer(data));
              } else {
                // Preserve the WS frame type: encoder emits a JSON `config`
                // message (codec metadata for VideoDecoder.configure) as a
                // TEXT frame. Converting it to binary breaks the decoder.
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

        // Client→server frames (text JSON input envelopes) get piped
        // straight through to the upstream WS. browser-service parses
        // them in-process and dispatches to CDP — no localhost HTTP
        // round-trip per event.
        onMessage(evt, _ws: WSContext) {
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
          if (upstream.bufferedAmount > UPSTREAM_BACKPRESSURE_LIMIT) return;
          const message: unknown = evt.data;
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
