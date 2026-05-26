import { useEffect, useMemo, useState } from "react";

/**
 * Server-pushed event shape. Wire contract — must match
 * `server/lib/inbox-events.ts` emit payload exactly.
 */
export interface InboxEvent {
  type: "unread-changed";
  sessionId: string;
  unreadCount: number;
}

export interface UseInboxEventsResult {
  /** Map of session id → current unread count. Only contains sessions with at
   *  least one observed unread count (initial hydration + SSE deltas). */
  unreadBySession: Record<string, number>;
  /** Sum across all known sessions — drives the sidebar Roster aggregate. */
  totalUnread: number;
}

/**
 * Subscribes to `/api/inbox-events` via EventSource and tracks per-session
 * unread counts. Initial state is hydrated from `initial` (passed in by the
 * caller from the session-list response's `unreadCount` column, avoiding a
 * flash-of-zero on first paint); SSE deltas drive all subsequent updates.
 *
 * EventSource handles reconnect natively. The server's per-user emitter is
 * in-memory and does not replay missed events, so a long disconnect may
 * leave counts momentarily stale until the next delta lands. Callers that
 * need stronger guarantees can re-mount the hook or trigger a list refetch.
 *
 * No-op guard on equal counts prevents unnecessary re-renders when the
 * server re-emits the same value (e.g. duplicate ack-batch broadcasts).
 */
export function useInboxEvents(initial: Record<string, number> = {}): UseInboxEventsResult {
  const [unread, setUnread] = useState<Record<string, number>>(initial);

  useEffect(() => {
    const es = new EventSource("/api/inbox-events");
    es.onmessage = (e) => {
      let ev: InboxEvent;
      try {
        ev = JSON.parse(e.data) as InboxEvent;
      } catch {
        // Malformed payload — server contract is JSON-only; drop and wait.
        return;
      }
      if (ev.type !== "unread-changed") return;
      setUnread((prev) => {
        if (prev[ev.sessionId] === ev.unreadCount) return prev;
        return { ...prev, [ev.sessionId]: ev.unreadCount };
      });
    };
    return () => es.close();
  }, []);

  const totalUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);

  return { unreadBySession: unread, totalUnread };
}
