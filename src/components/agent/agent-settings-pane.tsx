import { useState } from "react";
import { Badge, Button, Field, Input, Select, Textarea } from "@notyet.im/ui";
import { Info } from "lucide-react";
import type { EgressPolicy } from "@/db/schema";
import type { AgentBlueprint, AgentDetail, EffectiveEgress } from "./agent-data";
import { describeBudget, describeEgress, describeResourceCaps, formatCents } from "./agent-facts";
import { toneBorderVar, toneSubtleVar } from "./status-pill";

/**
 * Per-agent configuration.
 *
 * Deliberately *not* wired to a save endpoint: `server/api/agents.ts` exposes
 * create, start, stop, inject and destroy — there is no `PATCH /api/agents/:id`
 * — and inventing one here would produce a form that appears to work and
 * silently discards every edit. The controls are live and local, the save
 * button states plainly what is missing, and the fields that already have a
 * real source (repo, branch, budget, egress policy, prompt override) are
 * pre-filled from the agent row so the shape is right the day the route lands.
 */
export interface AgentSettingsPaneProps {
  agent: AgentDetail;
  /** `GET /api/agents/:id/blueprint`, or null while it loads / if it fails. */
  blueprint: AgentBlueprint | null;
  /**
   * The **resolved** egress policy, or null while it loads / if it fails.
   *
   * The Select below is a local, unsaved control; this is what the agent
   * actually gets. They are shown together, and said to differ when they do.
   */
  egress: EffectiveEgress | null;
  compact?: boolean;
  onDestroy: () => void;
}

const EGRESS_OPTIONS: ReadonlyArray<{ value: EgressPolicy; label: string }> = [
  { value: "none", label: "none · no outbound network" },
  { value: "allowlist", label: "allowlist · proxied, allowed hosts only" },
  { value: "open", label: "open · unrestricted internet" },
];

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--ny-border)",
        borderRadius: 12,
        background: "var(--ny-surface)",
        padding: "16px 18px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: subtitle ? 3 : 10,
        }}
      >
        <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--ny-text)", margin: 0 }}>
          {title}
        </h3>
        {action}
      </div>
      {subtitle && (
        <p style={{ fontSize: 11.5, color: "var(--ny-text-subtle)", margin: "0 0 10px" }}>
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

export function AgentSettingsPane({
  agent,
  blueprint,
  egress: effectiveEgress,
  compact = false,
  onDestroy,
}: AgentSettingsPaneProps) {
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPromptOverride ?? "");
  const [repoUrl, setRepoUrl] = useState(agent.gitRepoUrl ?? "");
  const [branch, setBranch] = useState(agent.gitBranch ?? "main");
  const [egressPolicy, setEgressPolicy] = useState<EgressPolicy>(agent.egressPolicy ?? "allowlist");
  const [budgetDollars, setBudgetDollars] = useState(
    agent.dailyBudgetCents == null ? "" : (agent.dailyBudgetCents / 100).toFixed(2),
  );

  // The badge and the host list describe the **resolved** policy, never the
  // local Select: nothing on this tab saves, so rendering the selection as if
  // it were in force is the same class of lie as the four hardcoded hosts this
  // replaces. The divergence is stated below instead.
  const egress = effectiveEgress
    ? describeEgress(effectiveEgress.mode, effectiveEgress.rules.length, effectiveEgress.enforced)
    : null;
  const caps = blueprint ? describeResourceCaps(blueprint) : null;
  const budget = describeBudget(agent);
  const padding = compact ? "16px 18px" : "20px";

  return (
    <div className="bh-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding }}>
      <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            border: "1px solid var(--ny-border)",
            background: "var(--ny-surface-sunken)",
            borderRadius: 9,
            padding: "10px 12px",
            color: "var(--ny-text-muted)",
          }}
        >
          <Info
            size={15}
            strokeWidth={2}
            aria-hidden="true"
            style={{ flex: "none", marginTop: 1 }}
          />
          <span style={{ fontSize: 12, lineHeight: 1.55 }}>
            Edits here are local. The harness API has no{" "}
            <code style={{ fontFamily: "var(--ny-font-mono)" }}>PATCH /api/agents/:id</code> yet, so
            nothing on this tab is persisted.
          </span>
        </div>

        {/*
          Three layers, and only two of them are editable here. The subtitle
          says so because the old one ("appended to the blueprint's base
          prompt") described neither: this field REPLACES the blueprint's
          prompt, and both sit beneath Blackhouse's own instructions, which
          `server/agents/system-prompt.ts` always prepends and no override can
          drop. Someone who believes they are appending will write half a
          prompt; someone who does not know the harness layer exists may try to
          re-explain the channels in here.
        */}
        <Card
          title="System prompt override"
          subtitle="Replaces the blueprint's prompt. Blackhouse's own instructions are always prepended."
        >
          <Textarea
            value={systemPrompt}
            onChange={setSystemPrompt}
            rows={4}
            size="sm"
            aria-label="System prompt override"
            placeholder={
              blueprint ? `Inherit ${blueprint.name}'s prompt` : "Inherit the blueprint's prompt"
            }
          />
        </Card>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: compact ? "1fr" : "repeat(auto-fit,minmax(280px,1fr))",
            gap: 14,
          }}
        >
          <Card title="Repo & branch">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Field label="Repository">
                <Input
                  value={repoUrl}
                  onChange={setRepoUrl}
                  placeholder="https://github.com/acme/storefront"
                  size="sm"
                />
              </Field>
              <Field label="Branch">
                <Input value={branch} onChange={setBranch} placeholder="main" size="sm" />
              </Field>
            </div>
          </Card>

          {/* An unset cap is rendered as absent, not as a default. A null
              `memory_bytes` means the container gets whatever the daemon
              allows — the opposite of the reassuring "4 GB RAM" this card
              used to print for every agent regardless of its blueprint. */}
          <Card
            title="Resources"
            subtitle="Caps come from the blueprint."
            action={
              <Badge tone="neutral" variant="outline" size="sm">
                blueprint
              </Badge>
            }
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                fontFamily: "var(--ny-font-mono)",
                fontSize: 12,
                color: "var(--ny-text-muted)",
              }}
            >
              {caps?.cpu && <span style={readOnlyChip}>{caps.cpu}</span>}
              {caps?.memory && <span style={readOnlyChip}>{caps.memory} RAM</span>}
              {caps && !caps.cpu && !caps.memory && (
                <span style={{ ...readOnlyChip, fontFamily: "var(--ny-font-sans)" }}>
                  No CPU or memory cap — this blueprint takes whatever the Docker daemon allows.
                </span>
              )}
            </div>
          </Card>
        </div>

        <Card
          title="Egress policy"
          action={
            egress ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Badge tone={egress.tone} variant="subtle" size="sm">
                  {egress.label}
                </Badge>
                {egress.unenforced && (
                  <Badge tone="warning" variant="solid" size="sm">
                    not enforced
                  </Badge>
                )}
              </span>
            ) : undefined
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Select
              options={EGRESS_OPTIONS}
              value={egressPolicy}
              onChange={setEgressPolicy}
              label="Egress policy"
            />
            {egress && (
              <p style={{ fontSize: 11.5, color: "var(--ny-text-subtle)", margin: 0 }}>
                {egress.detail}
              </p>
            )}
            {effectiveEgress && egressPolicy !== effectiveEgress.mode && (
              <p style={{ fontSize: 11.5, color: "var(--ny-warning-text)", margin: 0 }}>
                The badge is what this agent is on right now; the selection above is not applied and
                will not be until there is a PATCH route.
              </p>
            )}
            {effectiveEgress?.mode === "allowlist" && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 12,
                }}
              >
                {effectiveEgress.rules.map((host) => (
                  <span
                    key={host}
                    style={{
                      border: "1px solid var(--ny-border)",
                      borderRadius: 20,
                      padding: "3px 10px",
                      color: "var(--ny-text-muted)",
                    }}
                  >
                    {host}
                  </span>
                ))}
                {/* Zero rules is a legitimate, maximally restrictive policy —
                    deny everything outbound — and not a failed load, so it
                    says so rather than rendering an empty row. */}
                {effectiveEgress.rules.length === 0 && (
                  <span
                    style={{ fontFamily: "var(--ny-font-sans)", color: "var(--ny-text-subtle)" }}
                  >
                    No hosts allowed. Everything outbound is denied except the harness itself.
                  </span>
                )}
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Daily budget cap"
          subtitle={`Hitting the cap pauses @${agent.handle}: the container and the terminal session stay up and attachable, and new runs are refused until the window resets. It is not a stop.`}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field
              label="Cap"
              help="Leave empty for no cap. Resets daily at 00:00 UTC; the window rolls forward on first read."
            >
              <Input
                type="number"
                value={budgetDollars}
                onChange={setBudgetDollars}
                placeholder="uncapped"
                prefix="$"
                min={0}
                step={1}
                size="sm"
              />
            </Field>
            <p style={{ fontSize: 11.5, color: "var(--ny-text-muted)", margin: 0 }}>
              Spent today: <strong>{formatCents(budget.spentCents)}</strong>
              {budget.capped ? ` of ${formatCents(budget.capCents!)}` : " · currently uncapped"}
              {budget.paused ? " · paused" : ""}
            </p>
          </div>
        </Card>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: "var(--ny-text-subtle)" }}>
            Saving needs a PATCH route on the agents API.
          </span>
          <Button variant="primary" size="sm" disabled>
            Save changes
          </Button>
        </div>

        <div
          style={{
            border: `1px solid ${toneBorderVar("danger")}`,
            borderRadius: 12,
            background: toneSubtleVar("danger"),
            padding: "16px 18px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ny-danger-text)" }}>
              Destroy agent
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ny-text-muted)", marginTop: 2 }}>
              Deletes the sandbox, its workspace and its state volume permanently. Artifacts already
              posted to channels are kept.
            </div>
          </div>
          <Button variant="danger" size="sm" onClick={onDestroy}>
            Destroy…
          </Button>
        </div>
      </div>
    </div>
  );
}

const readOnlyChip: React.CSSProperties = {
  flex: 1,
  border: "1px solid var(--ny-border-strong)",
  borderRadius: 8,
  background: "var(--ny-surface-sunken)",
  padding: "8px 10px",
};
