import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { runMigrations } from "./db/migrate";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("/api/*", cors());

// API routes (will be added by server-agent)
app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

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
  serve({ fetch: app.fetch, port });
}

start();

export default app;
