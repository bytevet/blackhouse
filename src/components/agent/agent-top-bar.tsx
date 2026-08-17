import { AppHeader } from "@/components/app-header";

/**
 * The breadcrumb strip above the agent header: where you came from, where you
 * are, and the global controls every screen carries.
 *
 * A thin wrapper over `AppHeader` rather than its own bar. It used to be a
 * separate implementation — a couple of pixels shorter than the equivalent
 * strips on `/agents` and `/settings`, with a hand-rolled theme button in place
 * of `ThemeToggle` and no language switcher at all — so both the bar's height
 * and its controls changed as you moved between screens.
 */
export interface AgentTopBarProps {
  /** Channel slug to return to, when we know it. */
  backChannel?: string | null;
  handle: string;
}

export function AgentTopBar({ backChannel, handle }: AgentTopBarProps) {
  // Arriving from a channel, "back" is that channel and the roster is a step in
  // the trail. Arriving from the roster, "back" is the roster — and repeating it
  // as a crumb would render "agents / agents / @scout".
  return backChannel ? (
    <AppHeader
      back={{ label: `#${backChannel}`, to: `/channels/${backChannel}` }}
      crumbs={[{ label: "agents", to: "/agents" }, { label: `@${handle}` }]}
    />
  ) : (
    <AppHeader back={{ label: "agents", to: "/agents" }} crumbs={[{ label: `@${handle}` }]} />
  );
}
