import { createContext, useContext } from "react";
import type { UseInboxEventsResult } from "@/hooks/use-inbox-events";

/**
 * Context object for the inter-session messaging unread state. The matching
 * provider lives in `inbox-events-provider.tsx`; consumers should use the
 * `useInboxEventsContext` hook below rather than reading the context directly.
 *
 * Split from the provider so this file stays JSX-free — react-refresh's
 * `only-export-components` rule fires when a `.tsx` mixes a component export
 * with non-component exports (the context object + hook).
 */
export const InboxEventsContext = createContext<UseInboxEventsResult | null>(null);

export function useInboxEventsContext(): UseInboxEventsResult {
  const ctx = useContext(InboxEventsContext);
  if (!ctx) {
    throw new Error("useInboxEventsContext must be used within an InboxEventsProvider");
  }
  return ctx;
}
