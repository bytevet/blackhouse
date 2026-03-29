import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/index.js";
import { codingSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

const app = new Hono();

const tokenBody = z.object({
  sessionId: z.string(),
  token: z.string(),
});

async function validateToken(sessionId: string, token: string) {
  try {
    const [session] = await db
      .select()
      .from(codingSessions)
      .where(eq(codingSessions.id, sessionId))
      .limit(1);
    if (!session) return { error: "Session not found" as const, status: 404 as const };
    if (!session.sessionToken || session.sessionToken !== token) {
      return { error: "Invalid token" as const, status: 403 as const };
    }
    return { session };
  } catch {
    return { error: "Session not found" as const, status: 404 as const };
  }
}

app.post("/result", zValidator("json", tokenBody.extend({ html: z.string() })), async (c) => {
  const { sessionId, token, html } = c.req.valid("json");
  const result = await validateToken(sessionId, token);
  if ("error" in result) return c.json({ error: result.error }, result.status);

  await db
    .update(codingSessions)
    .set({ resultHtml: html, updatedAt: new Date() })
    .where(eq(codingSessions.id, sessionId));

  return c.text("OK", 200);
});

app.post("/title", zValidator("json", tokenBody.extend({ title: z.string() })), async (c) => {
  const { sessionId, token, title } = c.req.valid("json");
  const result = await validateToken(sessionId, token);
  if ("error" in result) return c.json({ error: result.error }, result.status);

  await db
    .update(codingSessions)
    .set({ agentTitle: title, updatedAt: new Date() })
    .where(eq(codingSessions.id, sessionId));

  return c.text("OK", 200);
});

export default app;
