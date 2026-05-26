import { useCallback, useEffect, useMemo, useState } from "react";

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
  /** Merge a batch of session-id → count entries into state. Called by the
   *  dashboard after each `GET /api/sessions` fetch so the sidebar aggregate
   *  reflects the (possibly paginated) session list immediately, before the
   *  first SSE delta lands. Incoming values override existing ones — SSE will
   *  correct any divergence on its next emit. */
  mergeUnread: (counts: Record<string, number>) => void;
}

/**
 * Subscribes to `/api/inbox-events` via EventSource and tracks per-session
 * unread counts. State is populated by two paths: the consumer calling
 * `mergeUnread` with values from a list fetch (avoids flash-of-zero on the
 * sidebar aggregate), and SSE deltas driving live updates thereafter.
 *
 * EventSource handles reconnect natively. The server's per-user emitter is
 * in-memory and does not replay missed events, so a long disconnect may
 * leave counts momentarily stale until the next delta lands. Callers that
 * need stronger guarantees can re-mount the hook or trigger a list refetch.
 *
 * No-op guards on equal counts prevent unnecessary re-renders when the
 * server re-emits the same value (e.g. duplicate ack-batch broadcasts) or
 * the dashboard re-seeds an already-current set.
 */
export function useInboxEvents(): UseInboxEventsResult {
  const [unread, setUnread] = useState<Record<string, number>>({});

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

  const mergeUnread = useCallback((counts: Record<string, number>) => {
    setUnread((prev) => {
      // Same-reference short-circuit — skip the re-render when every incoming
      // value already matches state. Important because the dashboard calls
      // this on every filter/pagination refetch, and most refetches return
      // the same counts the SSE channel has already delivered.
      let changed = false;
      for (const id in counts) {
        if (prev[id] !== counts[id]) {
          changed = true;
          break;
        }
      }
      return changed ? { ...prev, ...counts } : prev;
    });
  }, []);

  const totalUnread = useMemo(() => Object.values(unread).reduce((a, b) => a + b, 0), [unread]);

  return { unreadBySession: unread, totalUnread, mergeUnread };
}
