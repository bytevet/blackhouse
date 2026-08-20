import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import * as fs from "node:fs";
import * as os from "node:os";
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
import { volumeMountSchema } from "../lib/validation.js";

// ---------------------------------------------------------------------------
// Build-context tar helpers
// ---------------------------------------------------------------------------

/** Pack a single file (resolved against cwd) into the tar stream. */
function addFileToTar(
  pack: tar.Pack,
  relPath: string,
  opts?: { mode?: number; optional?: boolean },
): void {
  const abs = path.resolve(process.cwd(), relPath);
  // `optional` is for context files that only some Dockerfiles want, and that
  // the server image does not necessarily ship. Missing is not an error; the
  // build fails clearly on the COPY if it turns out one was needed.
  if (opts?.optional && !fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  const buf = fs.readFileSync(abs);
  pack.entry(
    {
      name: relPath,
      mode: opts?.mode ?? stat.mode & 0o7777,
      mtime: stat.mtime,
      size: buf.length,
    },
    buf,
  );
}

/**
 * Recursively pack a directory (resolved against cwd) into the tar stream.
 * Entries are added with their path relative to cwd so the Docker daemon
 * sees the same layout the local working tree has — `COPY agent/foo /dst`
 * resolves identically.
 */
function addDirToTar(pack: tar.Pack, relDir: string, opts?: { skip?: string[] }): void {
  const skip = new Set(opts?.skip ?? []);
  const root = path.resolve(process.cwd(), relDir);
  const walk = (absDir: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(process.cwd(), abs);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        const buf = fs.readFileSync(abs);
        pack.entry(
          {
            name: rel,
            mode: stat.mode & 0o7777,
            mtime: stat.mtime,
            size: buf.length,
          },
          buf,
        );
      }
      // symlinks/sockets/etc. are skipped — build context shouldn't carry them
    }
  };
  walk(root);
}

/** Safe projection of an agent for the container listing — never includes `agentToken`. */
type AgentContainerInfo = {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  activity: string;
  statusLine: string | null;
  runtimeUsed: string | null;
};

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
  .get("/blueprints", authMiddleware, async (c) => {
    const rows = await db
      .select()
      .from(schema.agentBlueprints)
      .orderBy(desc(schema.agentBlueprints.createdAt));
    return c.json(rows);
  })

  .post(
    "/blueprints",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        cli: z.enum(["claude-code", "codex", "antigravity", "custom"]),
        name: z.string(),
        agentCommand: z.string().optional(),
        envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        volumeMounts: volumeMountSchema.optional(),
        dockerfileContent: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const data = c.req.valid("json");

      const values: Partial<typeof schema.agentBlueprints.$inferInsert> = {
        cli: data.cli,
        name: data.name,
        agentCommand: data.agentCommand ?? null,
        envVars: data.envVars ?? null,
        volumeMounts: data.volumeMounts ?? null,
        dockerfileContent: data.dockerfileContent ?? null,
        updatedAt: new Date(),
      };

      const inserted = await db
        .insert(schema.agentBlueprints)
        .values(values as Required<typeof values>)
        .returning();

      return c.json(inserted[0], 201);
    },
  )

  .put(
    "/blueprints/:id",
    adminMiddleware,
    zValidator(
      "json",
      z.object({
        cli: z.enum(["claude-code", "codex", "antigravity", "custom"]),
        name: z.string(),
        agentCommand: z.string().optional(),
        envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        volumeMounts: volumeMountSchema.optional(),
        dockerfileContent: z.string().nullable().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param("id");
      const data = c.req.valid("json");

      const values: Partial<typeof schema.agentBlueprints.$inferInsert> = {
        cli: data.cli,
        name: data.name,
        agentCommand: data.agentCommand ?? null,
        envVars: data.envVars ?? null,
        volumeMounts: data.volumeMounts ?? null,
        dockerfileContent: data.dockerfileContent ?? null,
        updatedAt: new Date(),
      };

      // Check if dockerfileContent changed - if so, reset build status
      const existing = await db
        .select()
        .from(schema.agentBlueprints)
        .where(eq(schema.agentBlueprints.id, id))
        .limit(1);

      if (
        existing.length > 0 &&
        existing[0].dockerfileContent !== (data.dockerfileContent ?? null)
      ) {
        values.imageBuildStatus = "none";
      }

      const updated = await db
        .update(schema.agentBlueprints)
        .set(values)
        .where(eq(schema.agentBlueprints.id, id))
        .returning();

      if (updated.length === 0) return c.json({ error: "Agent config not found" }, 404);
      return c.json(updated[0]);
    },
  )

  .delete("/blueprints/:id", adminMiddleware, async (c) => {
    const id = c.req.param("id");
    await db.delete(schema.agentBlueprints).where(eq(schema.agentBlueprints.id, id));
    return c.json({ success: true });
  })

  // ---------------------------------------------------------------------------
  // Build Agent Image (admin only)
  // ---------------------------------------------------------------------------
  .post("/blueprints/:id/build", adminMiddleware, async (c) => {
    const configId = c.req.param("id");

    const rows = await db
      .select()
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, configId))
      .limit(1);

    if (rows.length === 0) return c.json({ error: "Agent config not found" }, 404);
    const agentConfig = rows[0];

    if (agentConfig.imageBuildStatus === "building") {
      return c.json({ error: "Build already in progress" }, 409);
    }

    // Mark as building
    await db
      .update(schema.agentBlueprints)
      .set({ imageBuildStatus: "building", imageBuildLog: null, updatedAt: new Date() })
      .where(eq(schema.agentBlueprints.id, configId));

    const preset = agentConfig.cli;
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

        /**
         * Pack the whole `agent/` tree, not a list of the paths we think the
         * Dockerfile wants.
         *
         * This used to name four paths, and the comment explaining them cited
         * the change that added them. It then went stale: the harness refactor
         * introduced `agent/sidecar/` and `agent/egress-proxy/` and rewrote
         * `agent/skills/blackhouse/`, and none of that reached this list. The
         * blueprints kept building against a context missing the files their
         * Dockerfiles copy, and failed with
         *
         *     COPY failed: ... stat agent/sidecar: file does not exist
         *
         * A hand-maintained mirror of another file's COPY directives has to be
         * updated by whoever edits those directives, in a file they have no
         * reason to open. Packing the directory removes the mirror. It costs a
         * little context size, which is cheap next to a build that fails for a
         * reason nobody can see from the Dockerfile.
         *
         * `node_modules` is still skipped: the Dockerfile re-runs
         * `npm install --omit=dev` inside the image, and host-installed modules
         * would bloat the upload and risk shipping host-platform binaries.
         */
        addDirToTar(pack, "agent", { skip: ["node_modules"] });

        // The mock image builds the fake TUI from `tests/`, which is outside
        // `agent/` and excluded from the server image by `.dockerignore`, so it
        // is only packed when it is actually there.
        addFileToTar(pack, "tests/fixtures/mock-agent-tui.sh", { mode: 0o755, optional: true });

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
          .update(schema.agentBlueprints)
          .set({
            imageBuildStatus: "built",
            lastBuiltAt: new Date(),
            imageBuildLog: output,
            // Record what was built. The tag was computed above and then
            // dropped, so a blueprint could report `built` while `image` stayed
            // null — and `buildAgentSpec` resolves an agent's image as
            // `agent.containerImage || blueprint.image || ""`, so every agent
            // spawned from it failed on an empty image. A successful build that
            // nothing can be launched from is not a successful build.
            image: tag,
            updatedAt: new Date(),
          })
          .where(eq(schema.agentBlueprints.id, configId));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.agentBlueprints)
          .set({
            imageBuildStatus: "failed",
            imageBuildLog: errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(schema.agentBlueprints.id, configId));
      }
    })();

    return c.json({ status: "building" });
  })

  // ---------------------------------------------------------------------------
  // Get Agent Build Status
  // ---------------------------------------------------------------------------
  .get("/blueprints/:id/build-status", authMiddleware, async (c) => {
    const id = c.req.param("id");

    const rows = await db
      .select({
        imageBuildStatus: schema.agentBlueprints.imageBuildStatus,
        imageBuildLog: schema.agentBlueprints.imageBuildLog,
        lastBuiltAt: schema.agentBlueprints.lastBuiltAt,
      })
      .from(schema.agentBlueprints)
      .where(eq(schema.agentBlueprints.id, id))
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
  // System Info (admin only)
  // ---------------------------------------------------------------------------
  .get("/system", adminMiddleware, async (c) => {
    const cpus = os.cpus();
    let diskTotal = 0;
    let diskFree = 0;
    try {
      const stats = fs.statfsSync("/");
      diskTotal = stats.bsize * stats.blocks;
      diskFree = stats.bsize * stats.bavail;
    } catch {
      // statfs not available
    }

    return c.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      loadAvg: os.loadavg() as [number, number, number],
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? "Unknown",
      memTotal: os.totalmem(),
      memFree: os.freemem(),
      diskTotal,
      diskFree,
    });
  })

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

        // Enrich with agent info from DB
        const agentIds = containers
          .map((ct) => ct.Labels?.["blackhouse.agent_id"])
          .filter(Boolean) as string[];

        // Explicit column list, not `select()`: the agents row carries
        // `agentToken`, the bearer credential the container authenticates
        // with. A `select *` here would publish it in an admin API response.
        const agentsMap = new Map<string, AgentContainerInfo>();

        if (agentIds.length > 0) {
          const rows = await db
            .select({
              id: schema.agents.id,
              handle: schema.agents.handle,
              displayName: schema.agents.displayName,
              status: schema.agents.status,
              activity: schema.agents.activity,
              statusLine: schema.agents.statusLine,
              runtimeUsed: schema.agents.runtimeUsed,
            })
            .from(schema.agents)
            .where(inArray(schema.agents.id, agentIds));

          for (const row of rows) {
            agentsMap.set(row.id, row);
          }
        }

        const allItems = containers.map((ct) => {
          const agentId = ct.Labels?.["blackhouse.agent_id"];
          return {
            containerId: ct.Id,
            image: ct.Image,
            state: ct.State,
            status: ct.Status,
            created: ct.Created,
            agentId,
            agent: agentId ? (agentsMap.get(agentId) ?? null) : null,
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
      const configs = await db.select().from(schema.agentBlueprints);
      const managedNames = new Set<string>();
      for (const cfg of configs) {
        if (Array.isArray(cfg.volumeMounts)) {
          for (const m of cfg.volumeMounts as Array<{ name: string; mountPath: string }>) {
            if (m.name) managedNames.add(m.name);
          }
        }
      }

      // Per-agent workspace and state volumes. These are derived from the
      // agent id rather than stored, so the naming here must stay in step with
      // `workspaceVolumeName`/`stateVolumeName` in `server/agents/lifecycle.ts`
      // — otherwise live volumes would show up as unmanaged and be offered for
      // deletion while an agent is still using them.
      const agentRows = await db
        .select({
          workspaceVolume: schema.agents.workspaceVolume,
          stateVolume: schema.agents.stateVolume,
        })
        .from(schema.agents);

      for (const a of agentRows) {
        if (a.workspaceVolume) managedNames.add(a.workspaceVolume);
        if (a.stateVolume) managedNames.add(a.stateVolume);
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

  .delete("/volumes/:name", adminMiddleware, async (c) => {
    const volumeName = c.req.param("name");
    try {
      const docker = await getDockerClient();
      await docker.getVolume(volumeName).remove();
      return c.json({ success: true });
    } catch (err) {
      return c.json(
        { error: `Failed to delete volume: ${err instanceof Error ? err.message : String(err)}` },
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
