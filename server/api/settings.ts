import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tar from "tar-stream";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, desc, inArray, count } from "drizzle-orm";
import { getDockerClient, resetDockerClient } from "../lib/docker.js";
import { auth } from "../lib/auth.js";
import type { AuthEnv } from "../middleware/auth.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { paginationQuery, paginate } from "../lib/pagination.js";

const app = new Hono<AuthEnv>()
  // ---------------------------------------------------------------------------
  // PUT /api/settings/profile — update profile (requires auth)
  // ---------------------------------------------------------------------------
  .put(
    "/profile",
    authMiddleware,
    zValidator(
      "json",
      z.object({
        name: z.string().optional(),
        password: z.string().optional(),
        currentPassword: z.string().optional(),
        newPassword: z.string().optional(),
      }),
    ),
    async (c) => {
      const session = c.get("session");
      const data = c.req.valid("json");

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updateData.name = data.name;

      if (Object.keys(updateData).length > 1) {
        await db.update(schema.user).set(updateData).where(eq(schema.user.id, session.user.id));
      }

      // Password change via Better Auth API
      const newPw = data.password ?? data.newPassword;
      if (newPw) {
        await auth.api.changePassword({
          headers: c.req.raw.headers,
          body: {
            newPassword: newPw,
            currentPassword: data.currentPassword ?? "",
            revokeOtherSessions: false,
          },
        });
      }

      return c.json({ success: true });
    },
  )

  // ---------------------------------------------------------------------------
  // Agent Configs — list requires auth, mutations require admin
  // ---------------------------------------------------------------------------
  .get("/agent-configs", authMiddleware, async (c) => {
    const rows = await db
      .select()
      .from(schema.agentConfigs)
      .orderBy(desc(schema.agentConfigs.createdAt));
    return c.json(rows);
  })

  .post(
    "/agent-configs",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        preset: z.string(),
        displayName: z.string(),
        agentCommand: z.string().optional(),
        envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        volumeMounts: z.array(z.object({ name: z.string(), mountPath: z.string() })).optional(),
        dockerfileContent: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid("json");

      const values: Partial<typeof schema.agentConfigs.$inferInsert> = {
        preset: data.preset,
        displayName: data.displayName,
        agentCommand: data.agentCommand ?? null,
        envVars: data.envVars ?? null,
        volumeMounts: data.volumeMounts ?? null,
        dockerfileContent: data.dockerfileContent ?? null,
        updatedAt: new Date(),
      };

      const inserted = await db
        .insert(schema.agentConfigs)
        .values(values as Required<typeof values>)
        .returning();

      return c.json(inserted[0], 201);
    },
  )

  .put(
    "/agent-configs/:id",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        preset: z.string(),
        displayName: z.string(),
        agentCommand: z.string().optional(),
        envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        volumeMounts: z.array(z.object({ name: z.string(), mountPath: z.string() })).optional(),
        dockerfileContent: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const values: Partial<typeof schema.agentConfigs.$inferInsert> = {
        preset: data.preset,
        displayName: data.displayName,
        agentCommand: data.agentCommand ?? null,
        envVars: data.envVars ?? null,
        volumeMounts: data.volumeMounts ?? null,
        dockerfileContent: data.dockerfileContent ?? null,
        updatedAt: new Date(),
      };

      // Check if dockerfileContent changed - if so, reset build status
      const existing = await db
        .select()
        .from(schema.agentConfigs)
        .where(eq(schema.agentConfigs.id, id))
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
        .where(eq(schema.agentConfigs.id, id))
        .returning();

      if (updated.length === 0) return c.json({ error: "Agent config not found" }, 404);
      return c.json(updated[0]);
    },
  )

  .delete("/agent-configs/:id", adminMiddleware, async (c) => {
    const id = c.req.param("id");
    await db.delete(schema.agentConfigs).where(eq(schema.agentConfigs.id, id));
    return c.json({ success: true });
  })

  // ---------------------------------------------------------------------------
  // Build Agent Image (admin only)
  // ---------------------------------------------------------------------------
  .post("/agent-configs/:id/build", adminMiddleware, async (c) => {
    const configId = c.req.param("id");

    const rows = await db
      .select()
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.id, configId))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Agent config not found" }, 404);
    const agentConfig = rows[0];

    if (agentConfig.imageBuildStatus === "building") {
      return c.json({ error: "Build already in progress" }, 409);
    }

    // Mark as building
    await db
      .update(schema.agentConfigs)
      .set({ imageBuildStatus: "building", imageBuildLog: null, updatedAt: new Date() })
      .where(eq(schema.agentConfigs.id, configId));

    const preset = agentConfig.preset;
    const dockerfileContent = agentConfig.dockerfileContent;

    // Start async build (don't await)
    (async () => {
      try {
        let dockerfile: string;
        if (dockerfileContent) {
          dockerfile = dockerfileContent;
        } else {
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

        const entrypointScript = fs.readFileSync(
          path.resolve(process.cwd(), "agent/entrypoint.sh"),
          "utf-8",
        );

        const pack = tar.pack();
        pack.entry({ name: "Dockerfile" }, dockerfile);
        pack.entry({ name: "agent/entrypoint.sh" }, entrypointScript);
        pack.finalize();

        const docker = await getDockerClient();
        const tag = `blackhouse-agent-${configId}:latest`;

        const stream = await docker.buildImage(pack as unknown as NodeJS.ReadableStream, {
          t: tag,
        });

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

    return c.json({ status: "building" });
  })

  // ---------------------------------------------------------------------------
  // Get Agent Build Status
  // ---------------------------------------------------------------------------
  .get("/agent-configs/:id/build-status", authMiddleware, async (c) => {
    const id = c.req.param("id");

    const rows = await db
      .select({
        imageBuildStatus: schema.agentConfigs.imageBuildStatus,
        imageBuildLog: schema.agentConfigs.imageBuildLog,
        lastBuiltAt: schema.agentConfigs.lastBuiltAt,
      })
      .from(schema.agentConfigs)
      .where(eq(schema.agentConfigs.id, id))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Agent config not found" }, 404);

    return c.json(rows[0]);
  })

  // ---------------------------------------------------------------------------
  // Get Default Dockerfile (admin only)
  // ---------------------------------------------------------------------------
  .get(
    "/default-dockerfile",
    adminMiddleware,
    zValidator("query", z.object({ preset: z.string().optional() }).optional()),
    async (c) => {
      const query = c.req.valid("query");
      const preset = query?.preset || "claude-code";
      const dockerfilePath = path.resolve(process.cwd(), `agent/dockerfiles/${preset}.Dockerfile`);
      const fallbackPath = path.resolve(process.cwd(), "agent/dockerfiles/claude-code.Dockerfile");
      const filePath = fs.existsSync(dockerfilePath) ? dockerfilePath : fallbackPath;

      return c.text(fs.readFileSync(filePath, "utf-8"));
    },
  )

  // ---------------------------------------------------------------------------
  // Docker Config (admin only)
  // ---------------------------------------------------------------------------
  .get("/docker", adminMiddleware, async (c) => {
    const rows = await db.select().from(schema.dockerConfigs).limit(1);
    return c.json(rows[0] ?? null);
  })

  .put(
    "/docker",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        socketPath: z.string().optional(),
        host: z.string().optional(),
        port: z.number().optional(),
        tlsCa: z.string().optional(),
        tlsCert: z.string().optional(),
        tlsKey: z.string().optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid("json");
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

      return c.json(result);
    },
  )

  // ---------------------------------------------------------------------------
  // Docker Status (admin only)
  // ---------------------------------------------------------------------------
  .get("/docker/status", adminMiddleware, async (c) => {
    try {
      const docker = await getDockerClient();
      const info = await docker.info();

      return c.json({
        connected: true,
        serverVersion: info.ServerVersion as string,
        os: info.OperatingSystem as string,
        totalMemory: info.MemTotal as number,
        containers: info.Containers as number,
        containersRunning: info.ContainersRunning as number,
        containersStopped: info.ContainersStopped as number,
        images: info.Images as number,
      });
    } catch (err) {
      return c.json({
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })

  // ---------------------------------------------------------------------------
  // List Containers (admin only)
  // ---------------------------------------------------------------------------
  .get(
    "/containers",
    adminMiddleware,
    zValidator("query", paginationQuery.optional()),
    async (c) => {
      const query = c.req.valid("query");
      const page = query?.page ?? 1;
      const perPage = query?.perPage ?? 20;

      try {
        const docker = await getDockerClient();
        const containers = await docker.listContainers({
          all: true,
          filters: { label: ["blackhouse.managed=true"] },
        });

        // Enrich with session info from DB
        const sessionIds = containers
          .map((ct) => ct.Labels?.["blackhouse.session_id"])
          .filter(Boolean) as string[];

        const sessionsMap = new Map<string, typeof schema.codingSessions.$inferSelect>();

        if (sessionIds.length > 0) {
          const sessions = await db
            .select()
            .from(schema.codingSessions)
            .where(inArray(schema.codingSessions.id, sessionIds));

          for (const s of sessions) {
            sessionsMap.set(s.id, s);
          }
        }

        const allItems = containers.map((ct) => {
          const sessionId = ct.Labels?.["blackhouse.session_id"];
          return {
            containerId: ct.Id,
            image: ct.Image,
            state: ct.State,
            status: ct.Status,
            created: ct.Created,
            sessionId,
            session: sessionId ? (sessionsMap.get(sessionId) ?? null) : null,
          };
        });

        return c.json(paginate(allItems, page, perPage));
      } catch (err) {
        return c.json(
          {
            error: `Failed to list containers: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    },
  )

  // ---------------------------------------------------------------------------
  // List Volumes (admin only)
  // ---------------------------------------------------------------------------
  .get("/volumes", adminMiddleware, async (c) => {
    try {
      // Collect volume names referenced by agent configs
      const configs = await db.select().from(schema.agentConfigs);
      const managedNames = new Set<string>();
      for (const cfg of configs) {
        if (Array.isArray(cfg.volumeMounts)) {
          for (const m of cfg.volumeMounts as Array<{ name: string; mountPath: string }>) {
            if (m.name) managedNames.add(m.name);
          }
        }
      }

      const docker = await getDockerClient();
      const { Volumes } = await docker.listVolumes();
      const managed = (Volumes ?? []).filter((v) => managedNames.has(v.Name));

      // Inspect each volume for UsageData (size + refCount)
      const results = await Promise.all(
        managed.map(async (v) => {
          try {
            const info = await docker.getVolume(v.Name).inspect();
            return {
              name: v.Name,
              driver: v.Driver,
              mountpoint: v.Mountpoint,
              scope: v.Scope,
              size: info.UsageData?.Size ?? null,
              refCount: info.UsageData?.RefCount ?? null,
            };
          } catch {
            return {
              name: v.Name,
              driver: v.Driver,
              mountpoint: v.Mountpoint,
              scope: v.Scope,
              size: null,
              refCount: null,
            };
          }
        }),
      );

      return c.json(results);
    } catch (err) {
      return c.json(
        { error: `Failed to list volumes: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  })

  // ---------------------------------------------------------------------------
  // User Management (admin only)
  // ---------------------------------------------------------------------------
  .get("/users", adminMiddleware, zValidator("query", paginationQuery.optional()), async (c) => {
    const query = c.req.valid("query");
    const page = query?.page ?? 1;
    const perPage = query?.perPage ?? 20;
    const offset = (page - 1) * perPage;

    const [{ total }] = await db.select({ total: count() }).from(schema.user);

    const rows = await db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        username: schema.user.username,
        role: schema.user.role,
        banned: schema.user.banned,
        createdAt: schema.user.createdAt,
      })
      .from(schema.user)
      .orderBy(desc(schema.user.createdAt))
      .limit(perPage)
      .offset(offset);

    return c.json({ data: rows, total, page, perPage });
  })

  .post(
    "/users",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        name: z.string(),
        email: z.string(),
        username: z.string().optional(),
        password: z.string(),
        role: z.string().optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid("json");

      const result = await auth.api.signUpEmail({
        body: {
          name: data.name,
          email: data.email,
          password: data.password,
        },
      });

      // Set username and role after sign-up
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.username) updates.username = data.username;
      if (data.role && data.role !== "user") updates.role = data.role;

      if (Object.keys(updates).length > 1) {
        await db.update(schema.user).set(updates).where(eq(schema.user.email, data.email));
      }

      return c.json(result, 201);
    },
  )

  .put(
    "/users/:id",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        username: z.string().optional(),
        role: z.string().optional(),
      }),
    ),
    async (c) => {
      const session = c.get("session");
      const targetId = c.req.param("id");
      const data = c.req.valid("json");

      if (targetId === session.user.id && data.role && data.role !== session.user.role) {
        return c.json({ error: "Cannot change your own role" }, 400);
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.email !== undefined) updates.email = data.email;
      if (data.username !== undefined) updates.username = data.username;
      if (data.role !== undefined) updates.role = data.role;

      const updated = await db
        .update(schema.user)
        .set(updates)
        .where(eq(schema.user.id, targetId))
        .returning();

      if (updated.length === 0) return c.json({ error: "User not found" }, 404);

      return c.json(updated[0]);
    },
  )

  .delete("/users/:id", adminMiddleware, async (c) => {
    const session = c.get("session");
    const targetId = c.req.param("id");

    if (targetId === session.user.id) {
      return c.json({ error: "Cannot delete your own account" }, 400);
    }

    await db.delete(schema.user).where(eq(schema.user.id, targetId));

    return c.json({ success: true });
  })

  .put(
    "/users/:id/role",
    adminMiddleware,
    zValidator("json", z.object({ role: z.string() })),
    async (c) => {
      const session = c.get("session");
      const targetId = c.req.param("id");
      const { role } = c.req.valid("json");

      if (targetId === session.user.id) {
        return c.json({ error: "Cannot change your own role" }, 400);
      }

      const updated = await db
        .update(schema.user)
        .set({ role, updatedAt: new Date() })
        .where(eq(schema.user.id, targetId))
        .returning();

      if (updated.length === 0) return c.json({ error: "User not found" }, 404);

      return c.json(updated[0]);
    },
  );

export default app;
