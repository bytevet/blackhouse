import { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import WebSocket, { type RawData } from "ws";
import type { AuthEnv } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireSessionAccess, handleSessionAccessError } from "../lib/session.js";
import { getContainerHostPort } from "../lib/docker.js";
import { rawDataToArrayBuffer } from "../lib/ws-binary.js";

/**
 * IDE proxy mounted at `/api/sessions/:id/ide/*`.
 *
 * - Auth-gates every request via `authMiddleware` + `requireSessionAccess`.
 * - Strips the `/api/sessions/:id/ide` prefix and forwards to code-server on
 *   `http://127.0.0.1:<containerHostPort>/...`.
 * - HTTP: full fetch passthrough — preserves status, all headers (including
 *   `set-cookie`), and streams the body. Adds `Content-Security-Policy:
 *   frame-ancestors 'self'` so the SPA can iframe code-server but nothing
 *   else can.
 * - WebSocket: opens a server-side WS to the container, binary-pipes both
 *   directions. Single-peer per WS (code-server doesn't need broadcast).
 *
 * Mounted via `createIdeProxy(upgradeWebSocket)` from `server/index.ts`.
 */

const PREFIX_RE = /^\/api\/sessions\/[^/]+\/ide/;

// Headers we strip from the inbound request before forwarding to code-server.
// These are hop-by-hop or break the proxy when forwarded verbatim.
const STRIP_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "content-length", // fetch sets this from body
]);

// Hop-by-hop / fetch-managed response headers we drop before re-emitting.
const STRIP_RES_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding", // fetch already decoded the body
  "content-length", // recomputed by node-server
]);

export function createIdeProxy(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"],
) {
  const app = new Hono<AuthEnv>().onError(handleSessionAccessError);

  // Shared auth + ownership guard for everything under :id/ide.
  app.use("/api/sessions/:id/ide/*", authMiddleware, async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing session id" }, 400);
    await requireSessionAccess(id, c.get("session").user);
    await next();
  });

  // GET: branch between WS upgrade and HTTP proxy. code-server uses GET for
  // both its REST surface and the long-lived WS to the editor server.
  app.get(
    "/api/sessions/:id/ide/*",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id")!;
      const targetPath = c.req.path.replace(PREFIX_RE, "") || "/";
      const url = new URL(c.req.url);
      const search = url.search;

      let upstream: WebSocket | null = null;

      return {
        async onOpen(_evt, ws) {
          let port: number;
          try {
            port = await getContainerHostPort(sessionId, 8443);
          } catch (err) {
            try {
              ws.send(`[IDE unavailable: ${err instanceof Error ? err.message : String(err)}]`);
            } catch {
              /* peer gone */
            }
            ws.close(4002, "ide_unavailable");
            return;
          }

          const upstreamUrl = `ws://127.0.0.1:${port}${targetPath}${search}`;
          upstream = new WebSocket(upstreamUrl);

          upstream.on("message", (data: RawData) => {
            try {
              ws.send(rawDataToArrayBuffer(data));
            } catch {
              /* peer gone */
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
              ws.close(1011, `upstream_error: ${err.message}`);
            } catch {
              /* already closed */
            }
          });
        },

        onMessage(evt) {
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
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

  // All other methods: HTTP proxy.
  app.all("/api/sessions/:id/ide/*", async (c) => {
    const id = c.req.param("id");
    return await proxyHttp(c, id);
  });

  return app;
}

async function proxyHttp(c: import("hono").Context, sessionId: string) {
  let port: number;
  try {
    port = await getContainerHostPort(sessionId, 8443);
  } catch (err) {
    return c.json(
      { error: "ide_unavailable", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  const inUrl = new URL(c.req.url);
  const targetPath = inUrl.pathname.replace(PREFIX_RE, "") || "/";
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${inUrl.search}`;

  const forwardHeaders = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!STRIP_REQ_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });

  let body: BodyInit | undefined;
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    body = c.req.raw.body ?? undefined;
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
      // @ts-expect-error node fetch supports `duplex` for streaming bodies
      duplex: body ? "half" : undefined,
    });
  } catch (err) {
    return c.json(
      { error: "ide_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  // Mirror status + headers (minus hop-by-hop), add CSP frame-ancestors so
  // the SPA can iframe but other origins can't.
  const resHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RES_HEADERS.has(key.toLowerCase())) {
      resHeaders[key] = value;
    }
  });
  // Use append-style for set-cookie which the iterator above collapses.
  const setCookies = upstream.headers.getSetCookie?.() ?? [];

  const out = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
  for (const cookie of setCookies) {
    out.headers.append("set-cookie", cookie);
  }
  // CSP applies to HTML responses; safe to set on all and ignored by other
  // content-types. frame-ancestors blocks third-party iframing.
  out.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  return out;
}
