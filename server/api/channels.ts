import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authMiddleware, type AuthEnv } from "../middleware/auth.js";
import { parseMentions } from "../lib/mentions.js";
import { streamBus } from "../lib/stream-bus.js";
import { deliverRun } from "../agents/queue.js";

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase letters, digits or -");

const createChannelSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120).optional(),
  topic: z.string().max(500).optional().nullable(),
  isPrivate: z.boolean().optional(),
  gitRepoUrl: z.string().url().optional().nullable(),
  gitBranch: z.string().max(200).optional().nullable(),
});

const postMessageSchema = z.object({
  body: z.string().min(1).max(20_000),
  mode: z.enum(["queue", "interrupt"]).default("queue"),
  requestId: z.string().max(200).optional(),
});

const DEFAULT_PAGE = 50;

async function channelBySlugOrId(key: string) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const [row] = await db
    .select()
    .from(schema.channels)
    .where(isUuid ? eq(schema.channels.id, key) : eq(schema.channels.slug, key))
    .limit(1);
  return row ?? null;
}

const app = new Hono<AuthEnv>()

  .get("/", authMiddleware, async (c) => {
    const rows = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.isArchived, false))
      .orderBy(schema.channels.slug);
    return c.json(rows);
  })

  .post("/", authMiddleware, async (c) => {
    const parsed = createChannelSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    }
    const input = parsed.data;

    const [existing] = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, input.slug))
      .limit(1);
    if (existing) return c.json({ error: `#${input.slug} already exists` }, 409);

    const [created] = await db
      .insert(schema.channels)
      .values({
        slug: input.slug,
        name: input.name ?? input.slug,
        topic: input.topic ?? null,
        isPrivate: input.isPrivate ?? false,
        gitRepoUrl: input.gitRepoUrl ?? null,
        gitBranch: input.gitBranch ?? null,
        createdBy: c.get("session").user.id,
      })
      .returning();

    return c.json(created, 201);
  })

  .get("/:key", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const members = await db
      .select({
        id: schema.channelMembers.id,
        role: schema.channelMembers.role,
        userId: schema.channelMembers.userId,
        agentId: schema.channelMembers.agentId,
      })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channel.id));

    return c.json({ ...channel, members });
  })

  /**
   * Toggle the channel's auto-approve ("yolo") switch.
   *
   * Flipping this disables the only human gate on agent→agent dispatch for the
   * whole channel, so the change is written into the transcript as a system
   * message. A silent toggle would leave no record of when the room stopped
   * asking — which is exactly the question you want answered afterwards.
   */
  .put("/:key/auto-approve", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const parsed = z
      .object({ enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid input" }, 400);

    const [updated] = await db
      .update(schema.channels)
      .set({ autoApproveDispatch: parsed.data.enabled, updatedAt: new Date() })
      .where(eq(schema.channels.id, channel.id))
      .returning();

    const actor = c.get("session").user;
    const [systemMessage] = await db
      .insert(schema.messages)
      .values({
        channelId: channel.id,
        authorKind: "system",
        kind: "system",
        body: parsed.data.enabled
          ? `${actor.name} turned auto-approve ON — agents in this channel now dispatch each other with no hold.`
          : `${actor.name} turned auto-approve OFF — agent dispatches need approval again.`,
      })
      .returning();

    streamBus.emit(`channel:${channel.id}`, {
      type: "message.created",
      channelId: channel.id,
      messageId: systemMessage.id,
    });

    return c.json(updated);
  })

  .post("/:key/members", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const parsed = z
      .object({ agentId: z.string().uuid().optional(), userId: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || (!parsed.data.agentId && !parsed.data.userId)) {
      return c.json({ error: "Provide exactly one of agentId or userId" }, 400);
    }
    if (parsed.data.agentId && parsed.data.userId) {
      return c.json({ error: "Provide exactly one of agentId or userId" }, 400);
    }

    const [member] = await db
      .insert(schema.channelMembers)
      .values({
        channelId: channel.id,
        agentId: parsed.data.agentId ?? null,
        userId: parsed.data.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();

    return c.json(member ?? { ok: true }, 201);
  })

  /**
   * Keyset-paginated transcript, newest first.
   *
   * Offset pagination double-renders rows in a live channel: anything appended
   * while you are scrolling shifts every subsequent offset by one. The cursor
   * is `(createdAt, id)` because `createdAt` alone is not unique — a burst of
   * sidecar events can land in the same millisecond.
   */
  .get("/:key/messages", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const limit = Math.min(Number(c.req.query("limit") ?? DEFAULT_PAGE) || DEFAULT_PAGE, 200);
    const before = c.req.query("before");

    let cursor: { createdAt: Date; id: string } | null = null;
    if (before) {
      const [rawDate, rawId] = before.split(",");
      const parsedDate = new Date(rawDate);
      if (!Number.isNaN(parsedDate.getTime()) && rawId) {
        cursor = { createdAt: parsedDate, id: rawId };
      }
    }

    const rows = await db
      .select()
      .from(schema.messages)
      .where(
        cursor
          ? and(
              eq(schema.messages.channelId, channel.id),
              or(
                lt(schema.messages.createdAt, cursor.createdAt),
                and(
                  eq(schema.messages.createdAt, cursor.createdAt),
                  lt(schema.messages.id, cursor.id),
                ),
              ),
            )
          : eq(schema.messages.channelId, channel.id),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return c.json({
      messages: page,
      hasMore,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()},${last.id}` : null,
    });
  })

  /**
   * Post a message, and route any `@mentions` to their agents.
   *
   * A mention becomes a `run`, and the run's prompt is written onto the
   * agent's live PTY. `queue` parks the run when the agent is busy rather than
   * interleaving with a turn in progress; `interrupt` sends the adapter's
   * interrupt key first and accepts that in-flight work is lost.
   */
  .post("/:key/messages", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const parsed = postMessageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    }
    const { body, mode, requestId } = parsed.data;
    const user = c.get("session").user;

    const parsedMentions = parseMentions(body);
    const handles = parsedMentions.map((m) => m.handle);

    const mentionedAgents = handles.length
      ? await db.select().from(schema.agents).where(inArray(schema.agents.handle, handles))
      : [];

    const [message] = await db
      .insert(schema.messages)
      .values({
        channelId: channel.id,
        authorKind: "user",
        authorUserId: user.id,
        kind: "text",
        body,
        mentions: mentionedAgents.map((a) => a.id),
        requestId: requestId ?? null,
      })
      .returning();

    if (mentionedAgents.length) {
      await db.insert(schema.messageMentions).values(
        mentionedAgents.map((agent) => ({
          messageId: message.id,
          agentId: agent.id,
        })),
      );
    }

    streamBus.emit(`channel:${channel.id}`, {
      type: "message.created",
      channelId: channel.id,
      messageId: message.id,
    });

    const dispatched: Array<{ agentId: string; runId: string; queued: boolean; reason?: string }> =
      [];

    for (const agent of mentionedAgents) {
      const outcome = await routeMention({
        agent,
        channelId: channel.id,
        triggerMessageId: message.id,
        prompt: body,
        mode,
        requestedByUserId: user.id,
      });
      dispatched.push(outcome);
    }

    return c.json({ message, dispatched }, 201);
  });

type AgentRow = typeof schema.agents.$inferSelect;

/** Create the run for a mention and deliver it, or park it if the agent is busy. */
async function routeMention(input: {
  agent: AgentRow;
  channelId: string;
  /** The message that caused this run — a human post, or an approved dispatch card. */
  triggerMessageId?: string | null;
  prompt: string;
  mode: "queue" | "interrupt";
  /** Set when a human mentioned the agent, or approved a dispatch to it. */
  requestedByUserId?: string | null;
  /** Set when another agent originated the request. */
  requestedByAgentId?: string | null;
}): Promise<{ agentId: string; runId: string; queued: boolean; reason?: string }> {
  const {
    agent,
    channelId,
    triggerMessageId,
    prompt,
    mode,
    requestedByUserId,
    requestedByAgentId,
  } = input;

  const notDeliverable =
    agent.status !== "running" || !agent.containerId
      ? "Agent is not running"
      : agent.pausedAt
        ? "Agent is paused — daily budget cap reached"
        : null;

  const shouldQueue =
    notDeliverable !== null || (mode === "queue" && agent.activity === "busy") ? true : false;

  const [run] = await db
    .insert(schema.runs)
    .values({
      agentId: agent.id,
      channelId,
      triggerMessageId: triggerMessageId ?? null,
      requesterUserId: requestedByUserId ?? null,
      requesterAgentId: requestedByAgentId ?? null,
      prompt,
      injectionMode: mode,
      status: shouldQueue ? "queued" : "injecting",
    })
    .returning();

  streamBus.emitAll([`channel:${channelId}`, `agent:${agent.id}`], {
    type: "run.updated",
    agentId: agent.id,
    runId: run.id,
    status: run.status,
  });

  if (shouldQueue) {
    return {
      agentId: agent.id,
      runId: run.id,
      queued: true,
      reason: notDeliverable ?? `@${agent.handle} is busy — delivers when idle`,
    };
  }

  try {
    // Same path a queued run takes when the drainer releases it, so the two
    // cannot drift — notably the per-CLI injection timing.
    await deliverRun(agent, run);
    return { agentId: agent.id, runId: run.id, queued: false };
  } catch (err) {
    await db
      .update(schema.runs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.runs.id, run.id));

    return {
      agentId: agent.id,
      runId: run.id,
      queued: false,
      reason: `Injection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export default app;
export { routeMention };
