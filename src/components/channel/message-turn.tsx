import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { RunStatus } from "@/db/schema";
import { toneTextVar, toneVar, type StatusTone } from "@/lib/agent-status";
import { AgentAvatar } from "./agent-avatar";
import { compactCount, duration } from "./format";
import { ToolCallRow } from "./tool-call-row";
import type { AgentView, TurnView } from "./types";

/** Run outcome → tone. Distinct from agent status/activity: this is one run. */
const RUN_TONE: Record<RunStatus, { tone: StatusTone; pulse: boolean }> = {
  queued: { tone: "warning", pulse: true },
  injecting: { tone: "info", pulse: true },
  running: { tone: "info", pulse: true },
  done: { tone: "success", pulse: false },
  failed: { tone: "danger", pulse: false },
  cancelled: { tone: "neutral", pulse: false },
};

/**
 * An agent turn — every tool call it made answering one mention.
 *
 * **Collapsed by default**, to a single summary row. This is the highest-volume
 * thing in the transcript by an order of magnitude: a channel with three busy
 * agents produces hundreds of tool calls an hour, and if they render at the
 * same weight as prose the channel becomes unreadable, so the default state
 * is "one line saying it happened".
 *
 * Expanded, it is a monospace list and nothing else — no cards, no avatars per
 * row. The turn's job when open is to be *skimmable*, not expressive.
 */
export function MessageTurn({
  agent,
  turn,
  defaultOpen = false,
}: {
  agent: AgentView;
  turn: TurnView;
  /** Collapsed unless a caller has a reason — a failed run, say. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const outcome = RUN_TONE[turn.status];

  return (
    <div style={{ display: "flex", gap: 12, padding: "2px 8px" }}>
      {/* Rail: an agent turn hangs off the conversation, it does not restart it. */}
      <div style={{ width: 38, flex: "none", display: "flex", justifyContent: "center" }}>
        <div
          aria-hidden
          style={{ width: 2, background: "var(--ny-border)", borderRadius: 2, marginTop: 2 }}
        />
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: "1px solid var(--ny-border)",
          borderRadius: 10,
          background: "var(--ny-surface-sunken)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          className="bh-reset bh-hover bh-focusable"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 12px",
            cursor: "pointer",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              flex: "none",
              color: "var(--ny-text-subtle)",
              transition: "transform 150ms var(--ny-ease-standard, ease)",
              transform: `rotate(${open ? 90 : 0}deg)`,
            }}
          >
            <ChevronRight size={12} strokeWidth={2.5} />
          </span>

          <AgentAvatar agent={agent} size={22} showStatus={false} />

          <span
            style={{
              fontFamily: "var(--ny-font-mono)",
              fontSize: 12.5,
              color: "var(--ny-text-muted)",
              flex: "none",
            }}
          >
            <b style={{ color: "var(--ny-text)", fontWeight: 600 }}>@{agent.handle}</b> worked
          </span>

          <span
            style={{
              fontFamily: "var(--ny-font-mono)",
              fontSize: 12,
              color: "var(--ny-text-subtle)",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {turn.toolCallCount} tool calls · {duration(turn.durationMs)} ·{" "}
            {compactCount(turn.tokens)} tokens
          </span>

          <span
            style={{
              marginLeft: "auto",
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--ny-font-mono)",
              fontSize: 11,
              color: toneTextVar(outcome.tone),
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: toneVar(outcome.tone),
                animation: outcome.pulse ? "bhPulse 1.6s ease-in-out infinite" : undefined,
              }}
            />
            {turn.status}
          </span>
        </button>

        {open && (
          <div
            id={bodyId}
            style={{
              borderTop: "1px solid var(--ny-border)",
              padding: "4px 12px 8px",
              fontFamily: "var(--ny-font-mono)",
              fontSize: 12.5,
            }}
          >
            {turn.toolCalls.map((call) => (
              <ToolCallRow key={call.id} call={call} />
            ))}
            {turn.toolCalls.length < turn.toolCallCount && (
              <div style={{ padding: "5px 2px", color: "var(--ny-text-subtle)", fontSize: 11 }}>
                … {turn.toolCallCount - turn.toolCalls.length} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
