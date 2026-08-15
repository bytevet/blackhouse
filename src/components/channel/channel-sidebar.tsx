import { Link } from "react-router";
import { Plus, Settings } from "lucide-react";
import { ThemeToggle } from "@notyet.im/ui";
import { useAppTheme } from "@/components/theme-provider";
import { ActivityPill } from "./activity-pill";
import { AgentAvatar, UserAvatar } from "./agent-avatar";
import type { AgentView, ChannelView, UserView } from "./types";

/**
 * Workspace switcher, channel list, agent roster, current user.
 *
 * The roster is the part that matters: agents are *teammates* in this product,
 * so they sit in the same rail as the channels rather than in a settings page,
 * and each row carries both state signals — the process dot on the avatar, the
 * activity pill next to the handle, and the status line underneath saying what
 * it is actually doing.
 */
export function ChannelSidebar({
  workspace,
  channels,
  activeSlug,
  agents,
  currentUser,
  channelsLoading = false,
  channelsError = null,
  agentsLoading = false,
  agentsError = null,
  onCreateChannel,
  onClose,
}: {
  workspace: { name: string; tagline: string };
  channels: ChannelView[];
  activeSlug: string;
  agents: AgentView[];
  currentUser: UserView;
  channelsLoading?: boolean;
  /** A roster that failed to load must say so. An empty rail would read as
   *  "this workspace has no agents", which is a different and much worse
   *  claim than "we could not reach the server". */
  channelsError?: string | null;
  agentsLoading?: boolean;
  agentsError?: string | null;
  onCreateChannel: () => void;
  /** Set on narrow viewports, where the sidebar is a drawer. */
  onClose?: () => void;
}) {
  const { theme, setTheme } = useAppTheme();

  return (
    <aside
      style={{
        width: 288,
        maxWidth: "86vw",
        flex: "none",
        display: "flex",
        flexDirection: "column",
        background: "var(--ny-surface-sunken)",
        borderRight: "1px solid var(--ny-border)",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          borderBottom: "1px solid var(--ny-border)",
        }}
      >
        <Link
          to="/channels"
          onClick={onClose}
          aria-label="Blackhouse home"
          style={{
            width: 34,
            height: 34,
            flex: "none",
            borderRadius: 9,
            background: "var(--ny-accent)",
            color: "var(--ny-text-on-accent)",
            display: "grid",
            placeItems: "center",
            fontWeight: 700,
            fontSize: 15,
            fontFamily: "var(--ny-font-mono)",
            textDecoration: "none",
          }}
        >
          B
        </Link>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 13.5,
              lineHeight: 1.1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {workspace.name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
              marginTop: 2,
            }}
          >
            {workspace.tagline}
          </div>
        </div>
        <ThemeToggle
          theme={theme}
          onChange={(next) => setTheme(next === "light" ? "light" : "dark")}
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        />
      </div>

      <div
        className="bh-scroll"
        style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "10px 8px" }}
      >
        <SectionHeading label="Channels" onAdd={onCreateChannel} addLabel="Create channel" />
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.slug === activeSlug}
              onNavigate={onClose}
            />
          ))}
          {channelsError && (
            <RailNote tone="danger">Channels unavailable — {channelsError}</RailNote>
          )}
          {!channelsError && channelsLoading && channels.length === 0 && (
            <RailNote>Loading channels…</RailNote>
          )}
          {!channelsError && !channelsLoading && channels.length === 0 && (
            <RailNote>No channels yet</RailNote>
          )}
        </div>

        <SectionHeading
          label="Agents"
          count={agents.length}
          to="/agents/new"
          addLabel="Create agent"
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} onNavigate={onClose} />
          ))}
          {agentsError && <RailNote tone="danger">Roster unavailable — {agentsError}</RailNote>}
          {!agentsError && agentsLoading && agents.length === 0 && (
            <RailNote>Loading agents…</RailNote>
          )}
          {!agentsError && !agentsLoading && agents.length === 0 && (
            <RailNote>No agents yet — create one to mention it here</RailNote>
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--ny-border)",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <UserAvatar name={currentUser.name} size={28} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {currentUser.name}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
            }}
          >
            {currentUser.role ?? "member"}
          </div>
        </div>
        <Link
          to="/settings"
          onClick={onClose}
          aria-label="Workspace settings"
          className="bh-hover bh-focusable"
          style={{
            width: 28,
            height: 28,
            flex: "none",
            borderRadius: 7,
            display: "grid",
            placeItems: "center",
            color: "var(--ny-text-subtle)",
          }}
        >
          <Settings size={16} strokeWidth={2} />
        </Link>
      </div>
    </aside>
  );
}

/** One quiet line in the rail — loading, empty, or a load failure. */
function RailNote({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      style={{
        padding: "6px 10px",
        fontSize: 11,
        lineHeight: 1.45,
        fontFamily: "var(--ny-font-mono)",
        color: tone === "danger" ? "var(--ny-danger-text)" : "var(--ny-text-subtle)",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

function SectionHeading({
  label,
  count,
  onAdd,
  to,
  addLabel,
}: {
  label: string;
  count?: number;
  onAdd?: () => void;
  to?: string;
  addLabel: string;
}) {
  const addStyle = {
    width: 26,
    height: 26,
    flex: "none",
    borderRadius: 7,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    color: "var(--ny-text-subtle)",
    border: "1px solid var(--ny-border)",
  } as const;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "16px 6px 4px 8px",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 11,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--ny-text-subtle)",
          fontFamily: "var(--ny-font-mono)",
        }}
      >
        {label}
      </span>
      {count != null && (
        <span
          style={{
            fontSize: 11,
            color: "var(--ny-text-subtle)",
            fontFamily: "var(--ny-font-mono)",
          }}
        >
          {count}
        </span>
      )}
      {to ? (
        <Link to={to} aria-label={addLabel} className="bh-hover bh-focusable" style={addStyle}>
          <Plus size={16} strokeWidth={2.2} />
        </Link>
      ) : (
        <button
          type="button"
          onClick={onAdd}
          aria-label={addLabel}
          className="bh-reset bh-hover bh-focusable"
          style={addStyle}
        >
          <Plus size={16} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}

function ChannelRow({
  channel,
  active,
  onNavigate,
}: {
  channel: ChannelView;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={`/channels/${channel.slug}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={active ? "bh-focusable" : "bh-hover bh-focusable"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 7,
        textDecoration: "none",
        background: active ? "var(--ny-surface-selected)" : "transparent",
        color: active ? "var(--ny-text)" : "var(--ny-text-muted)",
        fontWeight: active ? 600 : 400,
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: "var(--ny-font-mono)",
          color: active ? "var(--ny-accent-text)" : "var(--ny-text-subtle)",
        }}
      >
        #
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {channel.slug}
      </span>
      {channel.unreadCount > 0 && (
        <span
          title={`${channel.unreadCount} unread`}
          style={{
            marginLeft: "auto",
            fontSize: 11,
            fontFamily: "var(--ny-font-mono)",
            background: "var(--ny-accent)",
            color: "var(--ny-text-on-accent)",
            borderRadius: 20,
            padding: "1px 7px",
          }}
        >
          {channel.unreadCount}
        </span>
      )}
      {channel.hasMention && channel.unreadCount === 0 && (
        <span
          title="You were mentioned"
          style={{
            marginLeft: "auto",
            fontSize: 11,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-danger-text)",
          }}
        >
          ●
        </span>
      )}
    </Link>
  );
}

function AgentRow({ agent, onNavigate }: { agent: AgentView; onNavigate?: () => void }) {
  return (
    <Link
      to={`/agents/${agent.id}`}
      onClick={onNavigate}
      className="bh-hover bh-focusable"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: 8,
        borderRadius: 9,
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <span style={{ marginTop: 1 }}>
        <AgentAvatar agent={agent} size={30} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontFamily: "var(--ny-font-mono)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ny-text)",
            }}
          >
            @{agent.handle}
          </span>
          <ActivityPill activity={agent.activity} />
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: "var(--ny-text-subtle)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--ny-font-mono)",
          }}
        >
          {agent.statusLine ?? agent.status}
        </span>
      </span>
    </Link>
  );
}
