import { createServerFn } from "@tanstack/react-start";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, and, or, desc } from "drizzle-orm";
import { requireSession } from "@/lib/auth-server";

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

export const listTemplates = createServerFn({ method: "GET" })
  .inputValidator((input: { mine?: boolean }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

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
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

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
  .inputValidator((input: {
      name: string;
      description?: string;
      systemPrompt?: string;
      skills?: unknown;
      mcpConfig?: unknown;
      isPublic?: boolean;
    }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

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
      })
      .returning();

    return inserted[0];
  });

// ---------------------------------------------------------------------------
// updateTemplate
// ---------------------------------------------------------------------------

export const updateTemplate = createServerFn({ method: "POST" })
  .inputValidator((input: {
      id: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      skills?: unknown;
      mcpConfig?: unknown;
      isPublic?: boolean;
    }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

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
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

    const rows = await db
      .select()
      .from(schema.templates)
      .where(eq(schema.templates.id, data.id))
      .limit(1);

    if (rows.length === 0) throw new Error("Template not found");

    if (rows[0].userId !== session.user.id) {
      throw new Error("Forbidden");
    }

    await db
      .delete(schema.templates)
      .where(eq(schema.templates.id, data.id));

    return { success: true };
  });
