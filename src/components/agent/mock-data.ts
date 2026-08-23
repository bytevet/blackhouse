/**
 * ⚠️ MOCK DATA — the last place Agent Detail invents anything.
 *
 * What is left is the artifacts grid. There is still no artifact-history
 * endpoint, so every card except "Latest result" is a placeholder with no
 * bytes behind it — kept here, behind a `MOCK_` prefix, so the next person can
 * tell a fabricated value from a real field without reading three components.
 *
 * The blueprint and egress placeholders that used to live here are gone. They
 * were the worst kind: `mockBlueprint()` hashed the blueprint id into one of
 * three invented names and reported `ui-explorer` for a Claude Code agent, and
 * a hardcoded four-host `MOCK_EGRESS_ALLOWLIST` made the header read
 * `allowlist · 4` for an agent whose resolved policy was `open`. Egress is a
 * safety surface: that badge claimed an isolation boundary that did not exist.
 * Both now come from `GET /api/agents/:id/blueprint` and
 * `GET /api/egress/agents/:id/effective` — see `agent-data.ts`.
 */

/** Human-facing note attached to any UI that renders mock values. */
export const MOCK_NOTICE = "Placeholder data — this endpoint is not implemented yet.";

// ---------------------------------------------------------------------------
// Artifacts — replace with GET /api/agents/:id/artifacts
// ---------------------------------------------------------------------------

export interface MockArtifact {
  id: string;
  name: string;
  meta: string;
  tone: "info" | "success" | "neutral" | "accent";
  /**
   * The one artifact that maps onto something real: the agent's latest
   * submitted HTML result, which `ResultViewer` already knows how to fetch.
   * Everything else in this list has no backing bytes yet.
   */
  live: boolean;
}

export const MOCK_ARTIFACTS: MockArtifact[] = [
  {
    id: "latest",
    name: "Latest result",
    meta: "live · submitted by the agent",
    tone: "info",
    live: true,
  },
  {
    id: "checkout-flow-map",
    name: "checkout-flow-map.html",
    meta: "today 10:24 · 24 KB",
    tone: "info",
    live: false,
  },
  {
    id: "test-report",
    name: "test-report.html",
    meta: "today 09:58 · 61 KB",
    tone: "success",
    live: false,
  },
  {
    id: "coverage-summary",
    name: "coverage-summary.html",
    meta: "yesterday · 18 KB",
    tone: "neutral",
    live: false,
  },
  {
    id: "schema-erd",
    name: "schema-erd.html",
    meta: "2d ago · 44 KB",
    tone: "accent",
    live: false,
  },
];
