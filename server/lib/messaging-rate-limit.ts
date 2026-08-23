/**
 * In-memory token-bucket rate limit for /send-message.
 *
 * Two parallel buckets per request: one keyed on the from-session-id,
 * one on the user-id. The stricter limit wins. Per the design:
 *   - per-session: 100 msg / 60 s
 *   - per-user:   1000 msg / 60 s
 *
 * Single-instance only — sufficient for the current Blackhouse deploy
 * model. If we ever go multi-replica, swap this for a Postgres-backed
 * counter on session_messages itself.
 */

const PER_SESSION_LIMIT = 100;
const PER_USER_LIMIT = 1000;
const WINDOW_MS = 60_000;

type Bucket = {
  // Monotonically rotating ring of timestamps. Old entries get dropped
  // as we read past the window, so the array's length is the count
  // inside the window. No sweeper goroutine needed — readers prune.
  hits: number[];
};

const sessionBuckets = new Map<string, Bucket>();
const userBuckets = new Map<string, Bucket>();

function takeIfBelow(map: Map<string, Bucket>, key: string, limit: number, now: number): boolean {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    map.set(key, bucket);
  }
  const cutoff = now - WINDOW_MS;
  // Drop expired entries from the head. Most buckets stay small (~100
  // entries max) so this stays cheap.
  while (bucket.hits.length > 0 && bucket.hits[0] < cutoff) {
    bucket.hits.shift();
  }
  if (bucket.hits.length >= limit) return false;
  bucket.hits.push(now);
  return true;
}

/**
 * Returns `{ ok: true }` if the message is allowed, or
 * `{ ok: false, retryAfterSec }` with the seconds until the oldest
 * in-window entry expires. Decrements both buckets atomically — if
 * either is full, neither bucket is charged.
 */
export function checkRateLimit(
  fromSessionId: string,
  userId: string,
): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();

  // Two-phase: check without consuming, then consume both atomically.
  const sessB = sessionBuckets.get(fromSessionId);
  const userB = userBuckets.get(userId);
  const cutoff = now - WINDOW_MS;
  const sessCount = sessB ? sessB.hits.filter((t) => t >= cutoff).length : 0;
  const userCount = userB ? userB.hits.filter((t) => t >= cutoff).length : 0;

  if (sessCount >= PER_SESSION_LIMIT || userCount >= PER_USER_LIMIT) {
    const oldest =
      sessCount >= PER_SESSION_LIMIT
        ? (sessB!.hits.find((t) => t >= cutoff) ?? now)
        : (userB!.hits.find((t) => t >= cutoff) ?? now);
    const retryAfterMs = Math.max(0, WINDOW_MS - (now - oldest));
    return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }

  takeIfBelow(sessionBuckets, fromSessionId, PER_SESSION_LIMIT, now);
  takeIfBelow(userBuckets, userId, PER_USER_LIMIT, now);
  return { ok: true };
}

/** Test-only — clear all buckets. */
export function _resetRateLimitForTests() {
  sessionBuckets.clear();
  userBuckets.clear();
}
