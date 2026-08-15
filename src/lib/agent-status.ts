import type { AgentStatus, AgentActivity } from "@/db/schema";

/**
 * Agent state is **two independent signals**, and conflating them is the
 * mistake this module exists to prevent:
 *
 * - `status` is the *container*: creating / running / stopped / error / destroyed.
 * - `activity` is the *agent process inside it*: idle / busy / unknown.
 *
 * A running agent can be idle, and a busy agent whose container just died is
 * momentarily "running + busy" until the sidecar heartbeat lapses. The design
 * renders them differently for exactly this reason — a coloured dot on the
 * avatar for the process, a pill beside the handle for the activity.
 *
 * Colours are `--ny-*` semantic tokens from NotYet UI rather than literal
 * values, so light and dark both work without a second definition.
 */

/** Semantic tone names that map onto `--ny-<tone>` token families. */
export type StatusTone = "success" | "danger" | "warning" | "info" | "neutral";

export interface AgentStatusEntry {
  /** Tone for the process dot on the agent's avatar. */
  tone: StatusTone;
  /** i18n key for the human-readable label. */
  labelKey: string;
  /** Should the dot pulse? Reserved for transient states. */
  pulse: boolean;
}

export const agentStatusConfig: Record<AgentStatus, AgentStatusEntry> = {
  creating: { tone: "warning", labelKey: "agentStatus.creating", pulse: true },
  running: { tone: "success", labelKey: "agentStatus.running", pulse: false },
  stopped: { tone: "neutral", labelKey: "agentStatus.stopped", pulse: false },
  error: { tone: "danger", labelKey: "agentStatus.error", pulse: false },
  destroyed: { tone: "neutral", labelKey: "agentStatus.destroyed", pulse: false },
};

export interface AgentActivityEntry {
  tone: StatusTone;
  labelKey: string;
  /**
   * Busy agents ring, so a roster of ten reads at a glance. `unknown` does not
   * ring: it means the sidecar heartbeat lapsed, which is an absence of
   * information rather than an event worth drawing the eye to.
   */
  ring: boolean;
}

export const agentActivityConfig: Record<AgentActivity, AgentActivityEntry> = {
  idle: { tone: "neutral", labelKey: "agentActivity.idle", ring: false },
  busy: { tone: "info", labelKey: "agentActivity.busy", ring: true },
  unknown: { tone: "neutral", labelKey: "agentActivity.unknown", ring: false },
};

/** CSS custom-property reference for a tone's solid colour. */
export function toneVar(tone: StatusTone): string {
  return tone === "neutral" ? "var(--ny-text-subtle)" : `var(--ny-${tone})`;
}

/** CSS custom-property reference for a tone's text colour on a subtle background. */
export function toneTextVar(tone: StatusTone): string {
  return tone === "neutral" ? "var(--ny-text-subtle)" : `var(--ny-${tone}-text)`;
}

/** Can this agent accept an injected prompt right now? */
export function canAcceptInjection(status: AgentStatus): boolean {
  return status === "running";
}

/**
 * Whether a queued message would deliver immediately. `unknown` counts as
 * deliverable: the dispatcher falls back to PTY quiescence when the sidecar
 * has not reported, and refusing to ever deliver to an agent whose sidecar is
 * silent would strand every non-Claude-Code CLI.
 */
export function deliversImmediately(activity: AgentActivity): boolean {
  return activity !== "busy";
}
