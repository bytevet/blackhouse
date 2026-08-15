/**
 * ⚠️ MOCK DATA — the single place Agent Detail invents anything.
 *
 * Everything here is a placeholder for an endpoint that does not exist yet.
 * `server/api/` currently ships `agents`, `auth`, `settings` and `skills`
 * only: there is no blueprints route, no artifacts route, and no egress-rules
 * route. Rather than scatter plausible-looking constants through the header
 * and the panes — where the next person would have no way to tell real fields
 * from invented ones — every fabricated value lives here behind a `MOCK_`
 * prefix, with the endpoint that should replace it named in a comment.
 *
 * Nothing in this module is derived from the agent's real row except the id,
 * which is used only to keep the placeholders stable per agent.
 */

import type { AgentCli } from "@/db/schema";

/** Human-facing note attached to any UI that renders mock values. */
export const MOCK_NOTICE = "Placeholder data — this endpoint is not implemented yet.";

// ---------------------------------------------------------------------------
// Blueprint — replace with GET /api/blueprints/:id
// ---------------------------------------------------------------------------

export interface MockBlueprint {
  name: string;
  cli: AgentCli;
  /** Container resource caps, from `agent_blueprints.nano_cpus` / `memory_bytes`. */
  vcpus: number;
  memoryGb: number;
  /** Shell the CLI runs under, for the terminal chrome's title. */
  shell: string;
}

const MOCK_BLUEPRINTS: MockBlueprint[] = [
  { name: "repo-summariser", cli: "claude-code", vcpus: 2, memoryGb: 4, shell: "zsh" },
  { name: "test-runner", cli: "codex", vcpus: 4, memoryGb: 8, shell: "bash" },
  { name: "ui-explorer", cli: "antigravity", vcpus: 2, memoryGb: 4, shell: "bash" },
];

/** Deterministic per blueprint id, so the header does not reshuffle on re-render. */
export function mockBlueprint(blueprintId: string | null | undefined): MockBlueprint {
  const key = blueprintId ?? "";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return MOCK_BLUEPRINTS[hash % MOCK_BLUEPRINTS.length]!;
}

// ---------------------------------------------------------------------------
// Egress allowlist — replace with GET /api/settings/egress?scope=agent:<id>
// ---------------------------------------------------------------------------

export const MOCK_EGRESS_ALLOWLIST: string[] = [
  "github.com",
  "registry.npmjs.org",
  "api.anthropic.com",
  "*.sentry.io",
];

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
