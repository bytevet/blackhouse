import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authAgentToken, bearerToken } from "../lib/agent-token-auth.js";
import { streamBus } from "../lib/stream-bus.js";
import {
  ingestSchema,
  stateSchema,
  projectsToMessage,
  toolCallDisplay,
  usageCents,
  usageTokens,
  preview,
} from "../agents/events.js";
import { parseMentions } from "../lib/mentions.js";

type AgentRow = typeof schema.agents.$inferSelect;

/**
 * Endpoints called from *inside* agent containers — by the sidecar and by the
 * skill scripts. Authenticated with the per-agent bearer token rather than a
 * Better Auth cookie, which containers do not have.
 */
const app = new Hono();

/** Resolve the calling agent from its bearer token, or return a Response to send. */
async function callerAgent(c: Context): Promise<AgentRow | Response> {
  const agentId = c.req.header("X-Blackhouse-Agent");
  const token = bearerToken(c.req.header("Authorization"));
  if (!agentId) return c.json({ error: "Missing X-Blackhouse-Agent" }, 400);

  const result = await authAgentToken(agentId, token);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return result.agent;
}

const routes = app

  /**
   * Sidecar event ingest.
   *
   * Idempotent on `(agentId, sourceRef)` via `ON CONFLICT DO NOTHING`, so a
   * retry after a dropped response, a container restart, or a re-read of the
   * same log offset all collapse to one row. That is what lets the sidecar be
   * dumb about delivery guarantees — it can re-send freely.
   */
  .post("/events", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid events" }, 400);
    }

    // Which run to attribute these to: the agent's newest unfinished run.
    const [openRun] = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.agentId, agent.id), eq(schema.runs.status, "running")))
      .orderBy(sql`${schema.runs.queuedAt} DESC`)
      .limit(1);

    let accepted = 0;
    let costCents = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let toolCalls = 0;

    for (const ev of parsed.data.events) {
      const inserted = await db
        .insert(schema.agentEvents)
        .values({
          agentId: agent.id,
          runId: openRun?.id ?? null,
          seq: ev.seq,
          sourceRef: ev.sourceRef,
          type: ev.type,
          payload: ev.payload,
        })
        .onConflictDoNothing()
        .returning({ id: schema.agentEvents.id });

      // Nothing returned means we already had this event — skip the side
      // effects too, or a retry would double-count tokens and re-post messages.
      if (inserted.length === 0) continue;
      accepted += 1;

      if (ev.type === "usage") {
        costCents += usageCents(ev.payload);
        const tokens = usageTokens(ev.payload);
        tokensIn += tokens.in;
        tokensOut += tokens.out;
      }
      if (ev.type === "tool_use") toolCalls += 1;

      const projection = projectsToMessage(ev.type);
      if (projection && openRun?.channelId) {
        const body =
          ev.type === "assistant_text"
            ? preview(ev.payload.text ?? ev.payload.body ?? "", 20_000)
            : null;

        const metadata =
          ev.type === "tool_use"
            ? {
                ...toolCallDisplay(
                  String(ev.payload.toolName ?? ev.payload.name ?? "tool"),
                  (ev.payload.input as Record<string, unknown>) ?? {},
                  String(ev.payload.meta ?? ""),
                ),
                eventType: ev.type,
              }
            : { eventType: ev.type, ...ev.payload };

        const [message] = await db
          .insert(schema.messages)
          .values({
            channelId: openRun.channelId,
            authorKind: "agent",
            authorAgentId: agent.id,
            kind: projection,
            body,
            metadata,
            runId: openRun.id,
          })
          .returning();

        streamBus.emit(`channel:${openRun.channelId}`, {
          type: "message.created",
          channelId: openRun.channelId,
          messageId: message.id,
        });
      }

      if (ev.type === "turn_end" && openRun) {
        await db
          .update(schema.runs)
          .set({ status: "done", finishedAt: new Date() })
          .where(eq(schema.runs.id, openRun.id));
      }
    }

    if (openRun && (costCents || tokensIn || tokensOut || toolCalls)) {
      await db
        .update(schema.runs)
        .set({
          costCents: sql`${schema.runs.costCents} + ${costCents}`,
          tokensIn: sql`${schema.runs.tokensIn} + ${tokensIn}`,
          tokensOut: sql`${schema.runs.tokensOut} + ${tokensOut}`,
          toolCallCount: sql`${schema.runs.toolCallCount} + ${toolCalls}`,
        })
        .where(eq(schema.runs.id, openRun.id));
    }

    if (costCents || tokensIn || tokensOut) {
      await applySpend(agent, costCents, tokensIn, tokensOut);
    }

    return c.json({ accepted, skipped: parsed.data.events.length - accepted });
  })

  /** Activity heartbeat — this is what gates queued injection. */
  .post("/state", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = stateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid state" }, 400);

    await db
      .update(schema.agents)
      .set({ activity: parsed.data.activity, activityUpdatedAt: new Date() })
      .where(eq(schema.agents.id, agent.id));

    streamBus.emit(`agent:${agent.id}`, {
      type: "agent.status",
      agentId: agent.id,
      status: agent.status,
      activity: parsed.data.activity,
    });

    return c.json({ ok: true });
  })

  /** The agent's own status line, shown under its handle in the roster. */
  .post("/title", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = z
      .object({ statusLine: z.string().max(200) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid status line" }, 400);

    await db
      .update(schema.agents)
      .set({ statusLine: parsed.data.statusLine, updatedAt: new Date() })
      .where(eq(schema.agents.id, agent.id));

    streamBus.emit(`agent:${agent.id}`, {
      type: "agent.status_line",
      agentId: agent.id,
      statusLine: parsed.data.statusLine,
    });

    return c.json({ ok: true });
  })

  /** Channels this agent belongs to, plus the peers it could mention. */
  .get("/channels", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const rows = await db
      .select({
        id: schema.channels.id,
        slug: schema.channels.slug,
        name: schema.channels.name,
        topic: schema.channels.topic,
        autoApproveDispatch: schema.channels.autoApproveDispatch,
      })
      .from(schema.channelMembers)
      .innerJoin(schema.channels, eq(schema.channelMembers.channelId, schema.channels.id))
      .where(eq(schema.channelMembers.agentId, agent.id));

    const peers = await db
      .select({
        handle: schema.agents.handle,
        displayName: schema.agents.displayName,
        status: schema.agents.status,
        activity: schema.agents.activity,
        statusLine: schema.agents.statusLine,
      })
      .from(schema.agents);

    return c.json({ channels: rows, peers: peers.filter((p) => p.handle !== agent.handle) });
  })

  /**
   * Read a channel's recent history as this agent.
   *
   * Agents need this to catch up on a room before acting, and the failure mode
   * if it is missing is genuinely dangerous: an agent that cannot distinguish
   * "no history returned" from "the channel is empty" will treat silence as
   * consensus and proceed. `read.sh` exits non-zero and says so explicitly
   * rather than printing nothing.
   *
   * Returns oldest-first, which is the order an agent wants to read.
   */
  .get("/channels/:key/messages", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const channel = await resolveChannel(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);

    const rows = await db
      .select({
        id: schema.messages.id,
        kind: schema.messages.kind,
        authorKind: schema.messages.authorKind,
        authorAgentId: schema.messages.authorAgentId,
        authorUserId: schema.messages.authorUserId,
        body: schema.messages.body,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, channel.id))
      .orderBy(sql`${schema.messages.createdAt} DESC`)
      .limit(limit);

    return c.json({
      channel: { id: channel.id, slug: channel.slug },
      messages: rows.reverse(),
    });
  })

  /** Post a message to a channel as this agent. */
  .post("/messages", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = z
      .object({
        channel: z.string().min(1),
        body: z.string().min(1).max(20_000),
        requestId: z.string().max(200).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid message" }, 400);

    const channel = await resolveChannel(parsed.data.channel);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    // Dedup on (author, requestId): an agent retrying a failed post should not
    // double-post. Enforced by a partial unique index; we surface the existing
    // row rather than erroring so the retry looks like a success.
    if (parsed.data.requestId) {
      const [existing] = await db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.authorAgentId, agent.id),
            eq(schema.messages.requestId, parsed.data.requestId),
          ),
        )
        .limit(1);
      if (existing) return c.json({ message: existing, deduped: true });
    }

    const [message] = await db
      .insert(schema.messages)
      .values({
        channelId: channel.id,
        authorKind: "agent",
        authorAgentId: agent.id,
        kind: "text",
        body: parsed.data.body,
        requestId: parsed.data.requestId ?? null,
      })
      .returning();

    streamBus.emit(`channel:${channel.id}`, {
      type: "message.created",
      channelId: channel.id,
      messageId: message.id,
    });

    return c.json({ message, deduped: false }, 201);
  })

  /**
   * Request a dispatch to another agent.
   *
   * This does NOT dispatch. It creates a pending card in the channel that a
   * human approves, unless the channel has auto-approve on. The agent must not
   * assume its peer received anything — the skill script says so too.
   */
  .post("/mention", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = z
      .object({
        channel: z.string().min(1),
        handle: z.string().min(1).max(40),
        prompt: z.string().min(1).max(20_000),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid dispatch request" }, 400);

    const channel = await resolveChannel(parsed.data.channel);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const targetHandle = parsed.data.handle.replace(/^@/, "").toLowerCase();
    if (targetHandle === agent.handle) {
      return c.json({ error: "An agent cannot dispatch to itself" }, 400);
    }

    const [target] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.handle, targetHandle))
      .limit(1);
    if (!target) return c.json({ error: `@${targetHandle} not found` }, 404);

    const { createDispatch } = await import("../agents/dispatch.js");
    const result = await createDispatch({
      channel,
      fromAgent: agent,
      toAgent: target,
      prompt: parsed.data.prompt,
    });

    return c.json(result, 201);
  })

  /** Submit a rendered artifact — the successor to submit-result.sh. */
  .post("/artifacts", async (c) => {
    const agent = await callerAgent(c);
    if (agent instanceof Response) return agent;

    const parsed = z
      .object({
        channel: z.string().min(1),
        title: z.string().max(200).optional(),
        kind: z.enum(["html", "file", "link", "text"]).default("html"),
        body: z.string().max(2_000_000).optional(),
        url: z.string().url().optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid artifact" }, 400);

    const channel = await resolveChannel(parsed.data.channel);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const [message] = await db
      .insert(schema.messages)
      .values({
        channelId: channel.id,
        authorKind: "agent",
        authorAgentId: agent.id,
        kind: "artifact",
        body: parsed.data.title ?? "artifact",
      })
      .returning();

    const [artifact] = await db
      .insert(schema.artifacts)
      .values({
        channelId: channel.id,
        messageId: message.id,
        agentId: agent.id,
        kind: parsed.data.kind,
        title: parsed.data.title ?? null,
        contentType: parsed.data.kind === "html" ? "text/html" : null,
        body: parsed.data.body ?? null,
        url: parsed.data.url ?? null,
        sizeBytes: parsed.data.body ? Buffer.byteLength(parsed.data.body, "utf8") : null,
      })
      .returning();

    await db
      .update(schema.messages)
      .set({ metadata: { artifactId: artifact.id } })
      .where(eq(schema.messages.id, message.id));

    streamBus.emit(`channel:${channel.id}`, {
      type: "message.created",
      channelId: channel.id,
      messageId: message.id,
    });

    return c.json({ artifact, message }, 201);
  });

async function resolveChannel(key: string) {
  const cleaned = key.replace(/^#/, "");
  const isUuid = /^[0-9a-f-]{36}$/i.test(cleaned);
  const [row] = await db
    .select()
    .from(schema.channels)
    .where(isUuid ? eq(schema.channels.id, cleaned) : eq(schema.channels.slug, cleaned))
    .limit(1);
  return row ?? null;
}

/**
 * Roll the agent's daily spend window and pause it if it has run past its cap.
 *
 * The window rolls lazily on write rather than by a cron: a single-instance
 * harness has no scheduler guarantee worth relying on, and reading a stale
 * window is harmless as long as every write corrects it first.
 *
 * A paused agent keeps its container and TUI — you can still attach and look
 * at what it did. It just refuses new runs. That is deliberately distinct from
 * `status='stopped'`, which tears the container down.
 */
async function applySpend(
  agent: AgentRow,
  costCents: number,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const now = new Date();
  const windowStart = agent.budgetWindowStart ?? now;
  const dayMs = 24 * 60 * 60 * 1000;
  const windowExpired = now.getTime() - windowStart.getTime() >= dayMs;

  const spentToday = (windowExpired ? 0 : agent.spentCentsToday) + costCents;
  const cap = agent.dailyBudgetCents;
  const shouldPause = cap != null && cap > 0 && spentToday >= cap && !agent.pausedAt;

  await db
    .update(schema.agents)
    .set({
      spentCentsToday: spentToday,
      budgetWindowStart: windowExpired ? now : windowStart,
      tokensIn: sql`${schema.agents.tokensIn} + ${tokensIn}`,
      tokensOut: sql`${schema.agents.tokensOut} + ${tokensOut}`,
      pausedAt: shouldPause ? now : agent.pausedAt,
      updatedAt: now,
    })
    .where(eq(schema.agents.id, agent.id));

  if (shouldPause) {
    const [run] = await db
      .select({ channelId: schema.runs.channelId })
      .from(schema.runs)
      .where(eq(schema.runs.agentId, agent.id))
      .orderBy(sql`${schema.runs.queuedAt} DESC`)
      .limit(1);

    if (run?.channelId) {
      const [message] = await db
        .insert(schema.messages)
        .values({
          channelId: run.channelId,
          authorKind: "system",
          kind: "system",
          body:
            `@${agent.handle} hit its daily budget cap ($${(cap! / 100).toFixed(2)}) and is paused. ` +
            `Its terminal stays attached; new mentions will be refused until the cap is raised or the window rolls.`,
        })
        .returning();

      streamBus.emit(`channel:${run.channelId}`, {
        type: "message.created",
        channelId: run.channelId,
        messageId: message.id,
      });
    }
  }
}

export default routes;
export { parseMentions };
