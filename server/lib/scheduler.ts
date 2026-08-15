import { and, eq, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { routeMention } from "../api/channels.js";
import { expireStaleDispatches } from "../agents/dispatch.js";
import { pruneEgressProxies } from "../egress/proxy-manager.js";
import { resolveAgentEgress } from "../egress/rules.js";

/**
 * One in-process interval drives every periodic job: expiring dispatch cards
 * and firing schedules.
 *
 * Deliberately not a distributed job queue. Blackhouse is a single-instance,
 * small-team harness; a queue would add an operational dependency to solve a
 * problem this deployment shape does not have. If it ever goes multi-replica,
 * this is the one module that needs replacing — everything else is stateless
 * with respect to scheduling.
 */

const TICK_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

/**
 * Compute the next run time for a cron expression.
 *
 * Supports the common 5-field subset — minute, hour, day-of-month, month,
 * day-of-week — with wildcards, step values, ranges and comma lists.
 * Deliberately small: the alternative is a cron dependency, and schedules here
 * are "nightly" or "every weekday morning" shaped rather than arbitrary.
 *
 * Returns null for an expression it cannot parse, so a bad schedule stays
 * inert rather than firing at the wrong time.
 */
export function nextRunAt(cron: string, from: Date): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minF, hourF, domF, monF, dowF] = fields;

  const parse = (field: string, min: number, max: number): number[] | null => {
    if (field === "*") return null; // null means "any"
    const out = new Set<number>();
    for (const part of field.split(",")) {
      const step = /^\*\/(\d+)$/.exec(part);
      if (step) {
        const n = Number(step[1]);
        if (!n) return [];
        for (let v = min; v <= max; v += n) out.add(v);
        continue;
      }
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) {
        for (let v = Number(range[1]); v <= Number(range[2]); v += 1) {
          if (v >= min && v <= max) out.add(v);
        }
        continue;
      }
      const v = Number(part);
      if (!Number.isInteger(v) || v < min || v > max) return [];
      out.add(v);
    }
    return [...out].sort((a, b) => a - b);
  };

  const minutes = parse(minF, 0, 59);
  const hours = parse(hourF, 0, 23);
  const doms = parse(domF, 1, 31);
  const months = parse(monF, 1, 12);
  const dows = parse(dowF, 0, 6);

  // An empty (rather than null) set means the field was unsatisfiable.
  if ([minutes, hours, doms, months, dows].some((f) => f !== null && f.length === 0)) return null;

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Scan forward a bounded number of minutes (~1 year) rather than solving the
  // constraint. Simple, obviously correct, and cheap at a 30s tick.
  const LIMIT = 366 * 24 * 60;
  for (let i = 0; i < LIMIT; i += 1) {
    const okMin = !minutes || minutes.includes(candidate.getMinutes());
    const okHour = !hours || hours.includes(candidate.getHours());
    const okDom = !doms || doms.includes(candidate.getDate());
    const okMon = !months || months.includes(candidate.getMonth() + 1);
    const okDow = !dows || dows.includes(candidate.getDay());
    if (okMin && okHour && okDom && okMon && okDow) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** Fire any schedules that are due, and re-arm them. */
export async function runDueSchedules(now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(schema.schedules)
    .where(and(eq(schema.schedules.enabled, true), lte(schema.schedules.nextRunAt, now)));

  let fired = 0;
  for (const schedule of due) {
    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, schedule.agentId))
      .limit(1);

    // Re-arm first, so a failing schedule cannot spin: if routing throws, the
    // next run time has already advanced past now.
    await db
      .update(schema.schedules)
      .set({
        lastRunAt: now,
        nextRunAt: nextRunAt(schedule.cron, now),
        updatedAt: now,
      })
      .where(eq(schema.schedules.id, schedule.id));

    if (!agent || !schedule.channelId) continue;

    try {
      await routeMention({
        agent,
        channelId: schedule.channelId,
        prompt: schedule.prompt,
        mode: "queue",
      });
      fired += 1;
    } catch (err) {
      console.error(`[blackhouse] schedule ${schedule.id} failed:`, err);
    }
  }
  return fired;
}

/**
 * Reap egress proxies whose policy no longer has a running agent.
 *
 * A stale proxy is harmless — once no agent sits on its internal network,
 * nothing can reach it — it just holds ~30MB of RSS. So this runs on the slow
 * tick rather than on agent teardown, where it would add a Docker round trip
 * to every stop.
 */
async function pruneProxies(): Promise<void> {
  const running = await db
    .select({ agent: schema.agents, blueprint: schema.agentBlueprints })
    .from(schema.agents)
    .innerJoin(schema.agentBlueprints, eq(schema.agents.blueprintId, schema.agentBlueprints.id))
    .where(eq(schema.agents.status, "running"));

  const keys = new Set<string>();
  for (const row of running) {
    // Abandon the whole sweep if any agent's policy cannot be resolved. The
    // reap set is defined by what is NOT in `keys`, so an incomplete set would
    // tear down a proxy that something is still using. Skipping the run costs
    // nothing — a stale proxy is harmless and the next tick retries.
    const resolved = await resolveAgentEgress(row.agent, row.blueprint).catch(() => null);
    if (!resolved) return;
    keys.add(resolved.policyKey);
  }

  const removed = await pruneEgressProxies([...keys]);
  if (removed.length) {
    console.log(`[blackhouse] reaped ${removed.length} unused egress prox(ies)`);
  }
}

export function startBackgroundJobs(): void {
  if (timer) return;
  let tick = 0;
  timer = setInterval(() => {
    void expireStaleDispatches().catch((err) =>
      console.error("[blackhouse] dispatch sweep failed:", err),
    );
    void runDueSchedules().catch((err) => console.error("[blackhouse] schedule run failed:", err));

    // Proxy reaping needs a Docker round trip per policy, so it runs every
    // tenth tick (~5 min) rather than every 30 seconds.
    tick += 1;
    if (tick % 10 === 0) {
      void pruneProxies().catch((err) => console.error("[blackhouse] proxy reap failed:", err));
    }
  }, TICK_MS);
  // Do not hold the process open on this timer alone.
  timer.unref?.();
}

export function stopBackgroundJobs(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
