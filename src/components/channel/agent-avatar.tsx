import { agentActivityConfig, agentStatusConfig, toneVar } from "@/lib/agent-status";
import { initials } from "./format";
import type { AgentView } from "./types";

interface AgentAvatarProps {
  agent: AgentView;
  /** Edge length in px. 22 in a turn summary, 30 in the roster, 38 in the transcript. */
  size?: number;
  /**
   * Background of the surface the avatar sits on. The process dot is punched
   * out of the avatar with a border in this colour, so it reads as a hole
   * rather than a floating circle.
   */
  surface?: string;
  /** Suppress the process dot where the container state is not the point. */
  showStatus?: boolean;
  /** Agents that authored a message get the accent border, per the design. */
  emphasis?: boolean;
}

/**
 * An agent's avatar tile carrying **one** of the two state signals: the
 * process dot for `agents.status` (the container).
 *
 * `agents.activity` is deliberately not rendered here — it gets its own pill
 * next to the handle. The only nod to activity is the ring animation, which
 * is drawn in the *activity* tone precisely so it cannot be mistaken for the
 * process colour underneath it. A running agent can be idle; a busy agent can
 * be in a container that just died. Folding them into one indicator loses the
 * distinction exactly when you need it.
 */
export function AgentAvatar({
  agent,
  size = 30,
  surface = "var(--ny-surface-sunken)",
  showStatus = true,
  emphasis = false,
}: AgentAvatarProps) {
  const status = agentStatusConfig[agent.status];
  const activity = agentActivityConfig[agent.activity];
  const dotSize = size <= 26 ? 8 : 10;
  const offset = size <= 26 ? -1 : -2;

  return (
    <span
      style={{
        position: "relative",
        flex: "none",
        display: "inline-block",
        width: size,
        height: size,
      }}
      title={`${agent.status} container · ${agent.activity}`}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: size,
          height: size,
          borderRadius: Math.max(6, Math.round(size * 0.26)),
          background: "var(--ny-surface-raised)",
          border: `1px solid ${emphasis ? "var(--ny-accent-border)" : "var(--ny-border-strong)"}`,
          color: emphasis ? "var(--ny-accent-text)" : "var(--ny-text)",
          fontFamily: "var(--ny-font-mono)",
          fontWeight: 700,
          fontSize: Math.max(9, Math.round(size * 0.36)),
          letterSpacing: "-0.02em",
          // The ring is the *activity* signal, in the activity tone.
          ...(activity.ring
            ? {
                ["--bh-ring-color" as string]: toneVar(activity.tone),
                animation: "bhRing 1.8s ease-out infinite",
              }
            : null),
        }}
      >
        {initials(agent.displayName || agent.handle)}
      </span>
      {showStatus && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: offset,
            bottom: offset,
            width: dotSize,
            height: dotSize,
            borderRadius: "50%",
            background: toneVar(status.tone),
            border: `2px solid ${surface}`,
            animation: status.pulse ? "bhPulse 1.6s ease-in-out infinite" : undefined,
          }}
        />
      )}
    </span>
  );
}

/** A human's avatar — a circle, so it never reads as an agent tile. */
export function UserAvatar({ name, size = 38 }: { name: string; size?: number }) {
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        flex: "none",
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--ny-info-subtle)",
        color: "var(--ny-info-text)",
        fontSize: Math.max(10, Math.round(size * 0.34)),
        fontWeight: 700,
      }}
    >
      {initials(name)}
    </span>
  );
}
