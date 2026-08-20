import { useState } from "react";
import { Bell, Ellipsis, LogOut, Menu, SquarePen, TriangleAlert, Users, Zap } from "lucide-react";
import { Button, Dialog, Popover, Switch, VisuallyHidden } from "@notyet.im/ui";
import type { ChannelView } from "./types";

/**
 * `#slug`, who is in it, what it is about, and the controls that change the
 * room itself.
 *
 * The `auto-approve on` badge is permanent while the setting is on, and lives
 * in the header rather than the menu. A channel where agents dispatch each
 * other with no human hold must not look like any other channel — you have to
 * be able to tell from the top of the screen, without opening anything.
 */
export function ChannelHeader({
  channel,
  live = true,
  onToggleAutoApprove,
  onManageMembers,
  onEditChannel,
  onLeaveChannel,
  onOpenSidebar,
}: {
  channel: ChannelView;
  /** State of the multiplexed SSE connection. A transcript that has silently
   *  stopped updating looks exactly like a quiet channel, so the header says
   *  when it is no longer live. */
  live?: boolean;
  onToggleAutoApprove: (next: boolean) => void;
  /** Opens the members dialog — from the count, and from the overflow menu. */
  onManageMembers: () => void;
  onEditChannel?: () => void;
  onLeaveChannel?: () => void;
  /** Present only on narrow viewports, where the sidebar is a drawer. */
  onOpenSidebar?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  return (
    <header
      style={{
        flex: "none",
        // Two rows deep — title, then topic/repo — so this is taller than the
        // one-line breadcrumb bars and takes its own token. It is shared with
        // the sidebar's workspace block next to it, so the rule across the top
        // of the screen is continuous even when a channel has no topic.
        height: "var(--bh-topstrip-h)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 clamp(12px, 2vw, 20px)",
        borderBottom: "1px solid var(--ny-border)",
      }}
    >
      {onOpenSidebar && (
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open channels"
          className="bh-reset bh-hover bh-focusable"
          style={{
            width: 30,
            height: 30,
            flex: "none",
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            border: "1px solid var(--ny-border)",
            color: "var(--ny-text-subtle)",
            cursor: "pointer",
          }}
        >
          <Menu size={16} strokeWidth={2} />
        </button>
      )}

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            aria-hidden
            style={{
              fontFamily: "var(--ny-font-mono)",
              color: "var(--ny-text-subtle)",
              fontSize: 17,
            }}
          >
            #
          </span>
          <h1 style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>{channel.slug}</h1>
          <span
            aria-hidden
            style={{ width: 1, height: 14, background: "var(--ny-border-strong)" }}
          />
          {/* The count is the way in to managing the roster, which is what the
              design makes it. The dashed underline is the affordance — it reads
              as editable rather than as a statistic. */}
          <button
            type="button"
            onClick={onManageMembers}
            title="Manage members"
            className="bh-reset bh-focusable"
            style={{
              fontSize: 12.5,
              color: "var(--ny-text-subtle)",
              cursor: "pointer",
              borderBottom: "1px dashed var(--ny-border-strong)",
              padding: 0,
            }}
          >
            {channel.humanCount} humans · {channel.agentCount} agents
          </button>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ny-text-subtle)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {channel.topic ?? "No topic set"}
          {channel.gitRepoUrl && (
            <>
              {" · "}
              <span style={{ fontFamily: "var(--ny-font-mono)" }}>{channel.gitRepoUrl}</span>
              {channel.gitBranch && (
                <>
                  {" @ "}
                  <span style={{ fontFamily: "var(--ny-font-mono)" }}>{channel.gitBranch}</span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {!live && (
        <span
          role="status"
          title="Live updates are interrupted — reconnecting"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: "none",
            padding: "5px 10px",
            borderRadius: 8,
            border: "1px solid var(--ny-warning-border)",
            background: "var(--ny-warning-subtle)",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            color: "var(--ny-warning-text)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--ny-warning)",
              animation: "bhPulse 1.6s ease-in-out infinite",
            }}
          />
          reconnecting
        </span>
      )}

      {channel.autoApproveDispatch && (
        <span
          title="Agent→agent dispatch skips the human hold in this channel"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: "none",
            padding: "5px 10px",
            borderRadius: 8,
            border: "1px solid var(--ny-info-border)",
            background: "var(--ny-info-subtle)",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 11,
            color: "var(--ny-info-text)",
          }}
        >
          <Zap size={12} strokeWidth={2} />
          auto-approve on
        </span>
      )}

      <Popover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        placement="bottom"
        content={
          <ChannelMenu
            channel={channel}
            onManageMembers={() => {
              setMenuOpen(false);
              onManageMembers();
            }}
            onToggleAutoApprove={(next) => {
              // Turning the gate *off* is the dangerous direction, so it is the
              // one that asks. Turning it back on is a return to the safe state
              // and applies immediately.
              if (next) setConfirmYolo(true);
              else onToggleAutoApprove(false);
            }}
            onEditChannel={() => {
              setMenuOpen(false);
              onEditChannel?.();
            }}
            onLeaveChannel={() => {
              setMenuOpen(false);
              setConfirmLeave(true);
            }}
          />
        }
      >
        <Button iconOnly label="Channel settings" variant="secondary" size="sm">
          <Ellipsis size={16} strokeWidth={2} />
        </Button>
      </Popover>

      <Dialog
        open={confirmYolo}
        onClose={() => setConfirmYolo(false)}
        title="Turn on auto-approve?"
        description={`Agents in #${channel.slug} will dispatch each other with no human approval. The dispatch cards still get written to the transcript, so you keep the record — you lose the hold.`}
        size="sm"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" size="md" onClick={() => setConfirmYolo(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setConfirmYolo(false);
                setMenuOpen(false);
                onToggleAutoApprove(true);
              }}
            >
              Turn on auto-approve
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 13, color: "var(--ny-text-muted)", lineHeight: 1.55 }}>
          Budget caps and loop guards still apply. The flip is recorded in the channel.
        </div>
      </Dialog>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={`Leave #${channel.slug}?`}
        description="You will stop receiving mentions from this channel. Agents stay where they are."
        size="sm"
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="ghost" size="md" onClick={() => setConfirmLeave(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setConfirmLeave(false);
                onLeaveChannel?.();
              }}
            >
              Leave channel
            </Button>
          </div>
        }
      />
    </header>
  );
}

function ChannelMenu({
  channel,
  onToggleAutoApprove,
  onManageMembers,
  onEditChannel,
  onLeaveChannel,
}: {
  channel: ChannelView;
  onToggleAutoApprove: (next: boolean) => void;
  /** Opens the members dialog — from the count, and from the overflow menu. */
  onManageMembers: () => void;
  onEditChannel: () => void;
  onLeaveChannel: () => void;
}) {
  const on = channel.autoApproveDispatch;

  return (
    <div style={{ width: "min(308px, 78vw)", margin: -12 }}>
      <div
        style={{
          padding: "9px 13px 7px",
          fontSize: 10.5,
          fontFamily: "var(--ny-font-mono)",
          textTransform: "uppercase",
          letterSpacing: ".05em",
          color: "var(--ny-text-subtle)",
          borderBottom: "1px solid var(--ny-border)",
        }}
      >
        #{channel.slug} · channel settings
      </div>

      {/* The safety surface. Warning-toned even when off, because what it does
          is remove a gate — the row has to read as a hazard, not a preference. */}
      <div
        style={{
          padding: "12px 13px",
          transition: "background 150ms ease",
          background: on ? "var(--ny-warning-subtle)" : "transparent",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span
            style={{
              flex: "none",
              width: 26,
              height: 26,
              borderRadius: 7,
              display: "grid",
              placeItems: "center",
              background: "var(--ny-warning-subtle)",
              color: "var(--ny-warning-text)",
              marginTop: 1,
            }}
          >
            <Zap size={14} strokeWidth={2} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ny-text)" }}>
                Auto-approve dispatches
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontFamily: "var(--ny-font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  color: "var(--ny-warning-text)",
                  border: "1px solid var(--ny-warning-border)",
                  borderRadius: 4,
                  padding: "0 4px",
                }}
              >
                yolo
              </span>
            </div>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.45,
                color: "var(--ny-text-subtle)",
                marginTop: 3,
              }}
            >
              Skip the approval hold — agents dispatch each other instantly in this channel.
              High-trust rooms only.
            </div>
            {on && (
              <div
                style={{
                  marginTop: 7,
                  fontSize: 11,
                  fontFamily: "var(--ny-font-mono)",
                  color: "var(--ny-warning-text)",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <TriangleAlert size={12} strokeWidth={2} />
                on for everyone in #{channel.slug}
              </div>
            )}
          </div>
          <div style={{ flex: "none", marginTop: 1 }}>
            <Switch
              size="sm"
              checked={on}
              onChange={onToggleAutoApprove}
              // The visible title is to the left; this is the switch's own
              // accessible name, which it renders inside the control.
              label={<VisuallyHidden>Auto-approve dispatches</VisuallyHidden>}
            />
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--ny-border)" }} />

      <div style={{ padding: 5 }}>
        <MenuItem icon={<Users size={15} strokeWidth={2} />} onClick={onManageMembers}>
          Members
        </MenuItem>
        <MenuItem icon={<SquarePen size={15} strokeWidth={2} />} onClick={onEditChannel}>
          Edit channel &amp; repo
        </MenuItem>
        <MenuItem icon={<Bell size={15} strokeWidth={2} />}>Notification preferences</MenuItem>
        <MenuItem icon={<LogOut size={15} strokeWidth={2} />} danger onClick={onLeaveChannel}>
          Leave channel
        </MenuItem>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  children,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bh-reset bh-focusable ${danger ? "bh-hover-danger" : "bh-hover"}`}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 9px",
        borderRadius: 8,
        cursor: "pointer",
        fontSize: 13,
        color: danger ? "var(--ny-danger-text)" : "var(--ny-text-muted)",
      }}
    >
      {icon}
      {children}
    </button>
  );
}
