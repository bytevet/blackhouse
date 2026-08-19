import { Link, useLocation } from "react-router";
import { PanelLeftClose, Plus, Settings } from "lucide-react";
import { ThemeToggle, Tooltip } from "@notyet.im/ui";
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
  activeAgentId = null,
  currentUser,
  channelsLoading = false,
  channelsError = null,
  agentsLoading = false,
  agentsError = null,
  collapsed = false,
  onToggleCollapsed,
  onCreateChannel,
  onNavigate,
  onClose,
}: {
  workspace: { name: string; tagline: string };
  channels: ChannelView[];
  /** Null on a route that is not a channel — an agent, or the create dialog. */
  activeSlug: string | null;
  agents: AgentView[];
  /** The agent whose pane is open, so the rail can mark it the way it marks a channel. */
  activeAgentId?: string | null;
  currentUser: UserView;
  channelsLoading?: boolean;
  /** A roster that failed to load must say so. An empty rail would read as
   *  "this workspace has no agents", which is a different and much worse
   *  claim than "we could not reach the server". */
  channelsError?: string | null;
  agentsLoading?: boolean;
  agentsError?: string | null;
  /** Icon-strip mode. Absent on narrow viewports, where the rail is a drawer. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onCreateChannel: () => void;
  /** Called after any rail link is followed — closes the drawer on narrow. */
  onNavigate?: () => void;
  /** Set on narrow viewports, where the sidebar is a drawer. */
  onClose?: () => void;
}) {
  const { theme, setTheme } = useAppTheme();
  // What the create-agent dialog should leave on screen behind it.
  const createAgentState = { backgroundLocation: useLocation() };

  if (collapsed) {
    return (
      <CollapsedRail
        channels={channels}
        activeSlug={activeSlug}
        agents={agents}
        activeAgentId={activeAgentId}
        currentUser={currentUser}
        onExpand={onToggleCollapsed}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <aside
      style={{
        width: "var(--bh-rail-w)",
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
          // Shares the channel header's height so the two bottom borders meet
          // as one rule instead of stepping by a few pixels at the seam.
          height: "var(--bh-topstrip-h)",
          flex: "none",
          padding: "0 14px",
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
            // Clipped rather than wrapped: the header is a fixed height shared
            // with the channel bar next to it, so a second line here would
            // break the rule across the top of the screen.
            style={{
              fontSize: 11,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {workspace.tagline}
          </div>
        </div>
        {onToggleCollapsed && (
          <Tooltip content="Collapse sidebar" placement="right">
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              className="bh-reset bh-hover bh-focusable"
              style={{
                width: 28,
                height: 28,
                flex: "none",
                borderRadius: 7,
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                color: "var(--ny-text-subtle)",
              }}
            >
              <PanelLeftClose size={16} strokeWidth={2} />
            </button>
          </Tooltip>
        )}
      </div>

      <div
        className="bh-scroll"
        style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "10px 8px" }}
      >
        <SectionHeading label="Channels" onAdd={onCreateChannel} addLabel="Create channel" first />
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.slug === activeSlug}
              onNavigate={onNavigate}
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
          toState={createAgentState}
          addLabel="Create agent"
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              active={agent.id === activeAgentId}
              onNavigate={onNavigate}
            />
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

      {/* Who you are, then the two workspace-level controls. The theme toggle
          sits here rather than in the header because it is not part of the
          workspace's identity — it is a preference, and it belongs with the
          settings link at the foot of the rail. */}
      <div
        style={{
          borderTop: "1px solid var(--ny-border)",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: 8,
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
        <ThemeToggle
          theme={theme}
          onChange={(next) => setTheme(next === "light" ? "light" : "dark")}
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        />
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
  toState,
  addLabel,
  first = false,
}: {
  label: string;
  count?: number;
  onAdd?: () => void;
  to?: string;
  /** Router state for `to` — carries the background location for modal routes. */
  toState?: unknown;
  addLabel: string;
  /** First heading in the rail: no lead-in space above it. */
  first?: boolean;
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
        padding: first ? "4px 6px 4px 8px" : "16px 6px 4px 8px",
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
        <Link
          to={to}
          state={toState}
          aria-label={addLabel}
          className="bh-hover bh-focusable"
          style={addStyle}
        >
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
        padding: "4px 8px",
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

function AgentRow({
  agent,
  active,
  onNavigate,
}: {
  agent: AgentView;
  active?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={`/agents/${agent.id}`}
      onClick={onNavigate}
      // An open agent is a room you are in, exactly like an open channel, so it
      // gets the same selected treatment rather than looking like a link you
      // have not followed.
      aria-current={active ? "page" : undefined}
      className="bh-hover bh-focusable"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: 8,
        borderRadius: 9,
        textDecoration: "none",
        color: "inherit",
        background: active ? "var(--ny-surface-selected)" : "transparent",
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

/**
 * The rail at 60px: initials and avatars, no labels.
 *
 * Every target carries a `Tooltip` because that is the only thing standing
 * between a column of two-letter squares and a guessing game — collapsing the
 * rail trades names for space, and the tooltip is what makes that trade
 * reversible without expanding again. The process dot stays: it is the signal
 * you most need at a glance, and it survives the loss of the status line.
 */
function CollapsedRail({
  channels,
  activeSlug,
  agents,
  activeAgentId,
  currentUser,
  onExpand,
  onNavigate,
}: {
  channels: ChannelView[];
  activeSlug: string | null;
  agents: AgentView[];
  activeAgentId: string | null;
  currentUser: UserView;
  onExpand?: () => void;
  onNavigate?: () => void;
}) {
  const { theme, setTheme } = useAppTheme();
  const createAgentState = { backgroundLocation: useLocation() };

  return (
    <aside
      style={{
        width: 60,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "12px 0",
        background: "var(--ny-surface-sunken)",
        borderRight: "1px solid var(--ny-border)",
        minHeight: 0,
      }}
    >
      <Tooltip content="Expand sidebar" placement="right">
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          className="bh-reset bh-focusable"
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
            cursor: "pointer",
          }}
        >
          B
        </button>
      </Tooltip>

      <RailDivider />

      <div className="bh-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          {channels.map((channel) => (
            <Tooltip
              key={channel.id}
              content={`#${channel.slug}${channel.unreadCount ? ` · ${channel.unreadCount} unread` : ""}`}
              placement="right"
            >
              <Link
                to={`/channels/${channel.slug}`}
                onClick={onNavigate}
                aria-label={`#${channel.slug}`}
                aria-current={channel.slug === activeSlug ? "page" : undefined}
                className="bh-hover bh-focusable"
                style={{
                  position: "relative",
                  width: 34,
                  height: 34,
                  flex: "none",
                  borderRadius: 9,
                  display: "grid",
                  placeItems: "center",
                  textDecoration: "none",
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 13,
                  fontWeight: 600,
                  ...(channel.slug === activeSlug
                    ? {
                        background: "var(--ny-surface-selected)",
                        color: "var(--ny-text)",
                        // Inset rather than a border, so selecting a square
                        // does not change its size and shift the column.
                        boxShadow: "inset 0 0 0 1px var(--ny-accent-border)",
                      }
                    : {
                        background: "var(--ny-surface)",
                        border: "1px solid var(--ny-border)",
                        color: "var(--ny-text-muted)",
                      }),
                }}
              >
                {channel.slug.slice(0, 1).toUpperCase()}
                {channel.unreadCount > 0 && <RailBadge count={channel.unreadCount} />}
                {channel.hasMention && <RailMentionDot />}
              </Link>
            </Tooltip>
          ))}

          {agents.length > 0 && <RailDivider />}

          {agents.map((agent) => (
            <Tooltip
              key={agent.id}
              content={`@${agent.handle} · ${agent.activity} · ${agent.statusLine ?? agent.status}`}
              placement="right"
            >
              <Link
                to={`/agents/${agent.id}`}
                onClick={onNavigate}
                aria-label={`@${agent.handle}`}
                aria-current={agent.id === activeAgentId ? "page" : undefined}
                className="bh-focusable"
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 38,
                  height: 38,
                  flex: "none",
                  borderRadius: 10,
                  textDecoration: "none",
                  background:
                    agent.id === activeAgentId ? "var(--ny-surface-selected)" : "transparent",
                }}
              >
                <AgentAvatar agent={agent} size={30} />
              </Link>
            </Tooltip>
          ))}

          <Tooltip content="Create agent" placement="right">
            <Link
              to="/agents/new"
              state={createAgentState}
              onClick={onNavigate}
              aria-label="Create agent"
              className="bh-hover bh-focusable"
              style={{
                width: 34,
                height: 34,
                flex: "none",
                borderRadius: 9,
                border: "1px dashed var(--ny-border-strong)",
                display: "grid",
                placeItems: "center",
                color: "var(--ny-text-subtle)",
              }}
            >
              <Plus size={16} strokeWidth={2.2} />
            </Link>
          </Tooltip>
        </div>
      </div>

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          paddingTop: 8,
        }}
      >
        <ThemeToggle
          theme={theme}
          onChange={(next) => setTheme(next === "light" ? "light" : "dark")}
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        />
        <Tooltip content="Workspace settings" placement="right">
          <Link
            to="/settings"
            onClick={onNavigate}
            aria-label="Workspace settings"
            className="bh-hover bh-focusable"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              color: "var(--ny-text-subtle)",
            }}
          >
            <Settings size={16} strokeWidth={2} />
          </Link>
        </Tooltip>
        <Tooltip
          content={`${currentUser.name} · ${currentUser.role ?? "member"}`}
          placement="right"
        >
          <span style={{ display: "grid", placeItems: "center" }}>
            <UserAvatar name={currentUser.name} size={30} />
          </span>
        </Tooltip>
      </div>
    </aside>
  );
}

function RailDivider() {
  return (
    <div
      aria-hidden
      style={{
        width: 24,
        height: 1,
        flex: "none",
        background: "var(--ny-border)",
        margin: "4px 0",
      }}
    />
  );
}

function RailBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        position: "absolute",
        top: -3,
        right: -3,
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 20,
        background: "var(--ny-accent)",
        color: "var(--ny-text-on-accent)",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 9.5,
        display: "grid",
        placeItems: "center",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** A mention is louder than an unread count, so it gets its own mark. */
function RailMentionDot() {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        bottom: -2,
        right: -2,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--ny-danger)",
        border: "2px solid var(--ny-surface-sunken)",
      }}
    />
  );
}
