import type { ReactNode } from "react";
import { Badge, Button, Tooltip } from "@notyet.im/ui";
import { LayoutGrid, Play, RotateCw, ShieldAlert, Square } from "lucide-react";
import {
  agentActivityConfig,
  agentStatusConfig,
  toneVar,
  type StatusTone,
} from "@/lib/agent-status";
import type {
  AgentBlueprint,
  AgentDetail,
  EffectiveEgress,
  RuntimeAvailability,
} from "./agent-data";
import {
  describeBudget,
  describeEgress,
  describeRuntime,
  formatCents,
  initialsOf,
} from "./agent-facts";
import { StatusPill, toneBorderVar, toneSubtleVar } from "./status-pill";

/**
 * Identity and posture, in one band under the top bar.
 *
 * The four meta blocks are ordered by how badly a wrong assumption hurts:
 * which blueprint this came from, what sandbox it *actually* got, what it can
 * reach on the network, and how much of today's money is gone.
 */
export interface AgentHeaderProps {
  agent: AgentDetail;
  /** `GET /api/agents/:id/blueprint`, or null while it loads / if it fails. */
  blueprint: AgentBlueprint | null;
  /** `GET /api/agents/runtimes`, or null while it loads / if it fails. */
  runtimes: RuntimeAvailability | null;
  /**
   * The **resolved** egress policy, or null while it loads / if it fails.
   *
   * Resolved, not `agent.egressPolicy`: that column is nullable and null means
   * "inherit the blueprint", so it is wrong for exactly the agents whose
   * posture is least obvious.
   */
  egress: EffectiveEgress | null;
  /** A lifecycle call is in flight; the action buttons lock. */
  busy?: boolean;
  onStart: () => void;
  onRestart: () => void;
  onStop: () => void;
}

/** `agentStatus.running` → `running`. The i18n keys are not registered yet. */
function labelOf(labelKey: string): string {
  return labelKey.split(".").pop() ?? labelKey;
}

/**
 * The row exists; nothing was ever launched.
 *
 * `POST /api/agents` writes the row at `status: "creating"` and stops there —
 * starting a container is a separate `POST /api/agents/:id/start`. So an agent
 * in `creating` with no `containerId` is not a container mid-launch, it is one
 * waiting to be started, and it will sit there for as long as nobody presses
 * the button.
 *
 * Derived from the container signals only (`status` + `containerId`);
 * `activity` says what the *process* is doing and is never folded in here —
 * a never-started agent reports `unknown` for the same reason a crashed one
 * does, so it cannot distinguish these states.
 */
export function isAwaitingStart(agent: AgentDetail): boolean {
  return agent.status === "creating" && !agent.containerId;
}

/**
 * No image is recorded for this agent, so a start is likely to fail.
 *
 * `POST /api/agents` copies `blueprint.image` onto the row at creation time,
 * so a null here means the blueprint had no built image at that moment —
 * usually a build that failed. It is a *likely* failure and not a certain one:
 * the server resolves `agent.containerImage || blueprint.image`, so a blueprint
 * built since would still start. That is why this warns and never disables the
 * button — refusing the click would strand an agent that is now startable.
 */
export function isMissingImage(agent: AgentDetail): boolean {
  return !agent.containerImage && agent.status !== "running" && agent.status !== "destroyed";
}

function MetaBlock({
  label,
  children,
  title,
  minWidth,
}: {
  label: string;
  children: ReactNode;
  title?: string;
  minWidth?: number;
}) {
  return (
    <div style={{ minWidth }} title={title}>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--ny-font-mono)",
          textTransform: "uppercase",
          letterSpacing: ".05em",
          color: "var(--ny-text-subtle)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * An empty slot where a fact has not arrived.
 *
 * Both of the facts beside it used to be hardcoded — the header reported
 * blueprint `ui-explorer` and `allowlist · 4` for an agent that was neither —
 * so a fallback value is the exact bug this replaces. Deliberately static and
 * not a shimmer: it is "no answer yet", including when the fetch failed, and
 * an animation would promise one that is never coming. It keeps the row's
 * width so the header does not reflow when the real value lands.
 */
function MetaEmpty({ width }: { width: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width,
        height: 14,
        borderRadius: 4,
        background: "var(--ny-surface-active)",
      }}
    />
  );
}

export function AgentHeader({
  agent,
  blueprint,
  runtimes,
  egress: effectiveEgress,
  busy = false,
  onStart,
  onRestart,
  onStop,
}: AgentHeaderProps) {
  const statusEntry = agentStatusConfig[agent.status];
  const activityEntry = agentActivityConfig[agent.activity];
  const runtime = describeRuntime(agent.sandboxRuntime, agent.runtimeUsed, runtimes);
  const egress = effectiveEgress
    ? describeEgress(effectiveEgress.mode, effectiveEgress.rules.length, effectiveEgress.enforced)
    : null;
  const budget = describeBudget(agent);
  const running = agent.status === "running";
  const dotTone: StatusTone = statusEntry.tone;
  const awaitingStart = isAwaitingStart(agent);
  const missingImage = isMissingImage(agent);
  /** Start is the only lifecycle call offered in this state, so `busy` is it. */
  const starting = busy && awaitingStart;
  /**
   * `creating` pulses because it is normally a transient state. An agent that
   * was never started is not transient, it is parked, and animating it is what
   * made "not started yet" read as "stuck mid-launch". It pulses again once a
   * start is genuinely in flight — image pulls are slow enough to need it.
   *
   * Only the animation is decided here. The tone still comes from
   * `agentStatusConfig`, which stays the one status → colour mapping.
   */
  const pulsing = starting || (statusEntry.pulse && !awaitingStart);

  return (
    <div style={{ flex: "none", borderBottom: "1px solid var(--ny-border)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "16px 20px",
          flexWrap: "wrap",
        }}
      >
        {/* Avatar tile + process dot. The dot is the container; the pills
            below are the agent process. They fail independently. */}
        <div style={{ position: "relative", flex: "none" }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 13,
              background: "var(--ny-surface-raised)",
              border: "1.5px solid var(--ny-accent-border)",
              display: "grid",
              placeItems: "center",
              fontFamily: "var(--ny-font-mono)",
              fontSize: 18,
              fontWeight: 700,
              color: "var(--ny-accent-text)",
            }}
          >
            {initialsOf(agent.displayName, agent.handle)}
          </div>
          <span
            className="bh-dot"
            aria-hidden="true"
            title={labelOf(statusEntry.labelKey)}
            style={
              {
                position: "absolute",
                right: -3,
                bottom: -3,
                width: 15,
                height: 15,
                borderRadius: "50%",
                background: toneVar(dotTone),
                border: "3px solid var(--ny-bg)",
                "--bh-ring-color": toneVar(dotTone),
                animation: pulsing
                  ? "bhPulse 1.8s ease-in-out infinite"
                  : activityEntry.ring
                    ? "bhRing 1.8s ease-out infinite"
                    : undefined,
              } as React.CSSProperties
            }
          />
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: "var(--ny-text)" }}>
              {agent.displayName}
            </span>
            <span
              style={{
                fontFamily: "var(--ny-font-mono)",
                fontSize: 14,
                color: "var(--ny-text-subtle)",
              }}
            >
              @{agent.handle}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 7,
              flexWrap: "wrap",
            }}
          >
            <StatusPill tone={statusEntry.tone} dot pulse={pulsing}>
              {labelOf(statusEntry.labelKey)}
            </StatusPill>
            {/* `creating` is the honest enum value and stays as it is; this
                says what it means, because on its own it reads as progress. */}
            {awaitingStart &&
              (starting ? (
                <StatusPill tone="info" dot pulse title="Launching the container.">
                  starting…
                </StatusPill>
              ) : (
                <StatusPill
                  tone="warning"
                  title="Created but never started — no container exists yet."
                >
                  not started
                </StatusPill>
              ))}
            <StatusPill tone={activityEntry.tone}>
              {labelOf(activityEntry.labelKey)}
              {agent.statusLine ? ` · ${agent.statusLine}` : ""}
            </StatusPill>
            {budget.paused && (
              <StatusPill tone="warning" dot pulse title={budget.detail}>
                paused · budget
              </StatusPill>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            marginLeft: 8,
            flexWrap: "wrap",
          }}
        >
          <MetaBlock label="Blueprint">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 12,
                  color: "var(--ny-text)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <LayoutGrid size={12} strokeWidth={2} aria-hidden="true" />
                {blueprint ? blueprint.name : <MetaEmpty width={88} />}
              </span>
              {missingImage && (
                <Tooltip content="No image was recorded for this agent — its blueprint had not been built when the agent was created. Build it in Settings → Blueprints.">
                  <span style={{ display: "inline-flex" }} tabIndex={0}>
                    <Badge tone="warning" variant="subtle" size="sm">
                      no image
                    </Badge>
                  </span>
                </Tooltip>
              )}
            </span>
          </MetaBlock>

          <MetaBlock label="Sandbox">
            <Tooltip content={runtime.detail}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} tabIndex={0}>
                <Badge
                  tone={runtime.tone}
                  variant={runtime.fellBack ? "solid" : "subtle"}
                  size="sm"
                >
                  {runtime.fellBack
                    ? `${runtime.label} · ${runtime.requestedLabel} requested`
                    : runtime.pending
                      ? `${runtime.label} · pending`
                      : runtime.label}
                </Badge>
              </span>
            </Tooltip>
          </MetaBlock>

          <MetaBlock label="Egress">
            {egress ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Tooltip content={egress.detail}>
                  <span style={{ display: "inline-flex" }} tabIndex={0}>
                    <Badge tone={egress.tone} variant="subtle" size="sm">
                      {egress.label}
                    </Badge>
                  </span>
                </Tooltip>
                {/* A configured allowlist that nothing applies is the network
                    twin of a silent sandbox fallback, so it gets its own badge
                    rather than living only in the tooltip above. */}
                {egress.unenforced && (
                  <Tooltip content="Egress enforcement is off for this instance — no proxy is applied, so this agent can reach any host regardless of the policy above.">
                    <span style={{ display: "inline-flex" }} tabIndex={0}>
                      <Badge tone="warning" variant="solid" size="sm">
                        not enforced
                      </Badge>
                    </span>
                  </Tooltip>
                )}
              </span>
            ) : (
              <MetaEmpty width={72} />
            )}
          </MetaBlock>

          <MetaBlock label="Budget" minWidth={168} title={budget.detail}>
            <BudgetMeter agent={agent} />
          </MetaBlock>
        </div>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {running ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={onRestart}
                iconStart={<RotateCw size={13} strokeWidth={2} aria-hidden="true" />}
              >
                Restart
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={onStop}
                iconStart={<Square size={13} strokeWidth={2} aria-hidden="true" />}
              >
                Stop
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={busy || agent.status === "destroyed"}
              loading={busy}
              onClick={onStart}
              iconStart={<Play size={13} strokeWidth={2} aria-hidden="true" />}
            >
              Start
            </Button>
          )}
        </div>
      </div>

      {/* The fallback is the one thing on this page that must not be a
          tooltip. Believing you have a syscall boundary you do not have is
          exactly the failure this banner exists to prevent. */}
      {runtime.fellBack && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            margin: "0 20px 14px",
            padding: "9px 12px",
            borderRadius: 9,
            border: `1px solid ${toneBorderVar("danger")}`,
            background: toneSubtleVar("danger"),
            color: "var(--ny-danger-text)",
          }}
        >
          <ShieldAlert
            size={16}
            strokeWidth={2}
            style={{ flex: "none", marginTop: 1 }}
            aria-hidden="true"
          />
          <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
            <strong>Sandbox fallback.</strong> {runtime.detail}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Spend against today's cap.
 *
 * Uncapped is shown as a plain figure with no track — a full-width empty bar
 * would read as "0% of something", which is precisely the wrong impression
 * when there is no cap to be 0% of.
 */
function BudgetMeter({ agent }: { agent: AgentDetail }) {
  const budget = describeBudget(agent);

  if (!budget.capped) {
    return (
      <div>
        <span
          style={{
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12,
            color: "var(--ny-text)",
          }}
        >
          {formatCents(budget.spentCents)}
        </span>
        <div
          style={{
            fontSize: 10,
            color: "var(--ny-text-subtle)",
            marginTop: 4,
            fontFamily: "var(--ny-font-mono)",
          }}
        >
          uncapped
        </div>
      </div>
    );
  }

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(budget.fillPct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Daily budget: ${budget.amountLabel}`}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 10,
          fontSize: 10,
          fontFamily: "var(--ny-font-mono)",
          color: "var(--ny-text-muted)",
          marginBottom: 5,
        }}
      >
        <span>{budget.amountLabel}</span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 20,
          background: "var(--ny-surface-active)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${budget.fillPct}%`,
            height: "100%",
            borderRadius: 20,
            background:
              budget.tone === "danger"
                ? "var(--ny-danger)"
                : budget.tone === "warning"
                  ? "var(--ny-warning)"
                  : "var(--ny-success)",
            transition: "width .2s",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          color: budget.paused ? "var(--ny-warning-text)" : "var(--ny-text-subtle)",
          marginTop: 4,
          fontFamily: "var(--ny-font-mono)",
        }}
      >
        {budget.paused ? "paused · cap reached" : "resets daily · 00:00 UTC"}
      </div>
    </div>
  );
}
