import { EventEmitter } from "node:events";

/**
 * Topic-keyed event bus behind the single multiplexed SSE endpoint.
 *
 * Generalises the per-user inbox bus this replaces. The key change is the
 * subscription shape: a tab opens ONE EventSource and names the topics it
 * cares about (`channel:<id>`, `agent:<id>`), rather than one connection per
 * channel. Browsers cap concurrent connections per origin at around six, so
 * per-channel streams would start starving each other in a workspace with a
 * handful of rooms open — and retrofitting the multiplex later is worse than
 * building it now.
 *
 * Single-instance only, like the bus it replaces. Multi-replica would want
 * Postgres LISTEN/NOTIFY here; nothing else about the design changes.
 */

export type StreamTopic = `channel:${string}` | `agent:${string}` | "workspace";

export type StreamEvent =
  | { type: "message.created"; channelId: string; messageId: string }
  | { type: "message.updated"; channelId: string; messageId: string }
  | { type: "agent.status"; agentId: string; status: string; activity: string }
  // The roster is a live list, not a snapshot: the rail renders on every route
  // and never remounts, so an agent that appears or disappears has to say so.
  // Without these it stays whatever it was when the tab was opened.
  // Membership changed. Carries no rows: an open dialog refetches, and the
  // header only needs to know its counts are stale.
  | { type: "channel.members"; channelId: string }
  | { type: "agent.created"; agentId: string }
  | { type: "agent.removed"; agentId: string }
  | { type: "agent.status_line"; agentId: string; statusLine: string | null }
  | { type: "run.updated"; agentId: string; runId: string; status: string }
  | { type: "dispatch.updated"; channelId: string; dispatchId: string; status: string };

type Listener = (topic: StreamTopic, ev: StreamEvent) => void;

class StreamBus {
  private emitters = new Map<StreamTopic, EventEmitter>();

  private getOrCreate(topic: StreamTopic): EventEmitter {
    let ee = this.emitters.get(topic);
    if (!ee) {
      ee = new EventEmitter();
      // Each subscribed tab adds one listener per topic. Well beyond realistic
      // usage, but high enough to suppress Node's default warning at 10.
      ee.setMaxListeners(200);
      this.emitters.set(topic, ee);
    }
    return ee;
  }

  /** Subscribe to several topics at once; returns a single unsubscribe fn. */
  subscribe(topics: StreamTopic[], listener: Listener): () => void {
    const bound = topics.map((topic) => {
      const handler = (ev: StreamEvent) => listener(topic, ev);
      this.getOrCreate(topic).on("event", handler);
      return { topic, handler };
    });

    return () => {
      for (const { topic, handler } of bound) {
        this.emitters.get(topic)?.off("event", handler);
      }
    };
  }

  emit(topic: StreamTopic, ev: StreamEvent): void {
    this.emitters.get(topic)?.emit("event", ev);
  }

  /** Fan one event out to several topics — e.g. a run touches its agent and its channel. */
  emitAll(topics: StreamTopic[], ev: StreamEvent): void {
    for (const topic of topics) this.emit(topic, ev);
  }

  /** Test seam. */
  reset(): void {
    this.emitters.clear();
  }
}

export const streamBus = new StreamBus();

/**
 * Parse the `topics` query parameter into validated topics.
 *
 * Rejects unknown prefixes rather than subscribing to a topic that can never
 * fire — a silent no-op subscription is very hard to debug from the client,
 * where it just looks like the server never sends anything.
 */
export function parseTopics(raw: string | undefined | null): StreamTopic[] {
  if (!raw) return [];
  const out: StreamTopic[] = [];
  for (const part of raw.split(",")) {
    const topic = part.trim();
    if (!topic) continue;
    if (topic === "workspace") {
      out.push("workspace");
    } else if (/^channel:[0-9a-f-]{36}$/i.test(topic)) {
      out.push(topic as StreamTopic);
    } else if (/^agent:[0-9a-f-]{36}$/i.test(topic)) {
      out.push(topic as StreamTopic);
    }
  }
  return [...new Set(out)];
}
