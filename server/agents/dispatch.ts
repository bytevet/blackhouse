import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { streamBus } from "../lib/stream-bus.js";
import { routeMention } from "../api/channels.js";

type AgentRow = typeof schema.agents.$inferSelect;
type ChannelRow = typeof schema.channels.$inferSelect;

/** How long a pending card stays actionable before it lapses. */
export const DISPATCH_TTL_MS = 30 * 60 * 1000;

/**
 * Guard against runaway agent-to-agent chains.
 *
 * With auto-approve on there is no human in the loop, so these counters are
 * the only backstop left. A cycle like @a → @b → @a is cheap to write and
 * expensive to run.
 */
export const MAX_OPEN_DISPATCHES_PER_CHANNEL = 8;

export interface CreateDispatchResult {
  dispatchId: string;
  status: "pending" | "approved";
  autoApproved: boolean;
  runId?: string;
  message: string;
}

/**
 * Create a dispatch request from one agent to another.
 *
 * Always writes a card into the transcript, even when auto-approve is on.
 * Auto-approve removes the *hold*, not the *record* — the question "what did
 * these agents ask each other to do" must stay answerable afterwards.
 */
export async function createDispatch(input: {
  channel: ChannelRow;
  fromAgent: AgentRow;
  toAgent: AgentRow;
  prompt: string;
}): Promise<CreateDispatchResult> {
  const { channel, fromAgent, toAgent, prompt } = input;

  const open = await db
    .select({ id: schema.dispatchRequests.id })
    .from(schema.dispatchRequests)
    .where(
      and(
        eq(schema.dispatchRequests.channelId, channel.id),
        eq(schema.dispatchRequests.status, "pending"),
      ),
    );

  if (open.length >= MAX_OPEN_DISPATCHES_PER_CHANNEL) {
    return {
      dispatchId: "",
      status: "pending",
      autoApproved: false,
      message: `Too many pending dispatches in #${channel.slug} (${open.length}). Resolve some first.`,
    };
  }

  const autoApprove = channel.autoApproveDispatch;

  const [card] = await db
    .insert(schema.messages)
    .values({
      channelId: channel.id,
      authorKind: "agent",
      authorAgentId: fromAgent.id,
      kind: "dispatch_request",
      body: prompt,
    })
    .returning();

  const [dispatch] = await db
    .insert(schema.dispatchRequests)
    .values({
      channelId: channel.id,
      fromAgentId: fromAgent.id,
      toAgentId: toAgent.id,
      prompt,
      status: autoApprove ? "approved" : "pending",
      decidedAt: autoApprove ? new Date() : null,
      expiresAt: new Date(Date.now() + DISPATCH_TTL_MS),
      messageId: card.id,
    })
    .returning();

  await db
    .update(schema.messages)
    .set({ metadata: { dispatchId: dispatch.id, autoApproved: autoApprove } })
    .where(eq(schema.messages.id, card.id));

  streamBus.emit(`channel:${channel.id}`, {
    type: "message.created",
    channelId: channel.id,
    messageId: card.id,
  });

  if (!autoApprove) {
    return {
      dispatchId: dispatch.id,
      status: "pending",
      autoApproved: false,
      message: `Dispatch to @${toAgent.handle} is awaiting human approval. Do not assume it was delivered.`,
    };
  }

  const outcome = await routeMention({
    agent: toAgent,
    channelId: channel.id,
    triggerMessageId: card.id,
    prompt,
    mode: "queue",
    requestedByAgentId: fromAgent.id,
  });

  await db
    .update(schema.dispatchRequests)
    .set({ createdRunId: outcome.runId, updatedAt: new Date() })
    .where(eq(schema.dispatchRequests.id, dispatch.id));

  return {
    dispatchId: dispatch.id,
    status: "approved",
    autoApproved: true,
    runId: outcome.runId,
    message: `Auto-approved and dispatched to @${toAgent.handle}.`,
  };
}

/** Approve a pending dispatch, optionally with an edited prompt. */
export async function approveDispatch(
  dispatchId: string,
  decidedByUserId: string,
  editedPrompt?: string,
): Promise<{ ok: boolean; error?: string; runId?: string }> {
  const [dispatch] = await db
    .select()
    .from(schema.dispatchRequests)
    .where(eq(schema.dispatchRequests.id, dispatchId))
    .limit(1);

  if (!dispatch) return { ok: false, error: "Dispatch not found" };
  if (dispatch.status !== "pending") {
    return { ok: false, error: `Dispatch is already ${dispatch.status}` };
  }
  if (dispatch.expiresAt.getTime() < Date.now()) {
    await expire(dispatch.id);
    return { ok: false, error: "Dispatch expired" };
  }

  const [toAgent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, dispatch.toAgentId))
    .limit(1);
  if (!toAgent) return { ok: false, error: "Target agent no longer exists" };

  // The edited prompt is stored alongside the original rather than replacing
  // it: "edit & approve" must not silently rewrite what the agent asked for.
  const finalPrompt = editedPrompt?.trim() || dispatch.prompt;

  const outcome = await routeMention({
    agent: toAgent,
    channelId: dispatch.channelId,
    triggerMessageId: dispatch.messageId ?? undefined,
    prompt: finalPrompt,
    mode: "queue",
    requestedByAgentId: dispatch.fromAgentId,
    requestedByUserId: decidedByUserId,
  });

  await db
    .update(schema.dispatchRequests)
    .set({
      status: "approved",
      approvedPrompt: editedPrompt?.trim() || null,
      decidedBy: decidedByUserId,
      decidedAt: new Date(),
      createdRunId: outcome.runId,
      updatedAt: new Date(),
    })
    .where(eq(schema.dispatchRequests.id, dispatch.id));

  notify(dispatch.channelId, dispatch.id, "approved");
  return { ok: true, runId: outcome.runId };
}

export async function denyDispatch(
  dispatchId: string,
  decidedByUserId: string,
): Promise<{ ok: boolean; error?: string }> {
  const [dispatch] = await db
    .select()
    .from(schema.dispatchRequests)
    .where(eq(schema.dispatchRequests.id, dispatchId))
    .limit(1);

  if (!dispatch) return { ok: false, error: "Dispatch not found" };
  if (dispatch.status !== "pending") {
    return { ok: false, error: `Dispatch is already ${dispatch.status}` };
  }

  await db
    .update(schema.dispatchRequests)
    .set({
      status: "denied",
      decidedBy: decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.dispatchRequests.id, dispatch.id));

  notify(dispatch.channelId, dispatch.id, "denied");
  return { ok: true };
}

async function expire(dispatchId: string): Promise<void> {
  const [row] = await db
    .update(schema.dispatchRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(eq(schema.dispatchRequests.id, dispatchId))
    .returning();
  if (row) notify(row.channelId, row.id, "expired");
}

/**
 * Lapse pending cards past their TTL. Called on an interval; also called
 * opportunistically on approve, so a card cannot be approved after expiry
 * just because the sweeper hasn't run yet.
 */
export async function expireStaleDispatches(): Promise<number> {
  const stale = await db
    .update(schema.dispatchRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(schema.dispatchRequests.status, "pending"),
        lt(schema.dispatchRequests.expiresAt, new Date()),
      ),
    )
    .returning({ id: schema.dispatchRequests.id, channelId: schema.dispatchRequests.channelId });

  for (const row of stale) notify(row.channelId, row.id, "expired");
  return stale.length;
}

function notify(channelId: string, dispatchId: string, status: string): void {
  streamBus.emit(`channel:${channelId}`, {
    type: "dispatch.updated",
    channelId,
    dispatchId,
    status,
  });
}
