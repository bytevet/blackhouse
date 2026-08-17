import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { streamBus } from "../lib/stream-bus.js";
import { getPtyHub } from "./pty-hub.js";
import { planInjection } from "./injector.js";
import { getProfile } from "./adapters/profiles.js";

type AgentRow = typeof schema.agents.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;

/**
 * Delivery of a run's prompt onto an agent's live TUI, and the drainer that
 * releases runs parked while the agent was busy.
 *
 * Queue mode is only half a feature without the drainer. `routeMention` parks a
 * run at `status='queued'` when the agent is busy and reports "delivers when
 * idle" to the poster — a promise nothing was keeping: verified on a live host,
 * a parked run sat at `queued` while the agent returned to idle and stayed
 * there. The prompt was accepted, shown in the transcript as pending, and
 * silently never ran.
 *
 * Two triggers, deliberately:
 *
 * - The sidecar's `state` report, which is the low-latency path — an agent that
 *   has just gone idle drains within one request.
 * - The background tick, which is the safety net. PTY-scrape adapters have no
 *   in-container state reporter, and any dropped request would otherwise strand
 *   a run forever. Draining is idempotent, so both firing is harmless.
 */

/**
 * Push a prompt onto the agent's stdin and mark the run running.
 *
 * Shared by the mention router and the drainer so a queued run is delivered
 * through exactly the same path as an immediate one — including the per-CLI
 * timing profile, which is the part most likely to drift if it were duplicated.
 */
export async function deliverRun(
  agent: AgentRow,
  run: Pick<RunRow, "id" | "prompt" | "injectionMode" | "channelId">,
): Promise<void> {
  const [blueprint] = await db
    .select({ cli: schema.agentBlueprints.cli })
    .from(schema.agentBlueprints)
    .where(eq(schema.agentBlueprints.id, agent.blueprintId))
    .limit(1);

  const hub = getPtyHub();
  await hub.ensureAttached(agent.id);

  const mode = run.injectionMode === "interrupt" ? "interrupt" : "queue";
  for (const step of planInjection(run.prompt, getProfile(blueprint?.cli), { mode })) {
    await hub.write(agent.id, step.bytes, { source: "inject" });
    if (step.delayAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, step.delayAfterMs));
    }
  }

  await db
    .update(schema.runs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(schema.runs.id, run.id));

  // Optimistic: the sidecar corrects this on its next heartbeat, but marking
  // busy immediately stops a second mention racing in behind this one.
  await db
    .update(schema.agents)
    .set({ activity: "busy", activityUpdatedAt: new Date() })
    .where(eq(schema.agents.id, agent.id));

  // Tell the channel as well as the agent: a run released from the queue has no
  // accompanying post, so the transcript's pending chip has nothing else to
  // learn from.
  streamBus.emitAll([`channel:${run.channelId}`, `agent:${agent.id}`], {
    type: "run.updated",
    agentId: agent.id,
    runId: run.id,
    status: "running",
  });
}

/**
 * Is this agent ready to be handed a parked run?
 *
 * Every reason a run could have been parked has to clear, not just the one the
 * poster was shown. A run queued because the agent was busy must still not fire
 * if, by the time it is idle, the agent has been stopped, has errored, or has
 * hit its budget cap — releasing then would inject a prompt into a container
 * that is gone, or spend past a cap a human set.
 *
 * Pure so the rule is testable without a database, which is where the whole
 * risk of this function lives.
 */
export function canReceiveQueuedRun(
  agent: Pick<AgentRow, "status" | "containerId" | "pausedAt" | "activity">,
): boolean {
  if (agent.status !== "running") return false;
  if (!agent.containerId) return false;
  if (agent.pausedAt) return false;
  // Only `idle`. `unknown` means the sidecar has gone quiet, and injecting into
  // an agent whose state we cannot see is the case queue mode exists to avoid.
  return agent.activity === "idle";
}

/**
 * Release the oldest queued run for an agent, if it is ready to receive one.
 *
 * Exactly one run per call, by design: releasing the whole backlog would type
 * several prompts into one composer, and the agent goes busy the moment the
 * first lands anyway. The next drain picks up the next one.
 *
 * Returns the run id if one was released.
 */
export async function drainAgentQueue(agentId: string): Promise<string | null> {
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);

  if (!agent || !canReceiveQueuedRun(agent)) return null;

  const [next] = await db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.agentId, agentId), eq(schema.runs.status, "queued")))
    .orderBy(asc(schema.runs.queuedAt))
    .limit(1);
  if (!next) return null;

  // Claim it before injecting. Two drains can race — the sidecar's state report
  // and the background tick — and the conditional update is what stops both
  // from delivering the same prompt.
  const claimed = await db
    .update(schema.runs)
    .set({ status: "injecting" })
    .where(and(eq(schema.runs.id, next.id), eq(schema.runs.status, "queued")))
    .returning({ id: schema.runs.id });
  if (claimed.length === 0) return null;

  try {
    await deliverRun(agent, next);
    return next.id;
  } catch (err) {
    await db
      .update(schema.runs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(schema.runs.id, next.id));
    return null;
  }
}

/**
 * Sweep every idle agent that has something parked.
 *
 * The safety net behind the per-agent drain. Kept narrow by the same query the
 * per-agent path uses, so an agent that is stopped, paused or busy costs
 * nothing here.
 */
export async function drainQueuedRuns(): Promise<number> {
  const candidates = await db
    .selectDistinct({ agentId: schema.runs.agentId })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
    .where(
      and(
        eq(schema.runs.status, "queued"),
        eq(schema.agents.status, "running"),
        eq(schema.agents.activity, "idle"),
        isNull(schema.agents.pausedAt),
        ne(schema.agents.containerId, ""),
      ),
    );

  let released = 0;
  for (const row of candidates) {
    const runId = await drainAgentQueue(row.agentId).catch((err) => {
      console.error(`[blackhouse] drain for agent ${row.agentId} failed:`, err);
      return null;
    });
    if (runId) released += 1;
  }
  return released;
}
