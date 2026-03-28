import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/server/middleware";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getDockerClient } from "@/lib/docker";

function generateEntrypoint(opts: {
  gitRepoUrl?: string | null;
  gitBranch?: string | null;
  systemPrompt?: string | null;
  agentType: string;
}): string {
  const lines: string[] = ["#!/bin/sh", "set -e"];

  if (opts.gitRepoUrl) {
    const branch = opts.gitBranch ?? "main";
    lines.push(`git clone --branch "${branch}" "${opts.gitRepoUrl}" /workspace`);
    lines.push("cd /workspace");
  } else {
    lines.push("mkdir -p /workspace && cd /workspace");
  }

  if (opts.systemPrompt) {
    // Write the system prompt as a config file the agent can read
    lines.push(`cat > /workspace/.agent-prompt <<'AGENT_PROMPT_EOF'`);
    lines.push(opts.systemPrompt);
    lines.push("AGENT_PROMPT_EOF");
  }

  // Keep container alive so users can attach / the agent runs
  lines.push("exec tail -f /dev/null");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

export const listSessions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ all: z.boolean().optional() }).optional())
  .handler(async ({ data, context }) => {
    const session = context.session;

    if (data?.all && session.user.role === "admin") {
      const rows = await db
        .select({
          session: schema.codingSessions,
          userName: schema.user.name,
          userEmail: schema.user.email,
        })
        .from(schema.codingSessions)
        .leftJoin(schema.user, eq(schema.codingSessions.userId, schema.user.id))
        .orderBy(desc(schema.codingSessions.createdAt));

      return rows.map((r) => ({
        ...r.session,
        user: { name: r.userName, email: r.userEmail },
      }));
    }

    return db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.userId, session.user.id))
      .orderBy(desc(schema.codingSessions.createdAt));
  });

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

export const getSession = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const session = context.session;
    const [codingSession] = await db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, data.id))
      .limit(1);
    if (!codingSession) throw new Error("Session not found");
    if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
      throw new Error("Forbidden");
    }
    return codingSession;
  });

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export const createSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      name: z.string(),
      gitRepoUrl: z.string().optional(),
      gitBranch: z.string().optional(),
      templateId: z.string().optional(),
      agentType: z.string().optional(),
      agentConfigId: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = context.session;

    // Look up agent config for docker image & keys
    let agentConfigRows;
    if (data.agentConfigId) {
      agentConfigRows = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.id, data.agentConfigId))
        .limit(1);
    } else if (data.agentType) {
      agentConfigRows = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.agentType, data.agentType))
        .limit(1);
    } else {
      throw new Error("Either agentType or agentConfigId is required");
    }

    if (agentConfigRows.length === 0) {
      throw new Error(`Unknown agent: ${data.agentConfigId ?? data.agentType}`);
    }

    const agentConfig = agentConfigRows[0];

    if (agentConfig.imageBuildStatus !== "built") {
      throw new Error(`Agent "${agentConfig.displayName}" does not have a built Docker image`);
    }

    const imageName = `blackhouse-agent-${agentConfig.agentType}:latest`;

    // If template requested, load it
    let template: typeof schema.templates.$inferSelect | null = null;
    if (data.templateId) {
      const templates = await db
        .select()
        .from(schema.templates)
        .where(eq(schema.templates.id, data.templateId))
        .limit(1);

      if (templates.length === 0) {
        throw new Error("Template not found");
      }

      template = templates[0];
    }

    const inserted = await db
      .insert(schema.codingSessions)
      .values({
        userId: session.user.id,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl ?? null,
        gitBranch: data.gitBranch ?? "main",
        templateId: data.templateId ?? null,
        agentType: agentConfig.agentType,
        containerImage: imageName,
        status: "pending",
      })
      .returning();

    const codingSession = inserted[0];

    // Build environment variables for the container
    const env: string[] = [
      `SESSION_ID=${codingSession.id}`,
      `AGENT_TYPE=${agentConfig.agentType}`,
      `SESSION_NAME=${data.name}`,
    ];

    if (agentConfig.apiKeyEncrypted) {
      env.push(`AGENT_API_KEY=${agentConfig.apiKeyEncrypted}`);
    }
    if (agentConfig.defaultModel) {
      env.push(`AGENT_MODEL=${agentConfig.defaultModel}`);
    }
    const yoloMode = template?.yoloMode ?? true;
    if (yoloMode) {
      env.push("AGENT_YOLO=1");
    }
    if (agentConfig.extraArgs) {
      env.push(`AGENT_EXTRA_ARGS=${JSON.stringify(agentConfig.extraArgs)}`);
    }

    // Build entrypoint script
    const entrypoint = generateEntrypoint({
      gitRepoUrl: data.gitRepoUrl,
      gitBranch: data.gitBranch,
      systemPrompt: template?.systemPrompt,
      agentType: agentConfig.agentType,
    });

    try {
      const docker = await getDockerClient();

      const container = await docker.createContainer({
        Image: imageName,
        Env: env,
        Cmd: ["/bin/sh", "-c", entrypoint],
        Labels: {
          "blackhouse.session_id": codingSession.id,
          "blackhouse.user_id": session.user.id,
          "blackhouse.managed": "true",
        },
        HostConfig: {
          // Reasonable defaults for coding containers
          Memory: 2 * 1024 * 1024 * 1024, // 2GB
          NanoCpus: 2_000_000_000, // 2 CPUs
        },
      });

      await container.start();

      const updated = await db
        .update(schema.codingSessions)
        .set({
          containerId: container.id,
          status: "running",
          updatedAt: new Date(),
        })
        .where(eq(schema.codingSessions.id, codingSession.id))
        .returning();

      return updated[0];
    } catch (err) {
      // If container creation fails, mark session as stopped
      await db
        .update(schema.codingSessions)
        .set({
          status: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(schema.codingSessions.id, codingSession.id));

      throw new Error(
        `Failed to create container: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

// ---------------------------------------------------------------------------
// stopSession
// ---------------------------------------------------------------------------

export const stopSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const session = context.session;
    const [codingSession] = await db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, data.id))
      .limit(1);
    if (!codingSession) throw new Error("Session not found");
    if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
      throw new Error("Forbidden");
    }

    if (!codingSession.containerId) {
      throw new Error("No container associated with this session");
    }

    try {
      const docker = await getDockerClient();
      const container = docker.getContainer(codingSession.containerId);
      await container.stop({ t: 10 });
    } catch (err) {
      // Container may already be stopped
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("is not running") && !message.includes("304")) {
        throw new Error(`Failed to stop container: ${message}`);
      }
    }

    const updated = await db
      .update(schema.codingSessions)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, data.id))
      .returning();

    return updated[0];
  });

// ---------------------------------------------------------------------------
// destroySession
// ---------------------------------------------------------------------------

export const destroySession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const session = context.session;
    const [codingSession] = await db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, data.id))
      .limit(1);
    if (!codingSession) throw new Error("Session not found");
    if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
      throw new Error("Forbidden");
    }

    if (codingSession.containerId) {
      try {
        const docker = await getDockerClient();
        const container = docker.getContainer(codingSession.containerId);
        await container.remove({ force: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("No such container") && !message.includes("404")) {
          throw new Error(`Failed to remove container: ${message}`);
        }
      }
    }

    await db.delete(schema.codingSessions).where(eq(schema.codingSessions.id, data.id));

    return { success: true };
  });

// ---------------------------------------------------------------------------
// restartSession
// ---------------------------------------------------------------------------

export const restartSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data, context }) => {
    const session = context.session;
    const [codingSession] = await db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.id, data.id))
      .limit(1);
    if (!codingSession) throw new Error("Session not found");
    if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
      throw new Error("Forbidden");
    }

    if (!codingSession.containerId) {
      throw new Error("No container associated with this session");
    }

    if (codingSession.status !== "stopped") {
      throw new Error("Can only restart a stopped session");
    }

    try {
      const docker = await getDockerClient();
      const container = docker.getContainer(codingSession.containerId);
      await container.start();
    } catch (err) {
      throw new Error(
        `Failed to restart container: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const updated = await db
      .update(schema.codingSessions)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, data.id))
      .returning();

    return updated[0];
  });
