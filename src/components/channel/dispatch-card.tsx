import { useEffect, useState } from "react";
import { ArrowRight, Check, Clock, SquarePen, TriangleAlert, X, Zap } from "lucide-react";
import { Button, Textarea } from "@notyet.im/ui";
import { countdown } from "./format";
import type { DispatchView } from "./types";

/**
 * Agent→agent dispatch: **a decision, not a notification.**
 *
 * Every visual choice here follows from that. It sits on the warning surface
 * so it reads as a hold rather than a toast; the icon pulses because something
 * is waiting on you; the expiry is a visible countdown because a request that
 * silently rots is worse than one that is refused. Approve / Edit & approve /
 * Deny are all inline — editing before approving is one move, not a modal.
 *
 * Once resolved it **collapses to a quiet one-liner**. The decision has been
 * made; from then on it is history, and history has to stay skimmable.
 *
 * With channel auto-approve on, the card still renders — in the info tone, as
 * an after-the-fact record. Auto-approve removes the *hold*, not the *record*.
 */

type Visual = {
  tone: "warning" | "accent" | "success" | "danger" | "info" | "neutral";
  icon: typeof TriangleAlert;
  eyebrow: string;
  pulse: boolean;
};

function visualFor(dispatch: DispatchView, editing: boolean, expired: boolean): Visual {
  if (editing) {
    return {
      tone: "accent",
      icon: SquarePen,
      eyebrow: "Editing prompt · agent dispatch",
      pulse: false,
    };
  }
  if (dispatch.autoApproved) {
    return { tone: "info", icon: Zap, eyebrow: "Auto-approved · agent dispatch", pulse: false };
  }
  switch (expired ? "expired" : dispatch.status) {
    case "approved":
      return { tone: "success", icon: Check, eyebrow: "Approved · agent dispatch", pulse: false };
    case "denied":
      return { tone: "danger", icon: X, eyebrow: "Denied · agent dispatch", pulse: false };
    case "expired":
      return { tone: "neutral", icon: Clock, eyebrow: "Expired · agent dispatch", pulse: false };
    default:
      return {
        tone: "warning",
        icon: TriangleAlert,
        eyebrow: "Approval required · agent dispatch",
        pulse: true,
      };
  }
}

export function DispatchCard({
  dispatch,
  onApprove,
  onDeny,
  onExpire,
}: {
  dispatch: DispatchView;
  /** Called with the final prompt — edited or verbatim. */
  onApprove?: (prompt: string) => void;
  onDeny?: () => void;
  /** Fired once when the countdown crosses zero, so the caller can persist it. */
  onExpire?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(dispatch.prompt);
  const [remaining, setRemaining] = useState(() => dispatch.expiresAt.getTime() - Date.now());

  const pending = dispatch.status === "pending" && !dispatch.autoApproved;
  const expired = pending && remaining <= 0;

  // A countdown that only ticks while it means something.
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => {
      setRemaining(dispatch.expiresAt.getTime() - Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [pending, dispatch.expiresAt]);

  useEffect(() => {
    if (expired) onExpire?.();
  }, [expired, onExpire]);

  const visual = visualFor(dispatch, editing, expired);
  const Icon = visual.icon;
  const toneText =
    visual.tone === "neutral" ? "var(--ny-text-subtle)" : `var(--ny-${visual.tone}-text)`;
  const resolved = !pending || expired;
  const shownPrompt = dispatch.approvedPrompt ?? dispatch.prompt;

  return (
    <div style={{ display: "flex", gap: 12, padding: "10px 8px" }}>
      <div style={{ width: 38, flex: "none", display: "flex", justifyContent: "center" }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: `var(--ny-${visual.tone === "neutral" ? "surface-sunken" : `${visual.tone}-subtle`})`,
            color: toneText,
            animation: visual.pulse ? "bhPulse 2.4s ease-in-out infinite" : undefined,
          }}
        >
          <Icon
            size={15}
            strokeWidth={visual.tone === "success" || visual.tone === "danger" ? 2.5 : 2}
          />
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          borderRadius: 12,
          border: `1px solid ${visual.tone === "neutral" ? "var(--ny-border)" : `var(--ny-${visual.tone}-border)`}`,
          background:
            visual.tone === "neutral"
              ? "var(--ny-surface-sunken)"
              : `var(--ny-${visual.tone}-subtle)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
            padding: resolved ? "9px 14px" : "11px 14px 6px",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--ny-font-mono)",
              letterSpacing: ".05em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: toneText,
            }}
          >
            {visual.eyebrow}
          </span>
          {pending && !expired && (
            <span
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11.5,
                color: "var(--ny-warning-text)",
              }}
            >
              <Clock size={12} strokeWidth={2} />
              expires in {countdown(remaining)}
            </span>
          )}
          {resolved && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11.5,
                color: "var(--ny-text-muted)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
              }}
            >
              <b style={{ color: "var(--ny-text)", fontWeight: 600 }}>@{dispatch.fromHandle}</b>
              <ArrowRight size={13} strokeWidth={2} style={{ color: "var(--ny-text-subtle)" }} />
              <b style={{ color: "var(--ny-text)", fontWeight: 600 }}>@{dispatch.toHandle}</b>
            </span>
          )}
        </div>

        {resolved ? (
          <ResolvedLine
            dispatch={dispatch}
            expired={expired}
            prompt={shownPrompt}
            toneText={toneText}
          />
        ) : (
          <div style={{ padding: "2px 14px 12px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontFamily: "var(--ny-font-mono)",
                fontSize: 13,
                marginBottom: 9,
              }}
            >
              <b style={{ fontWeight: 700, color: "var(--ny-text)" }}>@{dispatch.fromHandle}</b>
              <ArrowRight size={16} strokeWidth={2} style={{ color: "var(--ny-text-subtle)" }} />
              <b style={{ fontWeight: 700, color: "var(--ny-text)" }}>@{dispatch.toHandle}</b>
              <span style={{ color: "var(--ny-text-subtle)" }}>wants to delegate</span>
            </div>

            {editing ? (
              <>
                <div
                  style={{
                    fontSize: 10.5,
                    fontFamily: "var(--ny-font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: ".05em",
                    color: "var(--ny-text-subtle)",
                    marginBottom: 5,
                  }}
                >
                  Edit prompt before dispatch
                </div>
                <Textarea value={draft} onChange={setDraft} rows={3} aria-label="Dispatch prompt" />
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <Button variant="primary" size="sm" onClick={() => onApprove?.(draft)}>
                    Approve edited
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(dispatch.prompt);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div
                  style={{
                    background: "var(--ny-surface)",
                    border: "1px solid var(--ny-border)",
                    borderRadius: 9,
                    padding: "10px 12px",
                    fontFamily: "var(--ny-font-mono)",
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: "var(--ny-text)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {dispatch.prompt}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <Button variant="primary" size="sm" onClick={() => onApprove?.(dispatch.prompt)}>
                    Approve
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    Edit &amp; approve
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => onDeny?.()}>
                    Deny
                  </Button>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      color: "var(--ny-text-subtle)",
                      fontFamily: "var(--ny-font-mono)",
                    }}
                  >
                    runs in @{dispatch.toHandle}&apos;s sandbox
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The collapsed form. One monospace line saying what was decided, by whom, and
 * where the run went — plus a disclosure for the prompt, because the record
 * has to remain auditable even though it is no longer the thing you are doing.
 */
function ResolvedLine({
  dispatch,
  expired,
  prompt,
  toneText,
}: {
  dispatch: DispatchView;
  expired: boolean;
  prompt: string;
  toneText: string;
}) {
  const [showPrompt, setShowPrompt] = useState(false);

  const line = expired
    ? `Expired · no one responded · @${dispatch.fromHandle} may re-request`
    : dispatch.autoApproved
      ? `Auto-approved · dispatched to @${dispatch.toHandle} with no hold`
      : dispatch.status === "approved"
        ? `Approved by ${dispatch.decidedByName ?? "a member"} · dispatched to @${dispatch.toHandle}${
            dispatch.approvedPrompt ? " (edited)" : ""
          }`
        : `Denied by ${dispatch.decidedByName ?? "a member"} · @${dispatch.fromHandle} notified`;

  return (
    <div style={{ padding: "0 14px 11px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          fontFamily: "var(--ny-font-mono)",
          fontSize: 12,
          color: toneText,
        }}
      >
        <span>{line}</span>
        <span aria-hidden style={{ width: 1, height: 12, background: "var(--ny-border-strong)" }} />
        <button
          type="button"
          className="bh-reset bh-underline bh-focusable"
          onClick={() => setShowPrompt((v) => !v)}
          style={{
            color: "var(--ny-text-muted)",
            cursor: "pointer",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          {showPrompt ? "hide prompt" : "show prompt"}
        </button>
        {dispatch.runId && (
          <a
            href={`/agents/${dispatch.toHandle}`}
            style={{ color: "var(--ny-accent-text)", textDecoration: "none" }}
          >
            view run →
          </a>
        )}
        {dispatch.autoApproved && (
          <span style={{ marginLeft: "auto", color: "var(--ny-text-subtle)" }}>
            override in channel settings
          </span>
        )}
      </div>
      {showPrompt && (
        <div
          style={{
            marginTop: 8,
            background: "var(--ny-surface)",
            border: "1px solid var(--ny-border)",
            borderRadius: 9,
            padding: "9px 11px",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--ny-text-muted)",
            overflowWrap: "anywhere",
          }}
        >
          {prompt}
        </div>
      )}
    </div>
  );
}
