import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/server/middleware";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getDockerClient } from "@/lib/docker";

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

    // Auto-detect stopped containers: if DB says "running" but container is not, update status
    if (codingSession.status === "running" && codingSession.containerId) {
      try {
        const docker = await getDockerClient();
        const container = docker.getContainer(codingSession.containerId);
        const info = await container.inspect();
        if (!info.State.Running) {
          await db
            .update(schema.codingSessions)
            .set({ status: "stopped", updatedAt: new Date() })
            .where(eq(schema.codingSessions.id, data.id));
          return { ...codingSession, status: "stopped" as const };
        }
      } catch {
        // Container doesn't exist — mark as stopped
        await db
          .update(schema.codingSessions)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, data.id));
        return { ...codingSession, status: "stopped" as const };
      }
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
      preset: z.string().optional(),
      agentConfigId: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = context.session;

    // Look up agent config for docker image
    let agentConfigRows;
    if (data.agentConfigId) {
      agentConfigRows = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.id, data.agentConfigId))
        .limit(1);
    } else if (data.preset) {
      agentConfigRows = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.preset, data.preset))
        .limit(1);
    } else {
      throw new Error("Either preset or agentConfigId is required");
    }

    if (agentConfigRows.length === 0) {
      throw new Error(`Unknown agent: ${data.agentConfigId ?? data.preset}`);
    }

    const agentConfig = agentConfigRows[0];

    if (agentConfig.imageBuildStatus !== "built") {
      throw new Error(`Agent "${agentConfig.displayName}" does not have a built Docker image`);
    }

    const imageName = `blackhouse-agent-${agentConfig.id}:latest`;

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

    // Validate git requirement from template
    if (template?.gitRequired && !data.gitRepoUrl) {
      throw new Error("This template requires a Git repository");
    }

    const inserted = await db
      .insert(schema.codingSessions)
      .values({
        userId: session.user.id,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl ?? null,
        gitBranch: data.gitBranch ?? "main",
        templateId: data.templateId ?? null,
        preset: agentConfig.preset,
        containerImage: imageName,
        status: "pending",
      })
      .returning();

    const codingSession = inserted[0];

    // Build environment variables for the container
    const env: string[] = [
      "TERM=xterm-256color",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      `SESSION_ID=${codingSession.id}`,
      `SESSION_NAME=${data.name}`,
      `BLACKHOUSE_URL=${process.env.BETTER_AUTH_URL || "http://host.docker.internal:3000"}`,
      `CONTAINER_TOKEN=${codingSession.id}`,
    ];

    if (data.gitRepoUrl) {
      env.push(`GIT_REPO_URL=${data.gitRepoUrl}`);
      if (data.gitBranch) {
        env.push(`GIT_BRANCH=${data.gitBranch}`);
      }
    }

    if (agentConfig.agentCommand) {
      env.push(`AGENT_COMMAND=${agentConfig.agentCommand}`);
    }

    if (template?.systemPrompt) {
      env.push(`SYSTEM_PROMPT=${template.systemPrompt}`);
    }

    // Add custom env vars from agent config
    if (Array.isArray(agentConfig.envVars)) {
      for (const entry of agentConfig.envVars as Array<{ key: string; value: string }>) {
        env.push(`${entry.key}=${entry.value}`);
      }
    }

    // Build volume mounts (Binds) from agent config
    const binds: string[] = [];
    if (Array.isArray(agentConfig.volumeMounts)) {
      for (const mount of agentConfig.volumeMounts as Array<{
        name: string;
        mountPath: string;
      }>) {
        binds.push(`${mount.name}:${mount.mountPath}`);
      }
    }

    try {
      const docker = await getDockerClient();

      const container = await docker.createContainer({
        Image: imageName,
        Env: env,
        Tty: true,
        OpenStdin: true,
        Labels: {
          "blackhouse.session_id": codingSession.id,
          "blackhouse.user_id": session.user.id,
          "blackhouse.managed": "true",
        },
        HostConfig: {
          // Reasonable defaults for coding containers
          Memory: 2 * 1024 * 1024 * 1024, // 2GB
          NanoCpus: 2_000_000_000, // 2 CPUs
          Binds: binds.length > 0 ? binds : undefined,
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

      // Check if container still exists and is in a restartable state
      const info = await container.inspect().catch(() => null);
      if (!info) {
        throw new Error(
          "Container no longer exists. Please destroy this session and create a new one.",
        );
      }
      if (info.State.Running) {
        // Already running — just update status
        await db
          .update(schema.codingSessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, data.id));
        return (
          await db
            .select()
            .from(schema.codingSessions)
            .where(eq(schema.codingSessions.id, data.id))
            .limit(1)
        )[0];
      }

      // Use restart() which works regardless of container state (exited, stopped, etc.)
      await container.restart({ t: 5 });

      // Wait briefly then verify container is actually running
      await new Promise((r) => setTimeout(r, 1000));
      const postInfo = await container.inspect().catch(() => null);
      if (!postInfo || !postInfo.State.Running) {
        // Container exited immediately after restart (entrypoint failed)
        await db
          .update(schema.codingSessions)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, data.id));
        throw new Error(
          "Container exited immediately after restart. The entrypoint script may have failed. Please destroy this session and create a new one.",
        );
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Container no longer exists") ||
          err.message.includes("Container exited immediately"))
      ) {
        throw err;
      }
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
