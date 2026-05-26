import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/index.js";
import { codingSessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { authSessionToken } from "../lib/session-token-auth.js";

const tokenBody = z.object({
  sessionId: z.string(),
  token: z.string(),
});

const app = new Hono()
  .post("/result", zValidator("json", tokenBody.extend({ html: z.string() })), async (c) => {
    const { sessionId, token, html } = c.req.valid("json");
    const result = await authSessionToken(sessionId, token);
    if ("error" in result) return c.json({ error: result.error }, result.status);

    await db
      .update(codingSessions)
      .set({ resultHtml: html, updatedAt: new Date() })
      .where(eq(codingSessions.id, sessionId));

    return c.text("OK", 200);
  })

  .post("/title", zValidator("json", tokenBody.extend({ title: z.string() })), async (c) => {
    const { sessionId, token, title } = c.req.valid("json");
    const result = await authSessionToken(sessionId, token);
    if ("error" in result) return c.json({ error: result.error }, result.status);

    await db
      .update(codingSessions)
      .set({ agentTitle: title, updatedAt: new Date() })
      .where(eq(codingSessions.id, sessionId));

    return c.text("OK", 200);
  });

export default app;
