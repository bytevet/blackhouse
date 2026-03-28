import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { getDockerClient, resetDockerClient } from "@/lib/docker";
import { requireSession, requireAdmin } from "@/lib/auth-server";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const updateProfile = createServerFn({ method: "POST" })
  .inputValidator((input: { name?: string; password?: string; currentPassword?: string; newPassword?: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateData.name = data.name;

    if (Object.keys(updateData).length > 1) {
      await db
        .update(schema.user)
        .set(updateData)
        .where(eq(schema.user.id, session.user.id));
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

export const listAgentConfigs = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSession();

    return db
      .select()
      .from(schema.agentConfigs)
      .orderBy(desc(schema.agentConfigs.createdAt));
  },
);

export const upsertAgentConfig = createServerFn({ method: "POST" })
  .inputValidator((input: {
      id?: string;
      agentType: string;
      displayName: string;
      apiKeyEncrypted?: string;
      apiKey?: string;
      yoloMode?: boolean;
      defaultModel?: string;
      extraArgs?: unknown;
      dockerImage?: string;
    }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

    const values = {
      agentType: data.agentType,
      displayName: data.displayName,
      apiKeyEncrypted: data.apiKeyEncrypted ?? data.apiKey ?? null,
      yoloMode: data.yoloMode ?? true,
      defaultModel: data.defaultModel ?? null,
      extraArgs: data.extraArgs ?? null,
      dockerImage: data.dockerImage,
      updatedAt: new Date(),
    };

    if (data.id) {
      // Update existing
      const updated = await db
        .update(schema.agentConfigs)
        .set(values)
        .where(eq(schema.agentConfigs.id, data.id))
        .returning();

      if (updated.length === 0) throw new Error("Agent config not found");
      return updated[0];
    }

    // Create new
    const inserted = await db
      .insert(schema.agentConfigs)
      .values(values)
      .returning();

    return inserted[0];
  });

export const deleteAgentConfig = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

    await db
      .delete(schema.agentConfigs)
      .where(eq(schema.agentConfigs.id, data.id));

    return { success: true };
  });

// ---------------------------------------------------------------------------
// Docker Config (admin only)
// ---------------------------------------------------------------------------

export const getDockerConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireSession();
    requireAdmin(session);

    const rows = await db
      .select()
      .from(schema.dockerConfigs)
      .limit(1);

    return rows[0] ?? null;
  },
);

export const updateDockerConfig = createServerFn({ method: "POST" })
  .inputValidator((input: {
      socketPath?: string;
      host?: string;
      port?: number;
      tlsCa?: string;
      tlsCert?: string;
      tlsKey?: string;
    }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

    // Upsert with id=1 (singleton row)
    const existing = await db
      .select()
      .from(schema.dockerConfigs)
      .limit(1);

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

export const getDockerStatus = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireSession();
    requireAdmin(session);

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
  },
);

// ---------------------------------------------------------------------------
// List Containers (admin only)
// ---------------------------------------------------------------------------

export const listContainers = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireSession();
    requireAdmin(session);

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
          session: sessionId ? sessionsMap.get(sessionId) ?? null : null,
        };
      });
    } catch (err) {
      throw new Error(
        `Failed to list containers: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// User Management (admin only)
// ---------------------------------------------------------------------------

export const listUsers = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await requireSession();
    requireAdmin(session);

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
  },
);

export const createUser = createServerFn({ method: "POST" })
  .inputValidator((input: {
      name: string;
      email: string;
      username?: string;
      password: string;
      role?: string;
    }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

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
  .inputValidator((input: { id?: string; userId?: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

    const targetId = data.id ?? data.userId;
    if (!targetId) throw new Error("Missing user id");

    if (targetId === session.user.id) {
      throw new Error("Cannot delete your own account");
    }

    await db.delete(schema.user).where(eq(schema.user.id, targetId));

    return { success: true };
  });

export const updateUserRole = createServerFn({ method: "POST" })
  .inputValidator((input: { id?: string; userId?: string; role: string }) => input)
  .handler(async ({ data }) => {
    const session = await requireSession();
    requireAdmin(session);

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
