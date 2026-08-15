import { useEffect, useRef, useState } from "react";

/**
 * The client half of `GET /api/stream` — **one EventSource per tab**, not one
 * per room.
 *
 * The server multiplexes by topic for a reason: browsers cap concurrent
 * connections per origin at around six, so a connection per open channel starts
 * starving the rest of the app once a handful are open. This hook keeps that
 * contract by treating the joined topic list as the connection's identity: it
 * reconnects when (and only when) the set of topics actually changes, which in
 * practice means when you switch channels. Re-renders, new handlers, and state
 * updates do not touch the socket — the handler lives in a ref for exactly that
 * reason.
 *
 * Cleanup closes the source on unmount. That is not hygiene, it is required:
 * the server holds one bus listener per open connection for the life of the
 * process, so a leaked EventSource leaks a listener with it.
 */

/** Mirrors `StreamEvent` in `server/lib/stream-bus.ts`, plus the topic the
 *  frame arrived on (the server stamps it into every payload). */
export type ChannelStreamEvent =
  | { topic: string; type: "message.created"; channelId: string; messageId: string }
  | { topic: string; type: "message.updated"; channelId: string; messageId: string }
  | { topic: string; type: "agent.status"; agentId: string; status: string; activity: string }
  | { topic: string; type: "agent.status_line"; agentId: string; statusLine: string | null }
  | { topic: string; type: "run.updated"; agentId: string; runId: string; status: string }
  | {
      topic: string;
      type: "dispatch.updated";
      channelId: string;
      dispatchId: string;
      status: string;
    };

const EVENT_TYPES = [
  "message.created",
  "message.updated",
  "agent.status",
  "agent.status_line",
  "run.updated",
  "dispatch.updated",
] as const;

export interface ChannelStream {
  /** False between a drop and the browser's automatic retry. */
  connected: boolean;
}

export function useChannelStream(
  topics: string[],
  onEvent: (event: ChannelStreamEvent) => void,
): ChannelStream {
  const [connected, setConnected] = useState(false);

  // The handler changes on nearly every render (it closes over state). Holding
  // it in a ref keeps it out of the effect's dependencies, so a re-render never
  // costs a reconnect.
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // Dedupe and sort so ["workspace", "channel:x"] and ["channel:x", "workspace"]
  // are the same connection rather than a needless reconnect.
  const key = [...new Set(topics)].sort().join(",");

  useEffect(() => {
    if (!key) return;

    const source = new EventSource(`/api/stream?topics=${encodeURIComponent(key)}`);

    const listeners = EVENT_TYPES.map((type) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          handler.current(JSON.parse(event.data) as ChannelStreamEvent);
        } catch {
          // A frame we cannot parse is a frame we cannot act on. Dropping it is
          // right; throwing inside an event listener would kill the stream.
        }
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    const onReady = () => setConnected(true);
    source.addEventListener("ready", onReady);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => {
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.removeEventListener("ready", onReady);
      source.close();
      setConnected(false);
    };
  }, [key]);

  return { connected };
}
