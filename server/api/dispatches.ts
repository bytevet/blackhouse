import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authMiddleware, type AuthEnv } from "../middleware/auth.js";
import { approveDispatch, denyDispatch } from "../agents/dispatch.js";

const app = new Hono<AuthEnv>()

  .get("/", authMiddleware, async (c) => {
    const status = c.req.query("status");
    const rows = await db
      .select()
      .from(schema.dispatchRequests)
      .where(
        status && ["pending", "approved", "denied", "expired"].includes(status)
          ? eq(schema.dispatchRequests.status, status as (typeof schema.DISPATCH_STATUSES)[number])
          : undefined,
      )
      .orderBy(desc(schema.dispatchRequests.createdAt))
      .limit(100);
    return c.json(rows);
  })

  /**
   * Approve, optionally rewriting the prompt first.
   *
   * The edited text is stored in `approvedPrompt` beside the agent's original
   * rather than replacing it — "edit & approve" must leave a record of what
   * was actually asked for versus what was allowed through.
   */
  .post("/:id/approve", authMiddleware, async (c) => {
    const parsed = z
      .object({ prompt: z.string().max(20_000).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid input" }, 400);

    const result = await approveDispatch(
      c.req.param("id")!,
      c.get("session").user.id,
      parsed.data.prompt,
    );
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ ok: true, runId: result.runId });
  })

  .post("/:id/deny", authMiddleware, async (c) => {
    const result = await denyDispatch(c.req.param("id")!, c.get("session").user.id);
    if (!result.ok) return c.json({ error: result.error }, 409);
    return c.json({ ok: true });
  });

export default app;
