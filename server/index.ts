import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { runMigrations } from "./db/migrate.js";
import { runSeed } from "./db/seed.js";
import { startBackgroundJobs } from "./lib/scheduler.js";
import { ensurePtyHubConfigured } from "./agents/pty-config.js";
import { detectRuntimes } from "./sandbox/registry.js";

// API route modules
import authRoutes from "./api/auth.js";
import agentsRoutes from "./api/agents.js";
import channelsRoutes from "./api/channels.js";
import streamRoutes from "./api/stream.js";
import agentRuntimeRoutes from "./api/agent-runtime.js";
import dispatchRoutes from "./api/dispatches.js";
import egressRoutes from "./api/egress.js";
import settingsRoutes from "./api/settings.js";
import skillsRoutes from "./api/skills.js";
import sidecarDistRoutes from "./api/sidecar-dist.js";
import { createTerminalRoute } from "./ws/terminal.js";
import { createBrowserWsRoute } from "./ws/browser.js";
import { createIdeProxy } from "./proxy/ide.js";

const app = new Hono();

// WebSocket setup (must be before routes that use it)
const nodeWs = createNodeWebSocket({ app });
const { injectWebSocket, upgradeWebSocket } = nodeWs;

// Disable permessage-deflate globally on the WS server. The browser
// screencast WS carries already-entropy-coded H.264 chunks where
// compression is pure CPU overhead; terminal and IDE WS carry tiny
// amounts of text where the absolute bandwidth saved is negligible. The
// net win is significant CPU reduction in the H.264 hot path. (#59 item 3.)
// `@hono/node-ws` doesn't expose this knob directly; mutating the
// internal `wss.options` works because the `ws` package reads it at
// handshake time.

nodeWs.wss.options.perMessageDeflate = false;

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// Public config (no auth required)
app.get("/api/config", (c) =>
  c.json({
    githubOAuth: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  }),
);

// API routes (chained for RPC type inference)
const routes = app
  .route("/api/auth", authRoutes)
  .route("/api/agents", agentsRoutes)
  .route("/api/channels", channelsRoutes)
  .route("/api/stream", streamRoutes)
  .route("/api/agent-runtime", agentRuntimeRoutes)
  .route("/api/dispatches", dispatchRoutes)
  .route("/api/egress", egressRoutes)
  .route("/api/settings", settingsRoutes)
  .route("/.well-known/agent-skills", skillsRoutes)
  .route("/.well-known/blackhouse", sidecarDistRoutes);

// WebSocket terminal
app.route("/api/terminal", createTerminalRoute(upgradeWebSocket));

// WebSocket browser screencast proxy (binary JPEG frames from container)
app.route("/api/browser-ws", createBrowserWsRoute(upgradeWebSocket));

// IDE proxy — HTTP + WS for code-server inside the agent container.
// Mounted at /api/agents/:id/ide/* (the sub-app sees that path verbatim).
app.route("/", createIdeProxy(upgradeWebSocket));

// Serve SPA static files in production
app.use("/*", serveStatic({ root: "./dist/client" }));

/**
 * SPA fallback — but only for navigations.
 *
 * A build renames every chunk, so a tab left open across a deploy asks for an
 * asset that no longer exists. Falling through to `index.html` answered those
 * with `200 text/html`, and a browser will not execute HTML as a module: the
 * chunk never resolves and the page hangs on a request that looked like it
 * succeeded. A 404 is both true and diagnosable — the tab reloads instead of
 * waiting.
 *
 * The test is a file extension in the last path segment. Routes in this app are
 * slugs, handles and uuids; anything ending in `.js`, `.css`, `.woff2` or the
 * like was meant to be a file, and if it is not on disk it is gone.
 */
app.get("/*", async (c, next) => {
  const last = new URL(c.req.url).pathname.split("/").pop() ?? "";
  if (/\.[a-z0-9]+$/i.test(last)) return c.notFound();
  return next();
});
app.get("/*", serveStatic({ root: "./dist/client", path: "index.html" }));

async function start() {
  console.log("[blackhouse] Running database migrations...");
  await runMigrations();
  console.log("[blackhouse] Migrations complete.");
  console.log("[blackhouse] Running seed...");
  await runSeed();
  console.log("[blackhouse] Seed complete.");

  // Probe once at boot so the UI can show what this host actually supports.
  // Non-fatal: a Docker daemon that is not reachable yet must not stop the
  // server from serving the settings page that explains why.
  const runtimes = await detectRuntimes().catch(() => null);
  if (runtimes) {
    console.log(
      `[blackhouse] container runtimes: ${runtimes.runtimes.join(", ") || "(none reported)"}`,
    );
  } else {
    console.warn("[blackhouse] could not probe container runtimes — is the Docker socket mounted?");
  }

  // Before any request can arrive: a mention routed to an agent injects onto
  // its PTY, and that path must not depend on a terminal having been opened.
  ensurePtyHubConfigured();

  startBackgroundJobs();

  const port = Number(process.env.PORT || 3000);

  console.log(`[blackhouse] Server running on http://localhost:${port}`);
  const server = serve({ fetch: app.fetch, port });
  // Inject WebSocket handler into the HTTP server
  injectWebSocket(server);
}

start();

export default app;
export type AppType = typeof routes;
