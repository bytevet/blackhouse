import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { getDockerClient } from "../lib/docker.js";
import type { AuthEnv } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono<AuthEnv>();

// All routes require auth
app.use("*", authMiddleware);

// ---------------------------------------------------------------------------
// GET /api/sessions — list sessions
// ---------------------------------------------------------------------------

app.get(
  "/",
  zValidator("query", z.object({ all: z.coerce.boolean().optional() }).optional()),
  async (c) => {
    const session = c.get("session");
    const query = c.req.valid("query");

    if (query?.all && session.user.role === "admin") {
      const rows = await db
        .select({
          session: schema.codingSessions,
          userName: schema.user.name,
          userEmail: schema.user.email,
        })
        .from(schema.codingSessions)
        .leftJoin(schema.user, eq(schema.codingSessions.userId, schema.user.id))
        .orderBy(desc(schema.codingSessions.createdAt));

      return c.json(
        rows.map((r) => ({
          ...r.session,
          user: { name: r.userName, email: r.userEmail },
        })),
      );
    }

    const rows = await db
      .select()
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.userId, session.user.id))
      .orderBy(desc(schema.codingSessions.createdAt));

    return c.json(rows);
  },
);

// ---------------------------------------------------------------------------
// GET /api/sessions/:id — get single session
// ---------------------------------------------------------------------------

app.get("/:id", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!codingSession) return c.json({ error: "Session not found" }, 404);
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Auto-detect stopped containers
  if (codingSession.status === "running" && codingSession.containerId) {
    try {
      const docker = await getDockerClient();
      const container = docker.getContainer(codingSession.containerId);
      const info = await container.inspect();
      if (!info.State.Running) {
        await db
          .update(schema.codingSessions)
          .set({ status: "stopped", updatedAt: new Date() })
          .where(eq(schema.codingSessions.id, id));
        return c.json({ ...codingSession, status: "stopped" as const });
      }
    } catch {
      await db
        .update(schema.codingSessions)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.codingSessions.id, id));
      return c.json({ ...codingSession, status: "stopped" as const });
    }
  }

  return c.json(codingSession);
});

// ---------------------------------------------------------------------------
// POST /api/sessions — create session
// ---------------------------------------------------------------------------

app.post(
  "/",
  zValidator(
    "json",
    z.object({
      name: z.string(),
      gitRepoUrl: z.string().optional(),
      gitBranch: z.string().optional(),
      templateId: z.string().optional(),
      preset: z.string().optional(),
      agentConfigId: z.string().optional(),
    }),
  ),
  async (c) => {
    const session = c.get("session");
    const data = c.req.valid("json");

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
      return c.json({ error: "Either preset or agentConfigId is required" }, 400);
    }

    if (agentConfigRows.length === 0) {
      return c.json({ error: `Unknown agent: ${data.agentConfigId ?? data.preset}` }, 404);
    }

    const agentConfig = agentConfigRows[0];

    if (agentConfig.imageBuildStatus !== "built") {
      return c.json(
        { error: `Agent "${agentConfig.displayName}" does not have a built Docker image` },
        400,
      );
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
        return c.json({ error: "Template not found" }, 404);
      }

      template = templates[0];
    }

    // Validate git requirement from template
    if (template?.gitRequired && !data.gitRepoUrl) {
      return c.json({ error: "This template requires a Git repository" }, 400);
    }

    const sessionToken = randomBytes(32).toString("hex");

    const inserted = await db
      .insert(schema.codingSessions)
      .values({
        userId: session.user.id,
        name: data.name,
        gitRepoUrl: data.gitRepoUrl ?? null,
        gitBranch: data.gitBranch ?? "main",
        templateId: data.templateId ?? null,
        preset: agentConfig.preset,
        agentConfigId: agentConfig.id,
        containerImage: imageName,
        sessionToken,
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
      `BLACKHOUSE_URL=${process.env.BLACKHOUSE_CONTAINER_URL || "http://host.docker.internal:3000"}`,
      `SESSION_TOKEN=${sessionToken}`,
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

      return c.json(updated[0]);
    } catch (err) {
      await db
        .update(schema.codingSessions)
        .set({
          status: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(schema.codingSessions.id, codingSession.id));

      return c.json(
        {
          error: `Failed to create container: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/stop
// ---------------------------------------------------------------------------

app.post("/:id/stop", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!codingSession) return c.json({ error: "Session not found" }, 404);
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!codingSession.containerId) {
    return c.json({ error: "No container associated with this session" }, 400);
  }

  try {
    const docker = await getDockerClient();
    const container = docker.getContainer(codingSession.containerId);
    await container.stop({ t: 10 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("is not running") && !message.includes("304")) {
      return c.json({ error: `Failed to stop container: ${message}` }, 500);
    }
  }

  const updated = await db
    .update(schema.codingSessions)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, id))
    .returning();

  return c.json(updated[0]);
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/destroy
// ---------------------------------------------------------------------------

app.post("/:id/destroy", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!codingSession) return c.json({ error: "Session not found" }, 404);
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (codingSession.containerId) {
    try {
      const docker = await getDockerClient();
      const container = docker.getContainer(codingSession.containerId);
      await container.remove({ force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("No such container") && !message.includes("404")) {
        return c.json({ error: `Failed to remove container: ${message}` }, 500);
      }
    }
  }

  await db.delete(schema.codingSessions).where(eq(schema.codingSessions.id, id));

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/restart
// ---------------------------------------------------------------------------

app.post("/:id/restart", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!codingSession) return c.json({ error: "Session not found" }, 404);
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!codingSession.containerId) {
    return c.json({ error: "No container associated with this session" }, 400);
  }

  if (codingSession.status !== "stopped") {
    return c.json({ error: "Can only restart a stopped session" }, 400);
  }

  try {
    const docker = await getDockerClient();
    const container = docker.getContainer(codingSession.containerId);

    const info = await container.inspect().catch(() => null);
    if (!info) {
      return c.json(
        { error: "Container no longer exists. Please destroy this session and create a new one." },
        400,
      );
    }
    if (info.State.Running) {
      await db
        .update(schema.codingSessions)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.codingSessions.id, id));
      const [updated] = await db
        .select()
        .from(schema.codingSessions)
        .where(eq(schema.codingSessions.id, id))
        .limit(1);
      return c.json(updated);
    }

    await container.restart({ t: 5 });

    // Wait briefly then verify container is actually running
    await new Promise((r) => setTimeout(r, 1000));
    const postInfo = await container.inspect().catch(() => null);
    if (!postInfo || !postInfo.State.Running) {
      await db
        .update(schema.codingSessions)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.codingSessions.id, id));
      return c.json(
        {
          error:
            "Container exited immediately after restart. The entrypoint script may have failed. Please destroy this session and create a new one.",
        },
        500,
      );
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Container no longer exists") ||
        err.message.includes("Container exited immediately"))
    ) {
      return c.json({ error: err.message }, 500);
    }
    return c.json(
      { error: `Failed to restart container: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  const updated = await db
    .update(schema.codingSessions)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, id))
    .returning();

  return c.json(updated[0]);
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/recreate-params
// ---------------------------------------------------------------------------

app.get("/:id/recreate-params", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [original] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!original) return c.json({ error: "Session not found" }, 404);
  if (original.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({
    name: original.name,
    gitRepoUrl: original.gitRepoUrl,
    gitBranch: original.gitBranch,
    templateId: original.templateId,
    agentConfigId: original.agentConfigId,
    preset: original.preset,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/:id/clear-result
// ---------------------------------------------------------------------------

app.post("/:id/clear-result", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");

  const [codingSession] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, id))
    .limit(1);

  if (!codingSession) return c.json({ error: "Session not found" }, 404);
  if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .update(schema.codingSessions)
    .set({ resultHtml: null, updatedAt: new Date() })
    .where(eq(schema.codingSessions.id, id));

  return c.json({ success: true });
});

export default app;
