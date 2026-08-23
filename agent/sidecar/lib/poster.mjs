/**
 * Batching, retrying event poster.
 *
 * POST $BLACKHOUSE_URL/api/agent-runtime/events
 *   Authorization: Bearer $AGENT_TOKEN
 *   X-Blackhouse-Agent: $AGENT_ID
 *   { "events": [ ...<=200 events, <=1MB... ] }
 *
 * Both headers are required. The bearer token alone is not enough — the
 * server resolves the calling agent from `X-Blackhouse-Agent` and 400s
 * without it.
 *
 * Every failure mode here is non-fatal by design. The endpoint may not exist
 * yet, the server may be restarting, the network may be gone — none of that
 * may stop the tail loop. Events queue in memory, retry with exponential
 * backoff, and are deduplicated server-side on `(agent_id, source_ref)`, so
 * a retry that actually landed the first time is harmless.
 *
 * The queue is bounded. On overflow we drop the OLDEST events, because a
 * transcript that resumes at "now" is more useful than one stuck an hour ago,
 * and we report the drop count on the next successful batch.
 */

const DEFAULTS = {
  maxBatch: 200,
  maxBatchBytes: 1024 * 1024,
  maxQueue: 5000,
  minBackoffMs: 1000,
  maxBackoffMs: 30000,
  timeoutMs: 15000,
};

export function createPoster(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const now = cfg.now ?? (() => Date.now());
  const log = cfg.log ?? (() => {});

  /** @type {Array<{event: object, json: string, bytes: number}>} */
  let queue = [];
  let dropped = 0;
  let failures = 0;
  let nextAttemptAt = 0;
  let inFlight = false;
  let posted = 0;

  function encode(event) {
    let json;
    try {
      json = JSON.stringify(event);
    } catch {
      // Circular/unserialisable payload — degrade rather than lose the event.
      json = JSON.stringify({
        type: "raw",
        seq: event?.seq,
        sourceRef: event?.sourceRef,
        payload: { unserialisable: true },
      });
    }
    return { event, json, bytes: Buffer.byteLength(json, "utf8") };
  }

  function enqueue(event) {
    if (!event) return;
    queue.push(encode(event));
    if (queue.length > cfg.maxQueue) {
      const overflow = queue.length - cfg.maxQueue;
      queue.splice(0, overflow);
      dropped += overflow;
    }
  }

  function takeBatch() {
    const batch = [];
    let bytes = 2; // "[]"
    while (queue.length && batch.length < cfg.maxBatch) {
      const head = queue[0];
      // Always allow one event through even if it alone exceeds the cap —
      // adapters already truncate payloads, so this is a floor, not a leak.
      if (batch.length > 0 && bytes + head.bytes + 1 > cfg.maxBatchBytes) break;
      batch.push(queue.shift());
      bytes += head.bytes + 1;
    }
    return batch;
  }

  function backoff() {
    failures += 1;
    const base = Math.min(cfg.minBackoffMs * 2 ** (failures - 1), cfg.maxBackoffMs);
    const jitter = Math.floor(Math.random() * (base / 4));
    nextAttemptAt = now() + base + jitter;
  }

  /**
   * Drain as much of the queue as the limits allow. Never throws.
   * @returns {Promise<{sent: number, failed: boolean}>}
   */
  async function flush() {
    if (inFlight) return { sent: 0, failed: false };
    if (!queue.length) return { sent: 0, failed: false };
    if (now() < nextAttemptAt) return { sent: 0, failed: false };
    if (!cfg.url || !cfg.agentId || !cfg.token) return { sent: 0, failed: false };

    inFlight = true;
    let sent = 0;
    let failed = false;
    try {
      while (queue.length) {
        const batch = takeBatch();
        if (!batch.length) break;
        // `ingestSchema` is a strict object: extra top-level keys are
        // stripped, so identity travels in the headers, not the body.
        const body = { events: batch.map((item) => item.event) };
        const ok = await post(body);
        if (!ok) {
          // Put the batch back at the head, preserving order, and back off.
          queue = batch.concat(queue);
          backoff();
          failed = true;
          break;
        }
        sent += batch.length;
        posted += batch.length;
        dropped = 0;
        failures = 0;
        nextAttemptAt = 0;
      }
    } catch (err) {
      log("flush threw", err);
      backoff();
      failed = true;
    } finally {
      inFlight = false;
    }
    return { sent, failed };
  }

  async function post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.token}`,
          "X-Blackhouse-Agent": String(cfg.agentId),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res && res.ok) return true;
      const status = res ? res.status : 0;
      // 4xx that is not auth/rate-limit means the server rejected the shape.
      // Retrying forever would wedge the queue, so drop the batch and log.
      if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
        log(`server rejected batch (${status}) — dropping it`);
        return true;
      }
      log(`post failed with status ${status}`);
      return false;
    } catch (err) {
      log("post threw", err);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enqueue,
    flush,
    stats: () => ({
      queued: queue.length,
      dropped,
      failures,
      posted,
      nextAttemptAt,
    }),
  };
}
