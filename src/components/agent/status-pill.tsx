import type { CSSProperties, ReactNode } from "react";
import { toneTextVar, toneVar, type StatusTone } from "@/lib/agent-status";

/**
 * The rounded mono pill the design uses for process state and activity.
 *
 * The tone → colour mapping is **not** re-declared here: `toneVar` and
 * `toneTextVar` in `src/lib/agent-status.ts` remain the single source. What
 * this adds is the two derived surfaces a pill needs — a tinted background and
 * a border — which the token set exposes as `--ny-<tone>-subtle` /
 * `--ny-<tone>-border` for every tone except `neutral`, where there is no
 * `--ny-neutral-*` family and the plain surface tokens are the right answer.
 */

export function toneSubtleVar(tone: StatusTone): string {
  return tone === "neutral" ? "var(--ny-surface-raised)" : `var(--ny-${tone}-subtle)`;
}

export function toneBorderVar(tone: StatusTone): string {
  return tone === "neutral" ? "var(--ny-border)" : `var(--ny-${tone}-border)`;
}

export interface StatusPillProps {
  tone: StatusTone;
  /** Draw the small solid dot before the label. */
  dot?: boolean;
  /** Pulse the dot — for transient states like `creating`. */
  pulse?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  title?: string;
}

export function StatusPill({
  tone,
  dot = false,
  pulse = false,
  children,
  style,
  title,
}: StatusPillProps) {
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11,
        lineHeight: 1.5,
        color: toneTextVar(tone),
        background: toneSubtleVar(tone),
        border: `1px solid ${toneBorderVar(tone)}`,
        borderRadius: 20,
        padding: "2px 9px",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {dot && (
        <span
          className="bh-pulse"
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: toneVar(tone),
            flex: "none",
            animation: pulse ? "bhPulse 1.8s ease-in-out infinite" : undefined,
          }}
        />
      )}
      {children}
    </span>
  );
}
