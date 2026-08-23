import type { EgressPolicy, SandboxRuntime } from "@/db/schema";
import type { AgentDetail, RuntimeAvailability } from "./agent-data";

/**
 * Pure descriptors for the three facts the agent header has to state
 * truthfully: what sandbox actually ran, what the network policy is, and how
 * much of today's budget is gone.
 *
 * Kept out of the components because each one encodes a judgement about what
 * the user must not be allowed to misread, and those judgements deserve to sit
 * somewhere a reviewer can find them.
 */

/** `Badge`'s tone vocabulary from `@notyet.im/ui`. */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

// ---------------------------------------------------------------------------
// Sandbox runtime
// ---------------------------------------------------------------------------

/**
 * `runsc` is the binary; gVisor is the product. Operators read release notes
 * and `docker info` output, so both names have to appear somewhere — the badge
 * shows the familiar one and the detail line names the binary.
 */
export const RUNTIME_LABELS: Record<string, string> = {
  runc: "runc",
  runsc: "gVisor",
  kata: "Kata",
  auto: "auto",
};

export function runtimeLabel(runtime: string | null | undefined): string {
  if (!runtime) return "unknown";
  return RUNTIME_LABELS[runtime] ?? runtime;
}

export interface RuntimeFact {
  /** Badge text. Always describes what *ran*, never what was asked for. */
  label: string;
  tone: BadgeTone;
  /** A concrete request was not honoured — the isolation is weaker than configured. */
  fellBack: boolean;
  /** Nothing has run yet, so there is no effective runtime to report. */
  pending: boolean;
  /** What was asked for, for the "requested X" half of the badge. */
  requestedLabel: string;
  /** One sentence, shown under the badge when `fellBack` and in the tooltip otherwise. */
  detail: string;
}

/**
 * Reconcile `agents.sandboxRuntime` (requested) with `agents.runtimeUsed`
 * (what the driver actually selected).
 *
 * The whole point of surfacing this: gVisor is absent on Docker Desktop and on
 * Podman, so falling back to `runc` is the common case, and a silent fallback
 * lets someone believe an agent running untrusted model-authored code has a
 * syscall boundary it does not have. A mismatch is therefore rendered as a
 * warning the user has to actively dismiss reading, not as a quiet tooltip.
 *
 * `auto` is not a mismatch: it asked the host to choose, and the host chose.
 * It still says *which* way it resolved, because "auto" alone tells you
 * nothing about the isolation you got.
 */
export function describeRuntime(
  requested: SandboxRuntime | null | undefined,
  used: string | null | undefined,
  availability?: RuntimeAvailability | null,
): RuntimeFact {
  const requestedKey = requested ?? "auto";
  const requestedLabel = runtimeLabel(requestedKey);

  if (!used) {
    return {
      label: requestedLabel,
      tone: "neutral",
      fellBack: false,
      pending: true,
      requestedLabel,
      detail:
        requestedKey === "auto"
          ? "Not started — the runtime is resolved when the container is created."
          : `Requested ${requestedLabel}. Not started yet, so nothing has been selected.`,
    };
  }

  const usedLabel = runtimeLabel(used);
  const runscAvailable = availability ? availability.runtimes.includes("runsc") : null;

  if (requestedKey === "auto") {
    if (used === "runc") {
      return {
        label: usedLabel,
        tone: "neutral",
        fellBack: false,
        pending: false,
        requestedLabel,
        detail:
          runscAvailable === false
            ? "auto → runc. gVisor (runsc) is not registered with this Docker daemon, so this agent shares the host kernel."
            : "auto → runc. This agent shares the host kernel; there is no syscall boundary between it and the machine.",
      };
    }
    return {
      label: usedLabel,
      tone: used === "runsc" ? "info" : "accent",
      fellBack: false,
      pending: false,
      requestedLabel,
      detail: `auto → ${usedLabel} (${used}).`,
    };
  }

  if (used === requestedKey) {
    return {
      label: usedLabel,
      tone: used === "runsc" ? "info" : used === "kata" ? "accent" : "neutral",
      fellBack: false,
      pending: false,
      requestedLabel,
      detail: `Running under ${usedLabel} (${used}), as requested.`,
    };
  }

  return {
    label: usedLabel,
    tone: "danger",
    fellBack: true,
    pending: false,
    requestedLabel,
    detail:
      `This agent asked for ${requestedLabel} but the host fell back to ${usedLabel} (${used}). ` +
      `It is running with weaker isolation than it was configured for` +
      (runscAvailable === false && requestedKey === "runsc"
        ? " — runsc is not registered with this Docker daemon."
        : "."),
  };
}

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

export interface EgressFact {
  label: string;
  tone: BadgeTone;
  detail: string;
  /** Whether the header should draw attention to it. */
  permissive: boolean;
  /** A restrictive policy is configured but nothing is applying it. */
  unenforced: boolean;
}

/**
 * Describe the policy an agent **actually gets**.
 *
 * Feed this the resolved mode from `GET /api/egress/agents/:id/effective`, not
 * `agents.egressPolicy`: that column is nullable and null means "inherit the
 * blueprint", so it cannot answer the only question this badge is asked.
 *
 * `open` is the permissive setting, so it is the one the badge argues with.
 * `allowlist` carries its host count inline — "allowlist" with an empty list
 * and "allowlist" with forty entries are very different postures.
 *
 * `enforced` is the instance-wide switch. A restrictive policy that nothing
 * applies is the network twin of a silent sandbox fallback: the badge would
 * claim a boundary the agent does not have, which is precisely the failure
 * this whole surface exists to prevent. Unenforced `open` is still open, so
 * only the restrictive modes change.
 */
export function describeEgress(
  policy: EgressPolicy | null | undefined,
  allowlistCount: number,
  enforced = true,
): EgressFact {
  const unenforced = !enforced && (policy === "allowlist" || policy === "none");
  const unenforcedNote =
    " Egress enforcement is off for this instance, so the policy is recorded but not applied — the agent can currently reach any host.";

  switch (policy) {
    case "open":
      return {
        label: "open",
        tone: "warning",
        detail: "No egress restriction — this agent can reach any host on the internet.",
        permissive: true,
        unenforced: false,
      };
    case "none":
      return {
        label: "no network",
        tone: unenforced ? "warning" : "neutral",
        detail:
          "No outbound network. Package installs and API calls will fail by design." +
          (unenforced ? unenforcedNote : ""),
        permissive: unenforced,
        unenforced,
      };
    case "allowlist":
      return {
        label: `allowlist · ${allowlistCount}`,
        tone: unenforced ? "warning" : "success",
        detail:
          `Outbound traffic is proxied and limited to ${allowlistCount} allowed host${
            allowlistCount === 1 ? "" : "s"
          }.` + (unenforced ? unenforcedNote : ""),
        permissive: unenforced,
        unenforced,
      };
    default:
      // Only reachable if a caller passes the raw, unresolved column. Kept as
      // a defensive branch rather than a state the UI is expected to render.
      return {
        label: "inherited",
        tone: "neutral",
        detail: "No per-agent override — the blueprint's egress policy applies.",
        permissive: false,
        unenforced: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Blueprint resource caps
// ---------------------------------------------------------------------------

export interface ResourceCaps {
  /** `"2 vCPU"`, or null when `agent_blueprints.nano_cpus` is unset. */
  cpu: string | null;
  /** `"4 GiB"`, or null when `agent_blueprints.memory_bytes` is unset. */
  memory: string | null;
}

/**
 * Blueprint container caps, with an absent cap reported as absent.
 *
 * Null is **not** a default to fill in. An unset `memory_bytes` means the
 * container gets whatever the daemon allows, which on a single-host install is
 * the whole machine — the opposite of the reassuring "4 GB RAM" the mock
 * blueprint printed for every agent regardless of its row. So a missing cap
 * renders as nothing at all rather than as a plausible number.
 */
export function describeResourceCaps(caps: {
  nanoCpus: number | null;
  memoryBytes: number | null;
}): ResourceCaps {
  return {
    cpu: caps.nanoCpus && caps.nanoCpus > 0 ? `${trimNumber(caps.nanoCpus / 1e9)} vCPU` : null,
    memory: formatBytes(caps.memoryBytes),
  };
}

/** Binary units, because that is what Docker means by `Memory`. */
function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${trimNumber(gib)} GiB`;
  return `${trimNumber(bytes / 1024 ** 2)} MiB`;
}

/** `2` stays `2`, `1.5` stays `1.5`, and `3.9999999` becomes `4`. */
function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** `420` → `"$4.20"`. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BudgetFact {
  capped: boolean;
  spentCents: number;
  capCents: number | null;
  /** 0–100, clamped, for the meter fill. */
  fillPct: number;
  tone: BadgeTone;
  /** `"$4.20 / $10.00"`, or `"$4.20"` when uncapped. */
  amountLabel: string;
  paused: boolean;
  detail: string;
}

/**
 * Budget is a *daily* window with a pause on breach — not a lifetime counter
 * and not a stop. The copy says "pauses" everywhere because that is the
 * product behaviour: the container and the TUI stay up and attachable, and
 * only new runs are refused.
 */
export function describeBudget(agent: AgentDetail): BudgetFact {
  const spentCents = agent.spentCentsToday ?? 0;
  const capCents = agent.dailyBudgetCents ?? null;
  const paused = Boolean(agent.pausedAt);

  if (capCents === null || capCents <= 0) {
    return {
      capped: false,
      spentCents,
      capCents: null,
      fillPct: 0,
      tone: "neutral",
      amountLabel: formatCents(spentCents),
      paused,
      detail: "No daily cap. Spend is tracked but nothing pauses this agent.",
    };
  }

  const ratio = spentCents / capCents;
  const fillPct = Math.max(0, Math.min(100, ratio * 100));
  const tone: BadgeTone = ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "success";

  return {
    capped: true,
    spentCents,
    capCents,
    fillPct,
    tone,
    amountLabel: `${formatCents(spentCents)} / ${formatCents(capCents)}`,
    paused,
    detail: paused
      ? "Daily cap reached — the agent is paused. Its container and terminal stay up; new runs are refused until the window resets."
      : ratio >= 1
        ? "Daily cap reached. New runs are refused until the window resets."
        : `${formatCents(Math.max(0, capCents - spentCents))} left today. At the cap the agent pauses — container and terminal stay up, new runs are refused.`,
  };
}

/** Initials for the avatar tile: `"Scout"` → `"SC"`, `"Repo Summariser"` → `"RS"`. */
export function initialsOf(displayName: string, handle: string): string {
  const source = displayName.trim() || handle;
  const words = source.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}
