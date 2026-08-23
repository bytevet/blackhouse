/**
 * Idle/busy tracking, and the `state` POST that carries it.
 *
 * WHY THIS IS NOT JUST "did the log move recently".
 *
 * The dispatcher uses `activity` to decide when to release a queued prompt
 * onto the agent's PTY. Get it wrong in the optimistic direction and a queued
 * prompt is typed into the middle of a turn — or, worse, into a y/n permission
 * dialog, where the first character of the prompt answers the dialog. So the
 * in-container half of the test is deliberately conservative and requires BOTH:
 *
 *   1. the session log has been quiet for `idleQuietMs`, and
 *   2. the last thing we saw was a turn actually finishing
 *      (`assistant_text` or `turn_end`) — not a tool call still outstanding.
 *
 * The server ANDs this with its own PTY-quiet clause. Either signal alone is
 * wrong sometimes: the log goes quiet during a long `Bash` call (busy but
 * silent), and the PTY never goes quiet under a spinner (idle but noisy).
 *
 * We start in `unknown` rather than `idle`. Claiming idle before we have seen
 * anything would release a queued prompt into a CLI that has not finished
 * booting.
 */

export function createActivityTracker(options = {}) {
  const idleQuietMs = options.idleQuietMs ?? 1500;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const terminalTypes = options.terminalTypes ?? new Set(["assistant_text", "turn_end"]);
  const now = options.now ?? (() => Date.now());

  let lastActivityAt = 0;
  let lastEventType = null;
  let lastExternalRunId = undefined;
  // `null`, not "unknown": the first `due()` must always fire, so the server
  // learns the agent exists as soon as the sidecar boots rather than after
  // one heartbeat interval of silence.
  let reported = null;
  let reportedAt = 0;
  let sawAnything = false;

  /** Record that the adapter produced events. Order within a batch matters. */
  function observe(events) {
    if (!events || events.length === 0) return;
    lastActivityAt = now();
    sawAnything = true;
    for (const event of events) {
      // `status` and `usage` are bookkeeping; they say nothing about whether
      // the agent is done, so they must not clear a pending tool call.
      if (event.type === "status" || event.type === "usage" || event.type === "raw") continue;
      lastEventType = event.type;
      if (event.externalRunId) lastExternalRunId = event.externalRunId;
    }
  }

  function current() {
    if (!sawAnything) return "unknown";
    const quiet = now() - lastActivityAt >= idleQuietMs;
    if (!quiet) return "busy";
    return lastEventType && terminalTypes.has(lastEventType) ? "idle" : "busy";
  }

  /**
   * @returns {{activity: string, externalRunId?: string, at: string}|null}
   *   a payload to POST, or null if nothing is due.
   */
  function due() {
    const activity = current();
    const at = now();
    const changed = activity !== reported;
    const stale = at - reportedAt >= heartbeatMs;
    if (!changed && !stale) return null;
    reported = activity;
    reportedAt = at;
    const payload = { activity, at: new Date(at).toISOString() };
    if (lastExternalRunId) payload.externalRunId = lastExternalRunId;
    return payload;
  }

  return { observe, current, due, reported: () => reported ?? "unknown" };
}

/**
 * POST a state payload. Failure is logged and forgotten: the next heartbeat is
 * at most `heartbeatMs` away, and the server ages an agent to `unknown` on its
 * own after 30s of silence, so a dropped heartbeat is self-correcting.
 */
export async function postState(cfg, payload) {
  if (!cfg.url || !cfg.agentId || !cfg.token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000);
  try {
    const res = await (cfg.fetch ?? globalThis.fetch)(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
        "X-Blackhouse-Agent": String(cfg.agentId),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
