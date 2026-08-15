import { agentActivityConfig, toneTextVar } from "@/lib/agent-status";
import type { AgentActivity } from "@/db/schema";

/**
 * The **activity** signal: what the agent process is doing right now.
 *
 * A pill, never a dot — the dot on the avatar is the container's process
 * state, and the whole point of the design's first note is that these two
 * fail independently. Reading "running" and "busy" off one indicator is how
 * you end up mentioning an agent that will not answer for four minutes.
 */
export function ActivityPill({
  activity,
  size = "md",
}: {
  activity: AgentActivity;
  size?: "sm" | "md";
}) {
  const entry = agentActivityConfig[activity];
  const neutral = entry.tone === "neutral";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flex: "none",
        fontFamily: "var(--ny-font-mono)",
        fontSize: size === "sm" ? 9.5 : 10,
        fontWeight: neutral ? 400 : 600,
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: 20,
        color: toneTextVar(entry.tone),
        background: neutral ? "transparent" : `var(--ny-${entry.tone}-subtle)`,
        border: `1px solid ${neutral ? "var(--ny-border)" : `var(--ny-${entry.tone}-border)`}`,
      }}
    >
      {activity}
    </span>
  );
}
