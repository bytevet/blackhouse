import type { ReactNode } from "react";
import { useInboxEvents } from "@/hooks/use-inbox-events";
import { InboxEventsContext } from "./inbox-events-context";

/**
 * Single-EventSource provider for the inter-session messaging unread state.
 * Mounted in `AppLayout` so the dashboard (per-card badges) and the sidebar
 * (aggregate Roster badge) share one `/api/sessions/inbox-events` connection per tab
 * — opening two would double the server-side fan-out cost for no benefit.
 */
export function InboxEventsProvider({ children }: { children: ReactNode }) {
  const value = useInboxEvents();
  return <InboxEventsContext.Provider value={value}>{children}</InboxEventsContext.Provider>;
}
