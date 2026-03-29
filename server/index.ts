import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { runMigrations } from "./db/migrate.js";

// API route modules
import authRoutes from "./api/auth.js";
import sessionsRoutes from "./api/sessions.js";
import templatesRoutes from "./api/templates.js";
import settingsRoutes from "./api/settings.js";
import filesRoutes from "./api/files.js";
import resultRoutes from "./api/result.js";
import skillsRoutes from "./api/skills.js";
import { createTerminalRoute } from "./ws/terminal.js";

const app = new Hono();

// WebSocket setup (must be before routes that use it)
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// API routes
app.route("/api/auth", authRoutes);
app.route("/api/container", resultRoutes);
app.route("/api/sessions", sessionsRoutes);
app.route("/api/templates", templatesRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/files", filesRoutes);
app.route("/.well-known/agent-skills", skillsRoutes);

// WebSocket terminal
app.route("/api/terminal", createTerminalRoute(upgradeWebSocket));

// Serve SPA static files in production
app.use("/*", serveStatic({ root: "./dist/client" }));
// SPA fallback — serve index.html for all non-API routes
app.get("/*", serveStatic({ root: "./dist/client", path: "index.html" }));

async function start() {
  console.log("[blackhouse] Running database migrations...");
  await runMigrations();
  console.log("[blackhouse] Migrations complete.");

  const port = Number(process.env.PORT || 3000);
  console.log(`[blackhouse] Server running on http://localhost:${port}`);
  const server = serve({ fetch: app.fetch, port });

  // Inject WebSocket handler into the HTTP server
  injectWebSocket(server);
}

start();

export default app;
