import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
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

/** Ceiling on one artifact batch — both the `?ids=` list and the rows returned. */
const ARTIFACT_BATCH_LIMIT = 100;

async function channelBySlugOrId(key: string) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const [row] = await db
    .select()
    .from(schema.channels)
    .where(isUuid ? eq(schema.channels.id, key) : eq(schema.channels.slug, key))
    .limit(1);
  return row ?? null;
}

type ChannelRow = typeof schema.channels.$inferSelect;

/**
 * Who may read a channel, and which agents are in it.
 *
 * One lookup, because three separate routes need the same two answers and
 * re-querying per route is how they drift apart.
 *
 * **Public channels short-circuit before any membership lookup.** That is not
 * an optimisation, it is the safety property: every channel that exists today
 * is public and has no human members at all — `server/db/seed.ts` creates
 * `#general` and adds nobody — so a gate that consulted membership first would
 * lock every user out of every room on the first deploy, including whoever
 * deployed it.
 *
 * Membership still matters in a public channel: it decides which agents can be
 * mentioned, and it is what `read.sh` filters an agent's own channel list by
 * (`server/api/agent-runtime.ts`).
 */
export async function channelAccess(
  channel: ChannelRow,
  user: { id: string; role?: string | null },
): Promise<{ canRead: boolean; agentIds: Set<string>; isMember: boolean }> {
  const rows = await db
    .select({
      agentId: schema.channelMembers.agentId,
      userId: schema.channelMembers.userId,
    })
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, channel.id));

  const agentIds = new Set<string>();
  let isMember = false;
  for (const row of rows) {
    if (row.agentId) agentIds.add(row.agentId);
    else if (row.userId === user.id) isMember = true;
  }

  // Admins keep the override they have everywhere else in this codebase; a
  // private room they cannot see is a room they cannot administer.
  const canRead = !channel.isPrivate || isMember || user.role === "admin";
  return { canRead, agentIds, isMember };
}

/**
 * Say the roster changed, so an open dialog and the header agree.
 *
 * Fire-and-forget on the channel topic: the frame carries no rows, because the
 * two consumers want different shapes and both already know how to refetch.
 */
function announceMembers(channelId: string) {
  streamBus.emit(`channel:${channelId}`, { type: "channel.members", channelId });
}

/** 404 rather than 403 — a private channel should not confirm it exists. */
function notFound(c: { json: (b: unknown, s: 404) => Response }) {
  return c.json({ error: "Channel not found" }, 404);
}

const app = new Hono<AuthEnv>()

  .get("/", authMiddleware, async (c) => {
    const rows = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.isArchived, false))
      .orderBy(schema.channels.slug);

    const user = c.get("session").user;
    if (user.role === "admin") return c.json(rows);

    // Only private rooms cost a lookup. The common case — a workspace of
    // public channels — is one query, as before.
    const privateIds = rows.filter((r) => r.isPrivate).map((r) => r.id);
    if (privateIds.length === 0) return c.json(rows);

    const mine = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(
        and(
          inArray(schema.channelMembers.channelId, privateIds),
          eq(schema.channelMembers.userId, user.id),
        ),
      );
    const joined = new Set(mine.map((m) => m.channelId));
    return c.json(rows.filter((r) => !r.isPrivate || joined.has(r.id)));
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

    /**
     * The creator joins their own channel.
     *
     * `createdBy` records who made it and gates nothing. Once private channels
     * became members-only, a channel with no members was a channel nobody could
     * open — and the person who just made it was the first to be shut out:
     * 404 on their own room, absent from their own channel list, and no delete
     * endpoint to undo it. Verified against the deployment before this line
     * existed.
     *
     * `owner` rather than `member`, which is what the role enum is for.
     */
    await db
      .insert(schema.channelMembers)
      .values({ channelId: created.id, userId: c.get("session").user.id, role: "owner" })
      .onConflictDoNothing();

    return c.json(created, 201);
  })

  .get("/:key", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

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

    // `onConflictDoNothing` returns nothing when the row already existed, and
    // "already a member" is a thing the dialog should say rather than a silent
    // success that looks like an add.
    if (!member) return c.json({ error: "Already a member of this channel" }, 409);

    announceMembers(channel.id);
    return c.json(member, 201);
  })

  /**
   * The members dialog's data.
   *
   * Separate from `GET /:key` because that returns bare join-table ids — enough
   * to count humans and agents in the header, nothing you could render a row
   * from. Here the rows are joined out to the names, handles and live state the
   * dialog shows.
   */
  .get("/:key/members", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);
    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

    const people = await db
      .select({
        memberId: schema.channelMembers.id,
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.user.role,
      })
      .from(schema.channelMembers)
      .innerJoin(schema.user, eq(schema.channelMembers.userId, schema.user.id))
      .where(eq(schema.channelMembers.channelId, channel.id));

    const agents = await db
      .select({
        memberId: schema.channelMembers.id,
        id: schema.agents.id,
        handle: schema.agents.handle,
        displayName: schema.agents.displayName,
        status: schema.agents.status,
        activity: schema.agents.activity,
        statusLine: schema.agents.statusLine,
      })
      .from(schema.channelMembers)
      .innerJoin(schema.agents, eq(schema.channelMembers.agentId, schema.agents.id))
      .where(eq(schema.channelMembers.channelId, channel.id));

    return c.json({ people, agents });
  })

  /**
   * Who could be added — everyone in the workspace who is not already here.
   *
   * A deliberately narrower view than `GET /api/settings/users`, which is
   * admin-gated and carries `banned`, `createdAt` and the rest. Picking someone
   * to add to a channel should not require being an admin, but it also should
   * not hand every member the full user table.
   */
  .get("/:key/members/candidates", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);
    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

    const existing = await db
      .select({
        agentId: schema.channelMembers.agentId,
        userId: schema.channelMembers.userId,
      })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channel.id));
    const takenUsers = new Set(existing.map((e) => e.userId).filter(Boolean));
    const takenAgents = new Set(existing.map((e) => e.agentId).filter(Boolean));

    const people = (
      await db
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.user)
    ).filter((u) => !takenUsers.has(u.id));

    const agents = (
      await db
        .select({
          id: schema.agents.id,
          handle: schema.agents.handle,
          displayName: schema.agents.displayName,
        })
        .from(schema.agents)
        .where(ne(schema.agents.status, "destroyed"))
    ).filter((a) => !takenAgents.has(a.id));

    return c.json({ people, agents });
  })

  /**
   * Remove one membership.
   *
   * Scoped by channel as well as id so a member row cannot be deleted through
   * the wrong channel's URL. Removing an agent does nothing to its container —
   * it stops being mentionable here and keeps running, which is what the design
   * promises in the dialog's footnote.
   */
  .delete("/:key/members/:memberId", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);
    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

    const memberId = c.req.param("memberId")!;

    /**
     * A private channel must keep at least one person who can open it.
     *
     * Nothing here stopped you removing yourself, including as the only member,
     * and a private channel with no people is a room no one can reach: the read
     * gate 404s everyone, there is no `DELETE /api/channels` to clean it up, and
     * re-adding someone requires opening the very channel you can no longer see.
     * The only way back is an admin, or SQL.
     *
     * Reproduced before this guard existed: a user created a private channel,
     * removed themselves, got `200 {"ok":true}`, and the room became unreachable
     * and unremovable in one click with no warning.
     *
     * The rule applies to everyone, admins included. They can still read a
     * private room, so emptying one is recoverable for them — but "a private
     * channel always has someone in it" is a property worth keeping whole rather
     * than one with an exemption that has to be reasoned about later. Adding
     * someone else first is the way through.
     *
     * Public channels are exempt: anyone can read them, so an empty one is
     * merely empty, not lost.
     */
    if (channel.isPrivate) {
      const people = await db
        .select({ id: schema.channelMembers.id })
        .from(schema.channelMembers)
        .where(
          and(
            eq(schema.channelMembers.channelId, channel.id),
            isNotNull(schema.channelMembers.userId),
          ),
        );
      const removingAPerson = people.some((p) => p.id === memberId);
      if (removingAPerson && people.length <= 1) {
        return c.json(
          {
            error:
              "This is the only person in a private channel. Add someone else first — " +
              "a private channel with no people cannot be opened by anyone, or deleted.",
          },
          409,
        );
      }
    }

    const [removed] = await db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.id, memberId),
          eq(schema.channelMembers.channelId, channel.id),
        ),
      )
      .returning({ id: schema.channelMembers.id });

    if (!removed) return c.json({ error: "Not a member of this channel" }, 404);

    announceMembers(channel.id);
    return c.json({ ok: true });
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

    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

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
   * Artifact metadata for this channel, in one request.
   *
   * The transcript used to enrich its artifact cards by asking every *author*
   * for its 50 most recent artifacts and merging the lists — N requests for a
   * channel with N agents in it, each returning rows from rooms the transcript
   * is not showing, and each silently missing anything older than that window.
   * Artifacts belong to a channel, so the channel answers for them.
   *
   * `?ids=` filters to the cards actually on screen; without it the newest
   * page is returned so a fresh scrollback needs no id list at all. Both are
   * constrained to `channel.id`, which is what makes one `channelAccess` check
   * cover every row in the response.
   *
   * `body` is never selected — a channel's worth of inline HTML is not a list
   * payload. `GET /api/artifacts/:id/content` serves one body at a time.
   */
  .get("/:key/artifacts", authMiddleware, async (c) => {
    const channel = await channelBySlugOrId(c.req.param("key")!);
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const access = await channelAccess(channel, c.get("session").user);
    if (!access.canRead) return notFound(c);

    // Non-UUIDs are dropped rather than passed through: Postgres rejects them
    // at parse time, so one junk id in the query string would 500 the whole
    // batch instead of returning the rows that do exist.
    const ids = (c.req.query("ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
      .slice(0, ARTIFACT_BATCH_LIMIT);

    const rows = await db
      .select({
        id: schema.artifacts.id,
        kind: schema.artifacts.kind,
        title: schema.artifacts.title,
        contentType: schema.artifacts.contentType,
        url: schema.artifacts.url,
        sizeBytes: schema.artifacts.sizeBytes,
        createdAt: schema.artifacts.createdAt,
        channelId: schema.artifacts.channelId,
        agentId: schema.artifacts.agentId,
      })
      .from(schema.artifacts)
      .where(
        ids.length > 0
          ? and(eq(schema.artifacts.channelId, channel.id), inArray(schema.artifacts.id, ids))
          : eq(schema.artifacts.channelId, channel.id),
      )
      .orderBy(desc(schema.artifacts.createdAt))
      .limit(ARTIFACT_BATCH_LIMIT);

    return c.json(rows);
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

    const access = await channelAccess(channel, user);
    if (!access.canRead) return notFound(c);

    const parsedMentions = parseMentions(body);
    const handles = parsedMentions.map((m) => m.handle);

    const resolved = handles.length
      ? await db.select().from(schema.agents).where(inArray(schema.agents.handle, handles))
      : [];

    /**
     * Membership decides who can be mentioned.
     *
     * This used to resolve against every agent in the workspace, which made the
     * channel roster decorative: adding or removing an agent changed nothing
     * about who you could summon. Now a mention of a non-member resolves to
     * nothing and the poster is told, rather than the message landing and the
     * agent silently never answering.
     *
     * The message still posts. Refusing it would lose what someone typed over a
     * membership detail they can fix in two clicks.
     */
    const mentionedAgents = resolved.filter((a) => access.agentIds.has(a.id));
    const notMembers = resolved.filter((a) => !access.agentIds.has(a.id)).map((a) => a.handle);

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

    // `notMembers` is how the composer explains a mention that went nowhere.
    return c.json({ message, dispatched, notMembers }, 201);
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
