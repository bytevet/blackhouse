import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware, type AuthEnv } from "../middleware/auth.js";
import { streamBus, parseTopics, type StreamEvent, type StreamTopic } from "../lib/stream-bus.js";

/** Keeps proxies from reaping an idle connection. */
const HEARTBEAT_MS = 15_000;

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
  const topics: StreamTopic[] = parseTopics(c.req.query("topics"));
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
