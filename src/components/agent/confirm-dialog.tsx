import type { ReactNode } from "react";
import { Button, Dialog } from "@notyet.im/ui";
import { TriangleAlert } from "lucide-react";
import { toneBorderVar, toneSubtleVar } from "./status-pill";
import type { StatusTone } from "@/lib/agent-status";

/**
 * Confirmation for the three actions on this page that destroy something a
 * user cannot get back: stopping (kills the live TUI session and the current
 * turn), restarting (same, plus a cold start), and destroying (the filesystem
 * as well).
 *
 * `consequence` is a separate slot from `description` on purpose. The
 * description says what the button does; the consequence strip says what you
 * lose, in the tone of the loss. A stop dialog that only says "Stop @scout?"
 * is not a confirmation, it is a speed bump.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** The strip above the buttons — what is irreversibly lost. */
  consequence?: ReactNode;
  tone?: StatusTone;
  confirmLabel: string;
  cancelLabel?: string;
  /** Disables the confirm button while the call is in flight. */
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  consequence,
  tone = "danger",
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="sm">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {consequence && (
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              border: `1px solid ${toneBorderVar(tone)}`,
              background: toneSubtleVar(tone),
              borderRadius: 9,
              padding: "10px 12px",
            }}
          >
            <TriangleAlert
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              style={{
                flex: "none",
                marginTop: 1,
                color: tone === "neutral" ? "var(--ny-text-subtle)" : `var(--ny-${tone}-text)`,
              }}
            />
            <span
              style={{
                fontSize: 12.5,
                lineHeight: 1.5,
                color: tone === "neutral" ? "var(--ny-text-muted)" : `var(--ny-${tone}-text)`,
              }}
            >
              {consequence}
            </span>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" size="md" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            size="md"
            loading={busy}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
