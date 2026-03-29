import { Hono } from "hono";
import { db } from "../db/index.js";
import { codingSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

const app = new Hono();

// ---------------------------------------------------------------------------
// POST /api/sessions/result — submit HTML result (token auth, not cookie)
// ---------------------------------------------------------------------------

app.post("/result", async (c) => {
  const body = (await c.req.json()) as {
    sessionId: string;
    html: string;
    token: string;
  };

  if (!body.sessionId || !body.html || !body.token) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const [session] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, body.sessionId))
    .limit(1);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (!session.sessionToken || session.sessionToken !== body.token) {
    return c.json({ error: "Invalid token" }, 403);
  }

  await db
    .update(codingSessions)
    .set({ resultHtml: body.html, updatedAt: new Date() })
    .where(eq(codingSessions.id, body.sessionId));

  return c.text("OK", 200);
});

// ---------------------------------------------------------------------------
// POST /api/sessions/title — update session title (token auth, not cookie)
// ---------------------------------------------------------------------------

app.post("/title", async (c) => {
  const body = (await c.req.json()) as {
    sessionId: string;
    title: string;
    token: string;
  };

  if (!body.sessionId || !body.title || !body.token) {
    return c.json({ error: "Missing fields" }, 400);
  }

  const [session] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, body.sessionId))
    .limit(1);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  if (!session.sessionToken || session.sessionToken !== body.token) {
    return c.json({ error: "Invalid token" }, 403);
  }

  await db
    .update(codingSessions)
    .set({ agentTitle: body.title, updatedAt: new Date() })
    .where(eq(codingSessions.id, body.sessionId));

  return c.text("OK", 200);
});

export default app;
