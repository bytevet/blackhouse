import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canReceiveQueuedRun } from "../../server/agents/queue.js";

/**
 * Regression cover for a gap found only by running the plan's step 5 on a real
 * host: queue mode parked runs and nothing ever released them.
 *
 * The half that worked was visible — posting to a busy agent returned
 * `queued: true, reason: "@scout is busy — delivers when idle"`. The half that
 * did not was invisible: the agent returned to idle and the run sat at
 * `queued` indefinitely. The poster is told their prompt is coming, the
 * transcript shows it pending, and it never runs. No unit test could catch it,
 * because the missing piece was a caller, not a behaviour.
 */

const agent = (over: Partial<Parameters<typeof canReceiveQueuedRun>[0]> = {}) => ({
  status: "running" as const,
  containerId: "abc123",
  pausedAt: null,
  activity: "idle" as const,
  ...over,
});

describe("canReceiveQueuedRun", () => {
  it("releases to a running, idle, unpaused agent", () => {
    expect(canReceiveQueuedRun(agent())).toBe(true);
  });

  it("holds while the agent is still busy", () => {
    expect(canReceiveQueuedRun(agent({ activity: "busy" }))).toBe(false);
  });

  it("holds when activity is unknown", () => {
    // `unknown` means the sidecar has gone quiet. Injecting into an agent whose
    // state we cannot see is precisely what queue mode exists to avoid, so an
    // absent signal must not be read as permission.
    expect(canReceiveQueuedRun(agent({ activity: "unknown" }))).toBe(false);
  });

  it("holds for an agent that is no longer running", () => {
    for (const status of ["stopped", "error", "destroyed", "creating"] as const) {
      expect(canReceiveQueuedRun(agent({ status }))).toBe(false);
    }
  });

  it("holds when the container is gone even if the row still says running", () => {
    // Status and container can disagree for a moment after a crash; the
    // container is the thing being written to, so it decides.
    expect(canReceiveQueuedRun(agent({ containerId: null }))).toBe(false);
  });

  it("holds for a paused agent — a budget cap outlives the queue", () => {
    // The run was parked for being busy, but by release time a different gate
    // applies. Draining on the original reason alone would spend past a cap a
    // human set.
    expect(canReceiveQueuedRun(agent({ pausedAt: new Date() }))).toBe(false);
  });
});

describe("the drain is actually wired up", () => {
  // The bug was a missing caller, so these assert on call sites. Behavioural
  // tests of `drainAgentQueue` would all have passed while the queue silently
  // never drained.

  it("fires from the sidecar's idle report — the low-latency path", () => {
    const src = readFileSync("server/api/agent-runtime.ts", "utf8");
    expect(src).toContain("drainAgentQueue");
    const state = src.slice(src.indexOf('.post("/state"'));
    expect(state.slice(0, state.indexOf('.post("/title"'))).toMatch(
      /activity === "idle"[\s\S]*drainAgentQueue/,
    );
  });

  it("also fires from the background tick — the safety net", () => {
    // PTY-scrape adapters have no in-container state reporter, so the idle
    // report above never arrives for them. Without the sweep they could never
    // drain at all.
    const src = readFileSync("server/lib/scheduler.ts", "utf8");
    expect(src).toContain("drainQueuedRuns");
    expect(src.slice(src.indexOf("startBackgroundJobs"))).toContain("drainQueuedRuns");
  });

  it("delivers queued and immediate runs through one code path", () => {
    // If the router kept its own copy of the injection sequence, the per-CLI
    // timing profile would drift between the two and only the queued path
    // would break — the harder of the two to notice.
    const src = readFileSync("server/api/channels.ts", "utf8");
    expect(src).toContain("deliverRun");
    expect(src).not.toContain("planInjection");
  });
});
