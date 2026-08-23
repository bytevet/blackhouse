import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Spinner } from "@notyet.im/ui";
import { CirclePlay, TriangleAlert } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  destroyAgent as destroyAgentRequest,
  fetchAgent,
  fetchAgentBlueprint,
  fetchEffectiveEgress,
  fetchRuntimes,
  startAgent as startAgentRequest,
  stopAgent as stopAgentRequest,
  type AgentBlueprint,
  type AgentDetail,
  type EffectiveEgress,
  type RuntimeAvailability,
} from "@/components/agent/agent-data";
import { AgentHeader, isAwaitingStart, isMissingImage } from "@/components/agent/agent-header";
import { AgentPageStyles } from "@/components/agent/agent-styles";
import { AgentViewBar, type AgentTab, type SecondaryTab } from "@/components/agent/agent-view-bar";
import { ConfirmDialog } from "@/components/agent/confirm-dialog";
import { SecondaryPane } from "@/components/agent/secondary-pane";
import { SplitPane } from "@/components/agent/split-pane";
import { toneBorderVar, toneSubtleVar } from "@/components/agent/status-pill";
import { TerminalPane } from "@/components/agent/terminal-pane";
import { usePersistedLeftPct, useSplitAvailable } from "@/components/agent/use-split-layout";
import { useResource } from "@/hooks/use-resource";
import { toneTextVar, type StatusTone } from "@/lib/agent-status";

/**
 * One agent — inspect and drive it.
 *
 * Shape follows `Agent Pane.dc.html`: identity and posture header, a five-way
 * tab strip with a split toggle, and the view itself. The terminal is the point
 * of the pane, so it gets the whole content area in single-pane mode and the
 * left half in split.
 *
 * A *pane*, not a page: it renders into `AppShell`'s content area beside the
 * rail, which is why there is no breadcrumb here any more — the sidebar is
 * always on screen and already says where you are. The shell keys this by
 * agent id, so opening a second agent remounts rather than carrying the first
 * one's terminal, poll and split position across.
 *
 * State mirrors the prototype's — `{tab, split, rightTab, leftPct}` — with
 * `leftPct` lifted into localStorage per agent.
 */

/** Which confirmation is open. All three of these destroy something live. */
type PendingAction = "stop" | "restart" | "destroy" | null;

const POLL_INTERVAL_MS = 5000;

/**
 * Remount on every agent.
 *
 * A route param change re-renders the element, it does not replace it, so
 * without this key clicking a second agent in the rail would keep the first
 * one's terminal socket, poll timer and split position — state that is only
 * correct for the agent it was created against. As separate pages this was
 * impossible; inside a persistent shell it is the default.
 */
export function AgentPane() {
  const { agentId } = useParams<{ agentId: string }>();
  return <AgentPaneView key={agentId} />;
}

function AgentPaneView() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeAvailability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);

  const [tab, setTab] = useState<AgentTab>("terminal");
  const [rightTab, setRightTab] = useState<SecondaryTab>("ide");
  const [split, setSplit] = useState(false);
  /** One-shot URL handed to the embedded browser when a terminal link is clicked. */
  const [navigateTo, setNavigateTo] = useState<string | null>(null);
  const [leftPct, setLeftPct] = usePersistedLeftPct(agentId);
  const splitAvailable = useSplitAvailable();

  /**
   * The two facts the header used to invent.
   *
   * Fetched once rather than polled: a blueprint's name and caps, and an
   * agent's resolved egress, only change through Settings, which reloads this
   * pane anyway. `useResource` is the same read hook every settings screen
   * uses, and both stay `null` while loading and after a failure — the header
   * renders an empty slot for a null, which is the whole point. Showing
   * `ui-explorer` and `allowlist · 4` for an agent that is neither is what
   * this replaces, and a fallback value would be that bug again.
   */
  const blueprintResource = useResource<AgentBlueprint | null>(
    (signal) => (agentId ? fetchAgentBlueprint(agentId, signal) : Promise.resolve(null)),
    [agentId],
  );
  const egressResource = useResource<EffectiveEgress | null>(
    (signal) => (agentId ? fetchEffectiveEgress(agentId, signal) : Promise.resolve(null)),
    [agentId],
  );

  // Initial load, then a poll: `status` and `activity` are written by the
  // lifecycle code and the sidecar, not by this page, so nothing else would
  // ever tell us the container died or the agent went busy.
  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    let cancelled = false;

    async function load(initial: boolean) {
      try {
        const next = await fetchAgent(agentId!, controller.signal);
        if (!cancelled) {
          setAgent(next);
          setLoadError(null);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // A failed poll is not worth blanking a working page — only the first
        // load gets to put the view into an error state.
        if (initial) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? "That agent does not exist, or you do not have access to it."
              : err instanceof Error
                ? err.message
                : "Failed to load agent",
          );
        }
      }
    }

    void load(true);
    const timer = setInterval(() => void load(false), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [agentId]);

  // Detected runtimes are what let the header say *why* a fallback happened.
  // Optional: the badge degrades to a correct-but-terser message without it.
  useEffect(() => {
    const controller = new AbortController();
    fetchRuntimes(controller.signal)
      .then(setRuntimes)
      .catch(() => setRuntimes(null));
    return () => controller.abort();
  }, []);

  const runAction = useCallback(async (action: () => Promise<AgentDetail | void>) => {
    setActionBusy(true);
    setActionError(null);
    try {
      const next = await action();
      if (next) setAgent(next);
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
      return false;
    } finally {
      setActionBusy(false);
    }
  }, []);

  const handleStart = useCallback(() => {
    if (!agentId) return;
    void runAction(() => startAgentRequest(agentId));
  }, [agentId, runAction]);

  const confirmPending = useCallback(async () => {
    if (!agentId || !pending) return;
    if (pending === "stop") {
      const ok = await runAction(() => stopAgentRequest(agentId));
      if (ok) setPending(null);
      return;
    }
    if (pending === "restart") {
      const ok = await runAction(async () => {
        await stopAgentRequest(agentId);
        return startAgentRequest(agentId);
      });
      if (ok) setPending(null);
      return;
    }
    const ok = await runAction(async () => {
      await destroyAgentRequest(agentId);
    });
    if (ok) {
      setPending(null);
      // The roster screen is gone — the rail is the roster now — so a destroyed
      // agent drops you back into the workspace rather than a list of one fewer.
      navigate("/channels", { replace: true });
    }
  }, [agentId, pending, runAction, navigate]);

  /**
   * Split on: the terminal takes the left pane, and whatever the user was
   * looking at moves to the right. Split off: the right pane's view becomes
   * the single view — collapsing back to a tab they had left behind two
   * choices ago would read as the toggle losing their place.
   */
  const handleSplitChange = useCallback(
    (next: boolean) => {
      setSplit(next);
      if (next) {
        if (tab !== "terminal") setRightTab(tab);
      } else if (tab !== "terminal") {
        setTab(rightTab);
      }
    },
    [tab, rightTab],
  );

  // A viewport that shrinks below the split threshold collapses cleanly rather
  // than leaving two unusable slivers.
  const effectiveSplit = split && splitAvailable;

  /**
   * A URL printed by the agent points at *its* network namespace, not ours —
   * `localhost:3000` in the sandbox is not `localhost:3000` here. So a click
   * routes to the agent's own headless browser rather than opening a tab.
   */
  const handleTerminalLink = useCallback(
    (url: string) => {
      setNavigateTo(url);
      if (effectiveSplit) setRightTab("browser");
      else setTab("browser");
    },
    [effectiveSplit],
  );

  if (loadError) {
    return (
      <PaneShell>
        <ErrorState message={loadError} />
      </PaneShell>
    );
  }

  if (!agent || !agentId) {
    return (
      <PaneShell>
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Spinner size="lg" label="Loading agent" />
        </div>
      </PaneShell>
    );
  }

  const blueprint = blueprintResource.data;
  const egress = egressResource.data;
  const terminal = (
    <TerminalPane
      agent={agent}
      blueprint={blueprint}
      compact={effectiveSplit}
      onStopClick={() => setPending("stop")}
      onLinkClick={handleTerminalLink}
    />
  );
  // In split mode the right pane follows `rightTab`; single-pane it follows
  // `tab`, which is only ever read here when `tab` is not the terminal.
  const secondaryTab: SecondaryTab = effectiveSplit || tab === "terminal" ? rightTab : tab;
  const secondary = (
    <SecondaryPane
      tab={secondaryTab}
      agent={agent}
      blueprint={blueprint}
      egress={egress}
      compact={effectiveSplit}
      onDestroy={() => setPending("destroy")}
      navigateTo={navigateTo}
      onNavigated={() => setNavigateTo(null)}
    />
  );

  return (
    <PaneShell>
      <AgentHeader
        agent={agent}
        blueprint={blueprint}
        runtimes={runtimes}
        egress={egress}
        busy={actionBusy}
        onStart={handleStart}
        onRestart={() => setPending("restart")}
        onStop={() => setPending("stop")}
      />

      <StartupNotice agent={agent} />

      {actionError && (
        <div
          role="alert"
          style={{
            flex: "none",
            display: "flex",
            gap: 10,
            alignItems: "center",
            margin: "0 20px 12px",
            padding: "9px 12px",
            borderRadius: 9,
            border: "1px solid var(--ny-danger-border)",
            background: "var(--ny-danger-subtle)",
            color: "var(--ny-danger-text)",
            fontSize: 12.5,
          }}
        >
          <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" style={{ flex: "none" }} />
          {actionError}
        </div>
      )}

      <AgentViewBar
        tab={tab}
        rightTab={rightTab}
        split={effectiveSplit}
        splitAvailable={splitAvailable}
        onTabChange={setTab}
        onRightTabChange={setRightTab}
        onSplitChange={handleSplitChange}
      />

      <div
        id="agent-view-panel"
        role="tabpanel"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}
      >
        {effectiveSplit ? (
          <SplitPane
            left={terminal}
            right={secondary}
            leftPct={leftPct}
            onLeftPctChange={setLeftPct}
            label="Resize terminal and secondary pane"
          />
        ) : tab === "terminal" ? (
          terminal
        ) : (
          secondary
        )}
      </div>

      <ConfirmDialog
        open={pending === "stop"}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        busy={actionBusy}
        title={`Stop @${agent.handle}?`}
        description="The workspace and state volumes are kept, so nothing on disk is lost."
        consequence={
          <>
            This kills the live terminal session. The CLI process is terminated,{" "}
            <strong>anything it is part-way through is discarded</strong>, and every attached tab is
            disconnected. Queued work is not resumed on restart.
          </>
        }
        confirmLabel="Stop agent"
        cancelLabel="Keep running"
      />

      <ConfirmDialog
        open={pending === "restart"}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        busy={actionBusy}
        title={`Restart @${agent.handle}?`}
        description="Stops the container and starts a fresh one from the same image and volumes."
        consequence={
          <>
            A restart is a stop first: the live terminal session ends and{" "}
            <strong>any in-flight turn is lost</strong>. Scrollback does not survive.
          </>
        }
        tone="warning"
        confirmLabel="Restart agent"
      />

      <ConfirmDialog
        open={pending === "destroy"}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmPending()}
        busy={actionBusy}
        title={`Destroy @${agent.handle}?`}
        description="This cannot be undone."
        consequence={
          <>
            Removes the container <strong>and deletes the workspace and state volumes</strong> —
            every uncommitted change in this agent's checkout goes with it. Artifacts already posted
            to channels are kept.
          </>
        }
        confirmLabel="Destroy agent"
      />
    </PaneShell>
  );
}

/** Full-viewport column. This page owns its chrome; there is no app shell. */
/**
 * Fills the shell's content area rather than the viewport.
 *
 * `height: 100%` and not `100dvh`: the shell already owns the viewport, and a
 * second element claiming the full dynamic height inside it would overflow by
 * exactly the rail's header on mobile browsers.
 */
function PaneShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
        fontSize: 14,
        overflow: "hidden",
      }}
    >
      <AgentPageStyles />
      {children}
    </div>
  );
}

/**
 * Why the pane is empty, when it is empty for a reason the user can fix.
 *
 * Two states land here and neither is a container doing anything:
 *
 * - **Never started.** `POST /api/agents` writes the row and stops; starting is
 *   a separate call. Without this band the pane shows a pulsing `creating`
 *   over a terminal that says "the agent is creating" and nothing else ever
 *   happens — indistinguishable from a launch that hung.
 * - **No image.** The agent's blueprint had no built image when the agent was
 *   created, so Start is likely to come back as a raw Docker error. Saying so
 *   before the click, and naming the screen that fixes it, is the difference
 *   between a dead end and a next step.
 *
 * Deliberately not a spinner and deliberately not an alert: nothing is in
 * flight (so `role="status"`), and nothing has gone wrong yet.
 */
function StartupNotice({ agent }: { agent: AgentDetail }) {
  const awaitingStart = isAwaitingStart(agent);
  const missingImage = isMissingImage(agent);
  if (!awaitingStart && !missingImage) return null;

  // A blocked start outranks an unstarted one: the second paragraph is the
  // one with something to do in it.
  const tone: StatusTone = missingImage ? "warning" : "info";
  const Icon = missingImage ? TriangleAlert : CirclePlay;

  return (
    <div
      role="status"
      style={{
        flex: "none",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        margin: "0 20px 12px",
        padding: "10px 12px",
        borderRadius: 9,
        border: `1px solid ${toneBorderVar(tone)}`,
        background: toneSubtleVar(tone),
        color: toneTextVar(tone),
        fontSize: 12.5,
        lineHeight: 1.55,
      }}
    >
      <Icon size={15} strokeWidth={2} aria-hidden="true" style={{ flex: "none", marginTop: 2 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        {awaitingStart && (
          <span>
            <strong>Not started yet.</strong> Creating an agent registers it; it does not launch a
            container. This one has no container, no terminal output and no logs, and it will stay
            that way until you press Start in the header above — it is parked, not booting.
          </span>
        )}
        {missingImage && (
          <span>
            <strong>No image for this agent.</strong> Its blueprint had no built image when the
            agent was created, so Start is likely to fail with a Docker error unless the blueprint
            has been built since.{" "}
            <Link
              to="/settings/blueprints"
              style={{ color: "inherit", fontWeight: 600, textDecoration: "underline" }}
            >
              Build the image in Settings → Blueprints
            </Link>
            , then start the agent.
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24 }}>
      <div
        role="alert"
        style={{
          maxWidth: 420,
          textAlign: "center",
          border: "1px solid var(--ny-danger-border)",
          background: "var(--ny-danger-subtle)",
          color: "var(--ny-danger-text)",
          borderRadius: 12,
          padding: "20px 22px",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        <TriangleAlert size={20} strokeWidth={2} aria-hidden="true" />
        <div style={{ marginTop: 8 }}>{message}</div>
      </div>
    </div>
  );
}
