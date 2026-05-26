import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  eq,
  desc,
  count,
  and,
  inArray,
  isNotNull,
  isNull,
  ne,
  gte,
  sql,
  getTableColumns,
  type SQL,
} from "drizzle-orm";
import { getDockerClient } from "../lib/docker.js";
import type { AuthEnv } from "../middleware/auth.js";
import { authMiddleware } from "../middleware/auth.js";
import { paginationQuery } from "../lib/pagination.js";
import { requireSessionAccess, handleSessionAccessError } from "../lib/session.js";
import { authSessionToken, authMessagingFromTo } from "../lib/session-token-auth.js";
import { checkRateLimit } from "../lib/messaging-rate-limit.js";
import { inboxEvents } from "../lib/inbox-events.js";

/** Session columns without the potentially-large resultHtml blob. */
const { resultHtml: _resultHtml, ...sessionColumns } = getTableColumns(schema.codingSessions);
const sessionSummary = {
  ...sessionColumns,
  hasResult: sql<boolean>`${schema.codingSessions.resultHtml} is not null`.as("has_result"),
  // Correlated subquery — one extra index lookup per row, batched
  // server-side rather than N+1 from the client. Uses the partial
  // idx_messages_inbox index so the scan is cheap even with millions
  // of acked messages in history.
  unreadCount: sql<number>`(
    SELECT COUNT(*)::int
    FROM ${schema.sessionMessages}
    WHERE ${schema.sessionMessages.toSessionId} = ${schema.codingSessions.id}
      AND ${schema.sessionMessages.status} = 'pending'
      AND ${schema.sessionMessages.ackAt} IS NULL
  )`.as("unread_count"),
};

/**
 * Strip resultHtml from a raw DB row and add hasResult + unreadCount.
 * Used by the single-session GET path where we haven't computed unread
 * server-side yet (the create/restart/stop flows return the full row);
 * unreadCount defaults to 0 there because a fresh session has no inbox.
 */
function toSessionSummary<T extends { resultHtml?: string | null }>({ resultHtml, ...rest }: T) {
  return { ...rest, hasResult: resultHtml != null, unreadCount: 0 };
}

const app = new Hono<AuthEnv>()
  .onError(handleSessionAccessError)
  // ---------------------------------------------------------------------------
  // GET /api/sessions — list sessions
  // ---------------------------------------------------------------------------
  .get(
    "/",
    authMiddleware,
    zValidator(
      "query",
      z
        .object({
          all: z.coerce.boolean().optional(),
          status: z.enum(["pending", "running", "stopped", "destroyed"]).optional(),
          hasResult: z.coerce.boolean().optional(),
          agent: z.string().optional(),
          templateId: z.string().optional(),
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

      // Build filter conditions
      const filters: SQL[] = [];
      if (query?.status) filters.push(eq(schema.codingSessions.status, query.status));
      if (query?.hasResult === true) filters.push(isNotNull(schema.codingSessions.resultHtml));
      if (query?.hasResult === false) filters.push(isNull(schema.codingSessions.resultHtml));
      if (query?.agent) filters.push(eq(schema.codingSessions.agentConfigId, query.agent));
      if (query?.templateId) filters.push(eq(schema.codingSessions.templateId, query.templateId));

      if (query?.all && session.user.role === "admin") {
        const where = filters.length > 0 ? and(...filters) : undefined;

        const [{ total }] = await db
          .select({ total: count() })
          .from(schema.codingSessions)
          .where(where);

        const rows = await db
          .select({
            ...sessionSummary,
            userName: schema.user.name,
            userEmail: schema.user.email,
          })
          .from(schema.codingSessions)
          .leftJoin(schema.user, eq(schema.codingSessions.userId, schema.user.id))
          .where(where)
          .orderBy(desc(schema.codingSessions.createdAt))
          .limit(perPage)
          .offset(offset);

        return c.json({
          data: rows.map(({ userName, userEmail, ...s }) => ({
            ...s,
            user: { name: userName, email: userEmail },
          })),
          total,
          page,
          perPage,
        });
      }

      const ownerFilter = eq(schema.codingSessions.userId, session.user.id);
      const where = filters.length > 0 ? and(ownerFilter, ...filters) : ownerFilter;

      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.codingSessions)
        .where(where);

      const rows = await db
        .select(sessionSummary)
        .from(schema.codingSessions)
        .where(where)
        .orderBy(desc(schema.codingSessions.createdAt))
        .limit(perPage)
        .offset(offset);

      return c.json({ data: rows, total, page, perPage });
    },
  )

  // ---------------------------------------------------------------------------
  // GET /api/sessions/:id — get single session
  // ---------------------------------------------------------------------------
  .get("/:id", authMiddleware, async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");

    const [codingSession] = await db
      .select(sessionSummary)
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
  })

  // ---------------------------------------------------------------------------
  // POST /api/sessions — create session
  // ---------------------------------------------------------------------------
  .post(
    "/",
    authMiddleware,
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
        "COLORTERM=truecolor",
        "LANG=en_US.UTF-8",
        "LC_ALL=en_US.UTF-8",
        "EDITOR=vi",
        `SESSION_ID=${codingSession.id}`,
        `SESSION_NAME=${data.name}`,
        `BLACKHOUSE_URL=${process.env.BLACKHOUSE_CONTAINER_URL || "http://host.docker.internal:3000"}`,
        `SESSION_TOKEN=${sessionToken}`,
      ];

      if (data.gitRepoUrl) {
        env.push(`GIT_REPO_URL=${data.gitRepoUrl}`);
        if (data.gitBranch) env.push(`GIT_BRANCH=${data.gitBranch}`);
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

      // Build volume mounts (Binds) from agent config + template
      const binds: string[] = [];
      if (Array.isArray(agentConfig.volumeMounts)) {
        for (const mount of agentConfig.volumeMounts as Array<{
          name: string;
          mountPath: string;
        }>) {
          binds.push(`${mount.name}:${mount.mountPath}`);
        }
      }

      // Template volumes — namespaced under template owner's username
      if (template && Array.isArray(template.volumeMounts)) {
        const [templateOwner] = await db
          .select({ username: schema.user.username, id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.id, template.userId))
          .limit(1);
        const ownerPrefix = templateOwner?.username ?? templateOwner?.id ?? "unknown";
        for (const mount of template.volumeMounts as Array<{ name: string; mountPath: string }>) {
          binds.push(`${ownerPrefix}-${mount.name}:${mount.mountPath}`);
        }
      }

      try {
        const docker = await getDockerClient();
        const blackhouseNetwork = process.env.BLACKHOUSE_NETWORK;

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
          // Expose the in-container services so the Blackhouse server can
          // proxy them to the React SPA:
          //   9223 — browser-service (Playwright screencast + control)
          //   8443 — code-server (IDE)
          // Reachability is decided by whether `BLACKHOUSE_NETWORK` is set
          // (see `getContainerEndpoint` in `server/lib/docker.ts`):
          //
          // - Set: Blackhouse runs inside its own container; the agent
          //   attaches to the same Docker network and we reach it by its
          //   IP on that network + the internal port. No host port mapping.
          //
          // - Unset: local-dev path. Blackhouse runs on the host; agent
          //   binds to the host's `127.0.0.1:<ephemeral>`, constrained to
          //   the loopback so the services aren't exposed on the LAN.
          ExposedPorts: {
            "9223/tcp": {},
            "8443/tcp": {},
          },
          NetworkingConfig: blackhouseNetwork
            ? { EndpointsConfig: { [blackhouseNetwork]: {} } }
            : undefined,
          HostConfig: {
            Memory: 2 * 1024 * 1024 * 1024, // 2GB
            NanoCpus: 2_000_000_000, // 2 CPUs
            Binds: binds.length > 0 ? binds : undefined,
            ExtraHosts: ["host.docker.internal:host-gateway"],
            PortBindings: blackhouseNetwork
              ? undefined
              : {
                  "9223/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
                  "8443/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
                },
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

        return c.json(toSessionSummary(updated[0]));
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
  )

  // ---------------------------------------------------------------------------
  // PUT /api/sessions/:id/stop
  // ---------------------------------------------------------------------------
  .put("/:id/stop", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const codingSession = await requireSessionAccess(id, c.get("session").user);

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

    return c.json(toSessionSummary(updated[0]));
  })

  // ---------------------------------------------------------------------------
  // DELETE /api/sessions/:id — destroy session + container
  // ---------------------------------------------------------------------------
  .delete("/:id", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const codingSession = await requireSessionAccess(id, c.get("session").user);

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
  })

  // ---------------------------------------------------------------------------
  // PUT /api/sessions/:id/restart
  // ---------------------------------------------------------------------------
  .put("/:id/restart", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const codingSession = await requireSessionAccess(id, c.get("session").user);

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
          {
            error: "Container no longer exists. Please destroy this session and create a new one.",
          },
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
        {
          error: `Failed to restart container: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }

    const updated = await db
      .update(schema.codingSessions)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, id))
      .returning();

    return c.json(toSessionSummary(updated[0]));
  })

  // ---------------------------------------------------------------------------
  // GET /api/sessions/:id/recreate-params
  // ---------------------------------------------------------------------------
  .get("/:id/recreate-params", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const original = await requireSessionAccess(id, c.get("session").user);

    return c.json({
      name: original.name,
      gitRepoUrl: original.gitRepoUrl,
      gitBranch: original.gitBranch,
      templateId: original.templateId,
      agentConfigId: original.agentConfigId,
      preset: original.preset,
    });
  })

  // ---------------------------------------------------------------------------
  // GET /api/sessions/:id/results/latest — serve raw result HTML with CSP
  // ---------------------------------------------------------------------------
  .get("/:id/results/latest", authMiddleware, async (c) => {
    const id = c.req.param("id");
    const codingSession = await requireSessionAccess(id, c.get("session").user);
    if (!codingSession.resultHtml) return c.text("No result", 404);

    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline' *; img-src * data: blob:; font-src * data:; script-src 'unsafe-inline' * blob:; connect-src 'none'; form-action 'none'; frame-src 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    return c.html(codingSession.resultHtml);
  })

  // ---------------------------------------------------------------------------
  // DELETE /api/sessions/:id/result
  // ---------------------------------------------------------------------------
  .delete("/:id/result", authMiddleware, async (c) => {
    const id = c.req.param("id");
    await requireSessionAccess(id, c.get("session").user);

    await db
      .update(schema.codingSessions)
      .set({ resultHtml: null, updatedAt: new Date() })
      .where(eq(schema.codingSessions.id, id));

    return c.json({ success: true });
  })

  // ---------------------------------------------------------------------------
  // Inter-session messaging — all six endpoints below authenticate with the
  // per-session token in the Authorization header (Bearer scheme) or a
  // `token` query param. These are called from inside the agent container
  // by the messaging shell scripts (send-msg.sh / check-inbox.sh /
  // list-sessions.sh) and by the sidecar daemon, so the Better Auth cookie
  // isn't available. authSessionToken / authMessagingFromTo wrap the
  // lookup + validation.
  // ---------------------------------------------------------------------------

  // POST /api/sessions/:id/send-message — send to another session
  .post(
    "/:id/send-message",
    zValidator(
      "json",
      z.object({
        target_session_id: z.string().uuid(),
        // Cap at 100 KB. The DB column is unbounded text but a runaway
        // payload here would just waste budget — agents send short
        // coordination messages, not blobs.
        message: z.string().min(1).max(100_000),
        request_id: z.string().max(128).optional(),
      }),
    ),
    async (c) => {
      const fromSessionId = c.req.param("id");
      const token = bearerOrQueryToken(c);
      const { target_session_id, message, request_id } = c.req.valid("json");

      const auth = await authMessagingFromTo(fromSessionId, token, target_session_id);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);

      // Rate-limit gate. Per-session and per-user buckets — see
      // server/lib/messaging-rate-limit.ts for sizing.
      const rl = checkRateLimit(fromSessionId, auth.from.userId);
      if (!rl.ok) {
        c.header("Retry-After", String(rl.retryAfterSec));
        return c.json({ error: "Rate limit exceeded", retry_after_sec: rl.retryAfterSec }, 429);
      }

      // 60-second dedup window. If the same (from_session_id, request_id)
      // exists, return the existing message_id without re-inserting.
      // Idempotent retries from send-msg.sh's --wait poller land here.
      if (request_id) {
        const dedupCutoff = new Date(Date.now() - 60_000);
        const [existing] = await db
          .select({ id: schema.sessionMessages.id, createdAt: schema.sessionMessages.createdAt })
          .from(schema.sessionMessages)
          .where(
            and(
              eq(schema.sessionMessages.fromSessionId, fromSessionId),
              eq(schema.sessionMessages.requestId, request_id),
              gte(schema.sessionMessages.createdAt, dedupCutoff),
            ),
          )
          .limit(1);
        if (existing) {
          const unread = await unreadCountFor(target_session_id);
          return c.json({
            message_id: existing.id,
            queued_at: existing.createdAt,
            target_unread_count: unread,
            deduplicated: true,
          });
        }
      }

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [inserted] = await db
        .insert(schema.sessionMessages)
        .values({
          fromSessionId,
          toSessionId: target_session_id,
          message,
          requestId: request_id ?? null,
          expiresAt,
        })
        .returning({ id: schema.sessionMessages.id, createdAt: schema.sessionMessages.createdAt });

      const unread = await unreadCountFor(target_session_id);

      // SSE fan-out — lands in commit 6. Decoupled via a tiny event-bus
      // module so the messaging endpoints don't depend on the SSE
      // route's lifecycle.

      inboxEvents.emit(auth.to.userId, {
        type: "unread-changed",
        sessionId: target_session_id,
        unreadCount: unread,
      });

      return c.json({
        message_id: inserted.id,
        queued_at: inserted.createdAt,
        target_unread_count: unread,
      });
    },
  )

  // GET /api/sessions/:id/inbox?unread=true&reply_to=...&limit=N — fetch
  // pending messages. Sets delivered_at on returned rows (observability
  // only; never flips status or ack_at).
  .get(
    "/:id/inbox",
    zValidator(
      "query",
      z.object({
        unread: z.coerce.boolean().optional(),
        reply_to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    ),
    async (c) => {
      const sessionId = c.req.param("id");
      const token = bearerOrQueryToken(c);
      const { unread, reply_to, limit } = c.req.valid("query");

      const auth = await authSessionToken(sessionId, token);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);

      const cap = limit ?? 50;
      const filters: SQL[] = [eq(schema.sessionMessages.toSessionId, sessionId)];
      // `unread=true` AND `unread` omitted both filter to pending+unacked
      // (default = "give me my inbox"). Explicit `unread=false` returns
      // all non-expired messages, which only makes sense for debugging.
      if (unread !== false) {
        filters.push(eq(schema.sessionMessages.status, "pending"));
        filters.push(isNull(schema.sessionMessages.ackAt));
      }
      // reply_to filters by the request_id of the original outbound
      // message — used by send-msg.sh --wait to poll for replies that
      // reference its request_id.
      if (reply_to) filters.push(eq(schema.sessionMessages.requestId, reply_to));

      const rows = await db
        .select()
        .from(schema.sessionMessages)
        .where(and(...filters))
        .orderBy(desc(schema.sessionMessages.createdAt))
        .limit(cap);

      // Stamp delivered_at on the rows we just handed out, only if it
      // wasn't already set. Pure observability — does NOT flip status
      // or ack_at. Run async-but-await so the response and the stamp
      // don't race with a follow-up /inbox call.
      const toStamp = rows.filter((r) => r.deliveredAt == null).map((r) => r.id);
      if (toStamp.length > 0) {
        await db
          .update(schema.sessionMessages)
          .set({ deliveredAt: new Date() })
          .where(
            and(
              inArray(schema.sessionMessages.id, toStamp),
              isNull(schema.sessionMessages.deliveredAt),
            ),
          );
      }

      return c.json({ messages: rows });
    },
  )

  // GET /api/sessions/:id/inbox/count — fast-path count for the sidecar
  // daemon (5s cadence). Uses the partial index directly.
  .get("/:id/inbox/count", async (c) => {
    const sessionId = c.req.param("id");
    const token = bearerOrQueryToken(c);
    const auth = await authSessionToken(sessionId, token);
    if ("error" in auth) return c.json({ error: auth.error }, auth.status);

    const unread = await unreadCountFor(sessionId);
    return c.json({ unread });
  })

  // PUT /api/sessions/:id/messages/:msgId/ack — single-message ack.
  // Idempotent: a second ack on the same id returns already_acked=true.
  .put("/:id/messages/:msgId/ack", async (c) => {
    const sessionId = c.req.param("id");
    const msgId = c.req.param("msgId");
    const token = bearerOrQueryToken(c);
    const auth = await authSessionToken(sessionId, token);
    if ("error" in auth) return c.json({ error: auth.error }, auth.status);

    const now = new Date();
    const updated = await db
      .update(schema.sessionMessages)
      .set({ ackAt: now })
      .where(
        and(
          eq(schema.sessionMessages.id, msgId),
          eq(schema.sessionMessages.toSessionId, sessionId),
          isNull(schema.sessionMessages.ackAt),
        ),
      )
      .returning({ id: schema.sessionMessages.id });

    if (updated.length === 0) {
      // Either the message doesn't exist for this session OR it was
      // already acked. Distinguish so the client can decide whether to
      // retry. Idempotent for retry-after-network-blip.
      const [existing] = await db
        .select({ ackAt: schema.sessionMessages.ackAt })
        .from(schema.sessionMessages)
        .where(
          and(
            eq(schema.sessionMessages.id, msgId),
            eq(schema.sessionMessages.toSessionId, sessionId),
          ),
        )
        .limit(1);
      if (!existing) return c.json({ error: "Message not found" }, 404);
      return c.json({ ok: true, already_acked: true, ack_at: existing.ackAt });
    }

    const unread = await unreadCountFor(sessionId);
    const { inboxEvents } = await import("../lib/inbox-events.js");
    inboxEvents.emit(auth.session.userId, {
      type: "unread-changed",
      sessionId,
      unreadCount: unread,
    });

    return c.json({ ok: true, ack_at: now });
  })

  // PUT /api/sessions/:id/messages/ack-batch — batch ack from
  // check-inbox.sh --ack-all. The `to_session_id = $1` clause in the
  // WHERE is load-bearing security: prevents a session from acking
  // another session's messages even if it guesses the UUIDs.
  .put(
    "/:id/messages/ack-batch",
    zValidator("json", z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) })),
    async (c) => {
      const sessionId = c.req.param("id");
      const { ids } = c.req.valid("json");
      const token = bearerOrQueryToken(c);
      const auth = await authSessionToken(sessionId, token);
      if ("error" in auth) return c.json({ error: auth.error }, auth.status);

      const now = new Date();
      const updated = await db
        .update(schema.sessionMessages)
        .set({ ackAt: now })
        .where(
          and(
            eq(schema.sessionMessages.toSessionId, sessionId),
            inArray(schema.sessionMessages.id, ids),
            isNull(schema.sessionMessages.ackAt),
          ),
        )
        .returning({ id: schema.sessionMessages.id });

      const unread = await unreadCountFor(sessionId);

      inboxEvents.emit(auth.session.userId, {
        type: "unread-changed",
        sessionId,
        unreadCount: unread,
      });

      return c.json({ acked: updated.length, ack_at: now });
    },
  )

  // GET /api/sessions/list-mine — sender discovery. Returns all
  // non-destroyed sessions belonging to the authenticated session's user.
  // Auth via the token's owning user — admins viewing other users' work
  // don't pivot through this endpoint, they use the existing /?all=true.
  //
  // NOTE: This route is intentionally `/list-mine` not `/:id/list-mine`
  // because the answer is user-scoped, not session-scoped. The token
  // resolves the user via its owning session — no `:id` needed in the
  // URL, just the token. Hono dispatches in order, so this MUST be
  // declared via a static path BEFORE any `/:id/...` matcher could
  // catch it — guarded here by carrying its own check.
  .get("/list-mine", async (c) => {
    const token = bearerOrQueryToken(c);
    if (!token) return c.json({ error: "Invalid token" }, 403);

    // Find the session owning this token, then list all sessions for
    // its user. One round trip via a self-join.
    const [owningSession] = await db
      .select({ userId: schema.codingSessions.userId })
      .from(schema.codingSessions)
      .where(eq(schema.codingSessions.sessionToken, token))
      .limit(1);
    if (!owningSession) return c.json({ error: "Invalid token" }, 403);

    const rows = await db
      .select({
        id: schema.codingSessions.id,
        name: schema.codingSessions.name,
        status: schema.codingSessions.status,
        preset: schema.codingSessions.preset,
        agentTitle: schema.codingSessions.agentTitle,
      })
      .from(schema.codingSessions)
      .where(
        and(
          eq(schema.codingSessions.userId, owningSession.userId),
          ne(schema.codingSessions.status, "destroyed"),
        ),
      )
      .orderBy(desc(schema.codingSessions.createdAt));

    return c.json({ sessions: rows });
  });

/** Extract the per-session token from Authorization: Bearer or ?token=. */
function bearerOrQueryToken(c: {
  req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined };
}): string | undefined {
  const h = c.req.header("authorization") ?? c.req.header("Authorization");
  if (h && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return c.req.query("token");
}

/** Count unread (pending + unacked) messages for a session. */
async function unreadCountFor(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.sessionMessages)
    .where(
      and(
        eq(schema.sessionMessages.toSessionId, sessionId),
        eq(schema.sessionMessages.status, "pending"),
        isNull(schema.sessionMessages.ackAt),
      ),
    );
  return Number(row?.n ?? 0);
}

export default app;
