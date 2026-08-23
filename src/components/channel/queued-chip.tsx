import type { QueuedView } from "./types";

/**
 * A message that has been posted but whose run has not been injected yet.
 *
 * It renders **in place, under the message it belongs to** — not in a separate
 * outbox. The point of the design note is that "why is nothing happening?" is
 * answered where you asked the question: who it waits on, what they are doing,
 * when it will land, and how to take it back.
 *
 * The dashed border is doing real work: it says "not yet delivered" without a
 * colour that would imply an error. Nothing is wrong; the agent is simply busy.
 */
export function QueuedChip({ queued, onCancel }: { queued: QueuedView; onCancel?: () => void }) {
  const interrupt = queued.mode === "interrupt";

  return (
    <div
      style={{
        marginTop: 7,
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        border: "1px dashed var(--ny-border-strong)",
        borderRadius: 8,
        padding: "5px 10px",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11.5,
        color: "var(--ny-text-muted)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          flex: "none",
          borderRadius: "50%",
          background: interrupt ? "var(--ny-danger)" : "var(--ny-warning)",
          animation: "bhPulse 1.6s ease-in-out infinite",
        }}
      />
      {/* The reason is the server's, verbatim. It is the only thing that
          distinguishes "the agent is busy" from "the agent is not running" and
          "the agent is paused", and those three are entirely different
          problems for the person reading this chip. Re-phrasing it here would
          flatten them back into one. */}
      <span>
        {interrupt ? "Interrupting" : "Queued"} ·{" "}
        <b style={{ color: "var(--ny-text)" }}>@{queued.agentHandle}</b> · {queued.reason}
      </span>
      {/* No cancel affordance unless something can actually cancel: a button
          that only clears the chip would claim to have stopped a run that is
          still on its way to the agent. */}
      {onCancel && (
        <>
          <span
            aria-hidden
            style={{ width: 1, height: 12, background: "var(--ny-border-strong)" }}
          />
          <button
            type="button"
            onClick={onCancel}
            className="bh-reset bh-underline bh-focusable"
            style={{
              color: "var(--ny-danger-text)",
              cursor: "pointer",
              fontFamily: "var(--ny-font-mono)",
              fontSize: 11.5,
              borderRadius: 4,
            }}
          >
            cancel
          </button>
        </>
      )}
    </div>
  );
}
