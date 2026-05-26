import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { createNodeWebSocket } from "@hono/node-ws";
import WebSocket, { type RawData } from "ws";
import { validateSessionForContainer } from "../lib/session-auth.js";
import { getContainerEndpoint } from "../lib/docker.js";
import { dataToBuffer, rawDataToArrayBuffer } from "../lib/ws-binary.js";

/**
 * Browser WebSocket proxy.
 *
 * Client connects to `ws://server/api/browser-ws/:sessionId?token=<sess>`.
 * After auth, we open a server-side WS to the in-container browser-service
 * at `ws://127.0.0.1:<hostPort>/browser/ws` and pipe binary frames in both
 * directions: screencast (0x80/0x81/0x83–0x86) downstream and input events
 * + request opcodes (0x01–0x12) upstream. The proxy is a pure byte-pipe;
 * it never parses opcodes, JSON-decodes, or HTTP-forwards per event (that
 * was the cost in #58, eliminated by #61).
 *
 * Single-peer per WS — code-server and the screencast both deliver to one
 * viewer at a time. We do not replicate the multi-peer/scrollback complexity
 * of the terminal WS (no historical frames worth replaying).
 *
 * Open-time race: `onOpen` is async (auth + container port lookup + WS
 * handshake → 50–100 ms locally). Client frames arriving in that window
 * get queued in `earlyQueue` and flushed in order from the upstream
 * `"open"` listener — sub-100 ms post-mount sends (FE's first resize from
 * ResizeObserver) used to be silently dropped before this fix.
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
// Cap on bytes queued from the client while the upstream WS is still
// connecting (auth + container port lookup + handshake — typically 50–
// 100 ms locally). Client frames arriving in that window get held here
// and flushed on `upstream "open"`. Cap is byte-based, not count, because
// resize frames are small (~10 B) but a runaway client could buffer many.
// 16 KB easily covers the realistic burst: a flurry of resize + first
// navigate is ~50 B; the typical inflight set fits in well under 1 KB.
const EARLY_QUEUE_BYTES_CAP = 16 * 1024;

type ProxyFrame = string | Buffer;

// Preserves the text-vs-binary distinction so we send the right WS frame
// type upstream. Anything binary collapses through `dataToBuffer`.
function normalizeClientFrame(message: unknown): ProxyFrame | null {
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === "string") return message;
  return dataToBuffer(message);
}

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
      // Frames the client sent before the upstream WS finished its async
      // open dance (auth + port lookup + handshake). Flushed in receive
      // order from the `upstream "open"` listener below. Bounded by
      // `EARLY_QUEUE_BYTES_CAP` — excess frames get dropped with a single
      // warn log so a degenerate client can't grow this unboundedly.
      const earlyQueue: ProxyFrame[] = [];
      let earlyQueueBytes = 0;
      let earlyQueueDropped = false;

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

          let endpoint: Awaited<ReturnType<typeof getContainerEndpoint>>;
          try {
            endpoint = await getContainerEndpoint(sessionId, 9223);
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
          upstream = new WebSocket(`ws://${endpoint.host}:${endpoint.port}/browser/ws`, {
            perMessageDeflate: false,
          });

          // Flush any client frames that arrived during the open dance.
          // Order-preserving; respects upstream backpressure (anything past
          // the limit gets discarded the same way live frames do).
          upstream.on("open", () => {
            if (!upstream) return;
            for (const frame of earlyQueue) {
              if (upstream.bufferedAmount > UPSTREAM_BACKPRESSURE_LIMIT) break;
              upstream.send(frame);
            }
            earlyQueue.length = 0;
            earlyQueueBytes = 0;
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
                // Preserve the WS frame type — TEXT frames must round-trip
                // as TEXT (a pre-#61 encoder emitted JSON config preambles
                // this way). Post-#61 binary opcodes never take this branch.
                const buf = dataToBuffer(data);
                if (buf) ws.send(buf.toString("utf8"));
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

        // Client→server frames get piped straight through to the upstream
        // WS. If upstream isn't OPEN yet (still doing auth + port lookup +
        // handshake), queue the frame and flush in order from the upstream
        // "open" listener — otherwise sub-100 ms post-mount sends (FE's
        // first resize fires from ResizeObserver almost immediately after
        // viewer mount) would be silently dropped.
        onMessage(evt, _ws: WSContext) {
          const frame = normalizeClientFrame(evt.data);
          if (frame == null) return;

          if (!upstream || upstream.readyState !== WebSocket.OPEN) {
            const size =
              typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
            if (earlyQueueBytes + size > EARLY_QUEUE_BYTES_CAP) {
              if (!earlyQueueDropped) {
                console.warn(
                  `[browser-proxy] early queue cap exceeded (${earlyQueueBytes}+${size}B > ${EARLY_QUEUE_BYTES_CAP}B); dropping client frame`,
                );
                earlyQueueDropped = true;
              }
              return;
            }
            earlyQueue.push(frame);
            earlyQueueBytes += size;
            return;
          }

          if (upstream.bufferedAmount > UPSTREAM_BACKPRESSURE_LIMIT) return;
          upstream.send(frame);
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
