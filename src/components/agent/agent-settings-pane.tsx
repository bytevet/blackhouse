import { useState } from "react";
import { Badge, Button, Field, Input, Select, Textarea } from "@notyet.im/ui";
import { Info } from "lucide-react";
import type { EgressPolicy } from "@/db/schema";
import type { AgentDetail } from "./agent-data";
import { describeBudget, describeEgress, formatCents } from "./agent-facts";
import { MOCK_EGRESS_ALLOWLIST, MOCK_NOTICE, type MockBlueprint } from "./mock-data";
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
  /** ⚠️ mock — resource caps live on the blueprint, which has no route yet. */
  blueprint: MockBlueprint;
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

  const egress = describeEgress(egressPolicy, MOCK_EGRESS_ALLOWLIST.length);
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

        <Card
          title="System prompt override"
          subtitle="Appended to the blueprint's base prompt. Leave empty to inherit."
        >
          <Textarea
            value={systemPrompt}
            onChange={setSystemPrompt}
            rows={4}
            size="sm"
            aria-label="System prompt override"
            placeholder={`Inherit ${blueprint.name}'s prompt`}
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

          <Card
            title="Resources"
            subtitle={`${MOCK_NOTICE} Caps come from the blueprint.`}
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
              <span style={readOnlyChip}>{blueprint.vcpus} vCPU</span>
              <span style={readOnlyChip}>{blueprint.memoryGb} GB RAM</span>
            </div>
          </Card>
        </div>

        <Card
          title="Egress policy"
          action={
            <Badge tone={egress.tone} variant="subtle" size="sm">
              {egress.label}
            </Badge>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Select
              options={EGRESS_OPTIONS}
              value={egressPolicy}
              onChange={setEgressPolicy}
              label="Egress policy"
            />
            <p style={{ fontSize: 11.5, color: "var(--ny-text-subtle)", margin: 0 }}>
              {egress.detail}
            </p>
            {egressPolicy === "allowlist" && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 12,
                }}
              >
                {MOCK_EGRESS_ALLOWLIST.map((host) => (
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
                <span
                  title={`${MOCK_NOTICE} Hosts come from the egress-rules table.`}
                  style={{
                    border: "1px dashed var(--ny-border-strong)",
                    borderRadius: 20,
                    padding: "3px 10px",
                    color: "var(--ny-text-subtle)",
                  }}
                >
                  placeholder list
                </span>
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
