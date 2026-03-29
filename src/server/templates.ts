import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/server/middleware";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, and, or, desc } from "drizzle-orm";

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

export const listTemplates = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ mine: z.boolean().optional() }))

  .handler(async ({ data, context }) => {
    const session = context.session;

    if (data.mine) {
      return db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.userId, session.user.id))
        .orderBy(desc(schema.templates.createdAt));
    }

    // Public templates (visible to everyone)
    return db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.isPublic, true))
      .orderBy(desc(schema.templates.createdAt));
  });

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

export const getTemplate = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))

  .handler(async ({ data, context }) => {
    const session = context.session;

    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, data.id))
      .limit(1);

    if (rows.length === 0) throw new Error("Template not found");

    const template = rows[0];

    if (template.userId !== session.user.id && !template.isPublic) {
      throw new Error("Forbidden");
    }

    return template;
  });

// ---------------------------------------------------------------------------
// createTemplate
// ---------------------------------------------------------------------------

export const createTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      systemPrompt: z.string().optional(),
      skills: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
      mcpConfig: z.record(z.string(), z.unknown()).nullable().optional(),
      isPublic: z.boolean().optional(),
      gitRequired: z.boolean().optional(),
    }),
  )

  .handler(async ({ data, context }) => {
    const session = context.session;

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

    return inserted[0];
  });

// ---------------------------------------------------------------------------
// updateTemplate
// ---------------------------------------------------------------------------

export const updateTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      systemPrompt: z.string().optional(),
      skills: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
      mcpConfig: z.record(z.string(), z.unknown()).nullable().optional(),
      isPublic: z.boolean().optional(),
      gitRequired: z.boolean().optional(),
    }),
  )

  .handler(async ({ data, context }) => {
    const session = context.session;

    // Ownership check
    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, data.id))
      .limit(1);

    if (rows.length === 0) throw new Error("Template not found");

    if (rows[0].userId !== session.user.id) {
      throw new Error("Forbidden");
    }

    const { id, ...fields } = data;
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (fields.name !== undefined) updateData.name = fields.name;
    if (fields.description !== undefined) updateData.description = fields.description;
    if (fields.systemPrompt !== undefined) updateData.systemPrompt = fields.systemPrompt;
    if (fields.skills !== undefined) updateData.skills = fields.skills;
    if (fields.mcpConfig !== undefined) updateData.mcpConfig = fields.mcpConfig;
    if (fields.isPublic !== undefined) updateData.isPublic = fields.isPublic;
    if (fields.gitRequired !== undefined) updateData.gitRequired = fields.gitRequired;

    const updated = await db
      .update(schema.templates)
      .set(updateData)
      .where(eq(schema.templates.id, id))
      .returning();

    return updated[0];
  });

// ---------------------------------------------------------------------------
// deleteTemplate
// ---------------------------------------------------------------------------

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const session = context.session;

    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, data.id))
      .limit(1);

    if (rows.length === 0) throw new Error("Template not found");

    if (rows[0].userId !== session.user.id) {
      throw new Error("Forbidden");
    }

    await db.delete(schema.templates).where(eq(schema.templates.id, data.id));

    return { success: true };
  });
