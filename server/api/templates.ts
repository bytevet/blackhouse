import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, desc, count } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { paginationQuery } from "../lib/pagination.js";

const app = new Hono<AuthEnv>()
  // ---------------------------------------------------------------------------
  // GET /api/templates — list templates
  // ---------------------------------------------------------------------------
  .get(
    "/",
    authMiddleware,
    zValidator(
      "query",
      z
        .object({
          mine: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
        })
        .merge(paginationQuery)
        .optional(),
    ),
    async (c) => {
      const session = c.get("session");
      const query = c.req.valid("query");
      const page = query?.page ?? 1;
      const perPage = query?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      if (query?.mine) {
        const [{ total }] = await db
          .select({ total: count() })
          .from(schema.templates)
          .where(eq(schema.templates.userId, session.user.id));

        const rows = await db
          .select()
          .from(schema.templates)
          .where(eq(schema.templates.userId, session.user.id))
          .orderBy(desc(schema.templates.createdAt))
          .limit(perPage)
          .offset(offset);

        return c.json({ data: rows, total, page, perPage });
      }

      // Public templates (visible to everyone)
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.templates)
        .where(eq(schema.templates.isPublic, true));

      const rows = await db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.isPublic, true))
        .orderBy(desc(schema.templates.createdAt))
        .limit(perPage)
        .offset(offset);

      return c.json({ data: rows, total, page, perPage });
    },
  )

  // ---------------------------------------------------------------------------
  // GET /api/templates/:id
  // ---------------------------------------------------------------------------
  .get("/:id", authMiddleware, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");

    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, id))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);

    const template = rows[0];

    if (template.userId !== session.user.id && !template.isPublic) {
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.json(template);
  })

  // ---------------------------------------------------------------------------
  // POST /api/templates — create template
  // ---------------------------------------------------------------------------
  .post(
    "/",
    authMiddleware,
    zValidator(
      "json",
      z.object({
        name: z.string(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
        mcpConfig: z.record(z.string(), z.unknown()).nullable().optional(),
        isPublic: z.boolean().optional(),
        gitRequired: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const session = c.get("session");
      const data = c.req.valid("json");

      const inserted = await db
        .insert(schema.templates)
        .values({
          userId: session.user.id,
          name: data.name,
          description: data.description ?? null,
          systemPrompt: data.systemPrompt ?? null,
          skills: data.skills ?? null,
          mcpConfig: data.mcpConfig ?? null,
          isPublic: data.isPublic ?? false,
          gitRequired: data.gitRequired ?? false,
        })
        .returning();

      return c.json(inserted[0], 201);
    },
  )

  // ---------------------------------------------------------------------------
  // PUT /api/templates/:id — update template
  // ---------------------------------------------------------------------------
  .put(
    "/:id",
    authMiddleware,
    zValidator(
      "json",
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
        mcpConfig: z.record(z.string(), z.unknown()).nullable().optional(),
        isPublic: z.boolean().optional(),
        gitRequired: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const session = c.get("session");
      const id = c.req.param("id");
      const data = c.req.valid("json");

      // Ownership check
      const rows = await db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.id, id))
        .limit(1);

      if (rows.length === 0) return c.json({ error: "Template not found" }, 404);

      if (rows[0].userId !== session.user.id) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };

      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.systemPrompt !== undefined) updateData.systemPrompt = data.systemPrompt;
      if (data.skills !== undefined) updateData.skills = data.skills;
      if (data.mcpConfig !== undefined) updateData.mcpConfig = data.mcpConfig;
      if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
      if (data.gitRequired !== undefined) updateData.gitRequired = data.gitRequired;

      const updated = await db
        .update(schema.templates)
        .set(updateData)
        .where(eq(schema.templates.id, id))
        .returning();

      return c.json(updated[0]);
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /api/templates/:id
  // ---------------------------------------------------------------------------
  .delete("/:id", authMiddleware, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");

    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, id))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Template not found" }, 404);

    if (rows[0].userId !== session.user.id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await db.delete(schema.templates).where(eq(schema.templates.id, id));

    return c.json({ success: true });
  });

export default app;
