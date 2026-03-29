import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware, adminMiddleware } from "@/server/middleware";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { getDockerClient, resetDockerClient } from "@/lib/docker";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tar from "tar-stream";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .inputValidator(
    z.object({
      name: z.string().optional(),
      password: z.string().optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = context.session;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;

    if (Object.keys(updateData).length > 1) {
      await db.update(schema.user).set(updateData).where(eq(schema.user.id, session.user.id));
    }

    // Password change via Better Auth API
    const newPw = data.password ?? data.newPassword;
    if (newPw) {
      const request = getRequest();
      await auth.api.changePassword({
        headers: request.headers,
        body: {
          newPassword: newPw,
          currentPassword: data.currentPassword ?? "",
          revokeOtherSessions: false,
        },
      });
    }

    return { success: true };
  });

// ---------------------------------------------------------------------------
// Agent Configs (admin only)
// ---------------------------------------------------------------------------

export const listAgentConfigs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    return db.select().from(schema.agentConfigs).orderBy(desc(schema.agentConfigs.createdAt));
  });

export const upsertAgentConfig = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      id: z.string().optional(),
      preset: z.string(),
      displayName: z.string(),
      agentCommand: z.string().optional(),
      envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      volumeMounts: z.array(z.object({ name: z.string(), mountPath: z.string() })).optional(),
      dockerfileContent: z.string().nullable().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const values: Record<string, unknown> = {
      preset: data.preset,
      displayName: data.displayName,
      agentCommand: data.agentCommand ?? null,
      envVars: data.envVars ?? null,
      volumeMounts: data.volumeMounts ?? null,
      dockerfileContent: data.dockerfileContent ?? null,
      updatedAt: new Date(),
    };

    if (data.id) {
      // Check if dockerfileContent changed – if so, reset build status
      const existing = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.id, data.id))
        .limit(1);

      if (
        existing.length > 0 &&
        existing[0].dockerfileContent !== (data.dockerfileContent ?? null)
      ) {
        values.imageBuildStatus = "none";
      }

      const updated = await db
        .update(schema.agentConfigs)
        .set(values)
        .where(eq(schema.agentConfigs.id, data.id))
        .returning();

      if (updated.length === 0) throw new Error("Agent config not found");
      return updated[0];
    }

    // Create new
    const inserted = await db.insert(schema.agentConfigs).values(values).returning();

    return inserted[0];
  });

export const deleteAgentConfig = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.string() }))
  .handler(async ({ data }) => {
    await db.delete(schema.agentConfigs).where(eq(schema.agentConfigs.id, data.id));

    return { success: true };
  });

// ---------------------------------------------------------------------------
// Build Agent Image (admin only)
// ---------------------------------------------------------------------------

export const buildAgentImage = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ agentConfigId: z.string() }))
  .handler(async ({ data }) => {
    const rows = await db
      .select()
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.id, data.agentConfigId))
      .limit(1);

    if (rows.length === 0) throw new Error("Agent config not found");
    const agentConfig = rows[0];

    if (agentConfig.imageBuildStatus === "building") {
      throw new Error("Build already in progress");
    }

    // Mark as building
    await db
      .update(schema.agentConfigs)
      .set({ imageBuildStatus: "building", imageBuildLog: null, updatedAt: new Date() })
      .where(eq(schema.agentConfigs.id, data.agentConfigId));

    // Start async build (don't await)
    const configId = data.agentConfigId;
    const preset = agentConfig.preset;
    const dockerfileContent = agentConfig.dockerfileContent;

    (async () => {
      try {
        // Get dockerfile content
        let dockerfile: string;
        if (dockerfileContent) {
          dockerfile = dockerfileContent;
        } else {
          // Read preset-specific dockerfile, fall back to claude-code
          const presetDockerfile = path.resolve(
            process.cwd(),
            `agent/dockerfiles/${preset}.Dockerfile`,
          );
          const fallbackDockerfile = path.resolve(
            process.cwd(),
            "agent/dockerfiles/claude-code.Dockerfile",
          );
          if (fs.existsSync(presetDockerfile)) {
            dockerfile = fs.readFileSync(presetDockerfile, "utf-8");
          } else {
            dockerfile = fs.readFileSync(fallbackDockerfile, "utf-8");
          }
        }

        // Read supporting files
        const entrypointScript = fs.readFileSync(
          path.resolve(process.cwd(), "agent/entrypoint.sh"),
          "utf-8",
        );

        // Create tar stream with build context
        const pack = tar.pack();
        pack.entry({ name: "Dockerfile" }, dockerfile);
        pack.entry({ name: "agent/entrypoint.sh" }, entrypointScript);
        pack.finalize();

        const docker = await getDockerClient();
        const tag = `blackhouse-agent-${configId}:latest`;

        const stream = await docker.buildImage(pack as unknown as NodeJS.ReadableStream, {
          t: tag,
        });

        // Collect build output
        const output = await new Promise<string>((resolve, reject) => {
          const lines: string[] = [];
          stream.on("data", (chunk: Buffer) => {
            try {
              const json = JSON.parse(chunk.toString());
              if (json.stream) lines.push(json.stream);
              if (json.error) reject(new Error(json.error));
            } catch {
              lines.push(chunk.toString());
            }
          });
          stream.on("end", () => resolve(lines.join("")));
          stream.on("error", reject);
        });

        await db
          .update(schema.agentConfigs)
          .set({
            imageBuildStatus: "built",
            lastBuiltAt: new Date(),
            imageBuildLog: output,
            updatedAt: new Date(),
          })
          .where(eq(schema.agentConfigs.id, configId));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.agentConfigs)
          .set({
            imageBuildStatus: "failed",
            imageBuildLog: errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(schema.agentConfigs.id, configId));
      }
    })();

    return { status: "building" };
  });

// ---------------------------------------------------------------------------
// Get Agent Build Status
// ---------------------------------------------------------------------------

export const getAgentBuildStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .inputValidator(z.object({ agentConfigId: z.string() }))
  .handler(async ({ data }) => {
    const rows = await db
      .select({
        imageBuildStatus: schema.agentConfigs.imageBuildStatus,
        imageBuildLog: schema.agentConfigs.imageBuildLog,
        lastBuiltAt: schema.agentConfigs.lastBuiltAt,
      })
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.id, data.agentConfigId))
      .limit(1);

    if (rows.length === 0) throw new Error("Agent config not found");

    return rows[0];
  });

// ---------------------------------------------------------------------------
// Get Default Dockerfile
// ---------------------------------------------------------------------------

export const getDefaultDockerfile = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ preset: z.string().optional() }).optional())
  .handler(async ({ data }) => {
    const preset = data?.preset || "claude-code";
    const dockerfilePath = path.resolve(process.cwd(), `agent/dockerfiles/${preset}.Dockerfile`);

    // Fall back to claude-code if preset file doesn't exist
    const fallbackPath = path.resolve(process.cwd(), "agent/dockerfiles/claude-code.Dockerfile");
    const filePath = fs.existsSync(dockerfilePath) ? dockerfilePath : fallbackPath;

    return fs.readFileSync(filePath, "utf-8");
  });

// ---------------------------------------------------------------------------
// Docker Config (admin only)
// ---------------------------------------------------------------------------

export const getDockerConfig = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    const rows = await db.select().from(schema.dockerConfigs).limit(1);

    return rows[0] ?? null;
  });

export const updateDockerConfig = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      socketPath: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      tlsCa: z.string().optional(),
      tlsCert: z.string().optional(),
      tlsKey: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    // Upsert with id=1 (singleton row)
    const existing = await db.select().from(schema.dockerConfigs).limit(1);

    const values = {
      socketPath: data.socketPath ?? "/var/run/docker.sock",
      host: data.host ?? null,
      port: data.port ?? null,
      tlsCa: data.tlsCa ?? null,
      tlsCert: data.tlsCert ?? null,
      tlsKey: data.tlsKey ?? null,
      updatedAt: new Date(),
    };

    let result;
    if (existing.length > 0) {
      const updated = await db
        .update(schema.dockerConfigs)
        .set(values)
        .where(eq(schema.dockerConfigs.id, 1))
        .returning();
      result = updated[0];
    } else {
      const inserted = await db
        .insert(schema.dockerConfigs)
        .values({ id: 1, ...values })
        .returning();
      result = inserted[0];
    }

    // Reset cached Docker client so next call picks up new config
    resetDockerClient();

    return result;
  });

// ---------------------------------------------------------------------------
// Docker Status (admin only)
// ---------------------------------------------------------------------------

export const getDockerStatus = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    try {
      const docker = await getDockerClient();
      const info = await docker.info();

      return {
        connected: true,
        serverVersion: info.ServerVersion as string,
        os: info.OperatingSystem as string,
        totalMemory: info.MemTotal as number,
        containers: info.Containers as number,
        containersRunning: info.ContainersRunning as number,
        containersStopped: info.ContainersStopped as number,
        images: info.Images as number,
      };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

// ---------------------------------------------------------------------------
// List Containers (admin only)
// ---------------------------------------------------------------------------

export const listContainers = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    try {
      const docker = await getDockerClient();
      const containers = await docker.listContainers({
        all: true,
        filters: { label: ["blackhouse.managed=true"] },
      });

      // Enrich with session info from DB
      const sessionIds = containers
        .map((c) => c.Labels?.["blackhouse.session_id"])
        .filter(Boolean) as string[];

      let sessionsMap = new Map<string, typeof schema.codingSessions.$inferSelect>();

      if (sessionIds.length > 0) {
        const sessions = await db
          .select()
          .from(schema.codingSessions)
          .where(inArray(schema.codingSessions.id, sessionIds));

        for (const s of sessions) {
          sessionsMap.set(s.id, s);
        }
      }

      return containers.map((c) => {
        const sessionId = c.Labels?.["blackhouse.session_id"];
        return {
          containerId: c.Id,
          image: c.Image,
          state: c.State,
          status: c.Status,
          created: c.Created,
          sessionId,
          session: sessionId ? (sessionsMap.get(sessionId) ?? null) : null,
        };
      });
    } catch (err) {
      throw new Error(
        `Failed to list containers: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

// ---------------------------------------------------------------------------
// User Management (admin only)
// ---------------------------------------------------------------------------

export const listUsers = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    return db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.user.role,
        banned: schema.user.banned,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .orderBy(desc(schema.user.createdAt));
  });

export const createUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({
      name: z.string(),
      email: z.string(),
      username: z.string().optional(),
      password: z.string(),
      role: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const result = await auth.api.signUpEmail({
      body: {
        name: data.name,
        email: data.email,
        password: data.password,
      },
    });

    // Set role if specified
    if (data.role && data.role !== "user") {
      await db
        .update(schema.user)
        .set({ role: data.role, updatedAt: new Date() })
        .where(eq(schema.user.email, data.email));
    }

    return result;
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ id: z.string().optional(), userId: z.string().optional() }))
  .handler(async ({ data, context }) => {
    const session = context.session;

    const targetId = data.id ?? data.userId;
    if (!targetId) throw new Error("Missing user id");

    if (targetId === session.user.id) {
      throw new Error("Cannot delete your own account");
    }

    await db.delete(schema.user).where(eq(schema.user.id, targetId));

    return { success: true };
  });

export const updateUserRole = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator(
    z.object({ id: z.string().optional(), userId: z.string().optional(), role: z.string() }),
  )
  .handler(async ({ data, context }) => {
    const session = context.session;

    const targetId = data.id ?? data.userId;
    if (!targetId) throw new Error("Missing user id");

    if (targetId === session.user.id) {
      throw new Error("Cannot change your own role");
    }

    const updated = await db
      .update(schema.user)
      .set({ role: data.role, updatedAt: new Date() })
      .where(eq(schema.user.id, targetId))
      .returning();

    if (updated.length === 0) throw new Error("User not found");

    return updated[0];
  });
