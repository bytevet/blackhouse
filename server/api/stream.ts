import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { authMiddleware, type AuthEnv } from "../middleware/auth.js";
import { streamBus, parseTopics, type StreamEvent, type StreamTopic } from "../lib/stream-bus.js";

/** Keeps proxies from reaping an idle connection. */
const HEARTBEAT_MS = 15_000;

/**
 * Drop `channel:*` topics the caller may not read.
 *
 * The topic list arrives from the client, and until this existed the server
 * subscribed to whatever it named: any signed-in user could attach to
 * `channel:<uuid>` for a room they were not in. The frames carry ids rather
 * than message bodies, so what leaked was metadata — that a message exists,
 * and when — but a private channel whose activity you can watch in real time
 * is not private.
 *
 * Unauthorized topics are dropped rather than rejected. A tab that asks for a
 * room it just lost access to should keep receiving `workspace`, not have its
 * whole connection fail.
 */
async function authorizeTopics(
  requested: StreamTopic[],
  user: { id: string; role?: string | null },
): Promise<StreamTopic[]> {
  const channelIds = requested
    .filter((t) => t.startsWith("channel:"))
    .map((t) => t.slice("channel:".length));
  if (channelIds.length === 0 || user.role === "admin") return requested;

  const rows = await db
    .select({ id: schema.channels.id, isPrivate: schema.channels.isPrivate })
    .from(schema.channels)
    .where(inArray(schema.channels.id, channelIds));

  // Public rooms need no membership, which is also what keeps this cheap in
  // the ordinary case: a workspace with no private channels does one query and
  // allows everything.
  const private_ = rows.filter((r) => r.isPrivate).map((r) => r.id);
  const allowed = new Set(rows.filter((r) => !r.isPrivate).map((r) => r.id));

  if (private_.length > 0) {
    const mine = await db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(
        and(
          inArray(schema.channelMembers.channelId, private_),
          eq(schema.channelMembers.userId, user.id),
        ),
      );
    for (const m of mine) allowed.add(m.channelId);
  }

  return requested.filter(
    (t) => !t.startsWith("channel:") || allowed.has(t.slice("channel:".length)),
  );
}

/**
 * One SSE connection per tab, multiplexed by topic:
 *
 *     GET /api/stream?topics=workspace,channel:<uuid>,agent:<uuid>
 *
 * Each frame carries its topic so the client can route without opening a
 * connection per room. Browsers cap concurrent connections per origin at
 * around six, so per-channel streams would starve each other once a few rooms
 * are open.
 */
const app = new Hono<AuthEnv>().get("/", authMiddleware, async (c) => {
  const requested: StreamTopic[] = parseTopics(c.req.query("topics"));
  const topics = await authorizeTopics(requested, c.get("session").user);
  if (topics.length === 0) topics.push("workspace");

  return streamSSE(c, async (stream) => {
    let closed = false;

    const unsubscribe = streamBus.subscribe(topics, (topic, ev: StreamEvent) => {
      if (closed) return;
      void stream.writeSSE({
        event: ev.type,
        data: JSON.stringify({ topic, ...ev }),
      });
    });

    // The abort signal fires on tab close, navigation, and network drop; without
    // unsubscribing here the bus would accumulate dead listeners for the life
    // of the process.
    const onAbort = () => {
      closed = true;
      unsubscribe();
    };
    c.req.raw.signal.addEventListener("abort", onAbort);

    await stream.writeSSE({ event: "ready", data: JSON.stringify({ topics }) });

    while (!closed) {
      await stream.sleep(HEARTBEAT_MS);
      if (closed) break;
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }

    unsubscribe();
  });
});

export default app;
