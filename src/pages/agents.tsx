import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Play, Plus, Square, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Dialog, Heading, Spinner, Text, ThemeToggle } from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useAppTheme } from "@/components/theme-provider";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
  agentActivityConfig,
  agentStatusConfig,
  toneTextVar,
  toneVar,
  type StatusTone,
} from "@/lib/agent-status";
import type { AgentActivity, AgentStatus } from "@/db/schema";
import type { TranslationKey } from "@/i18n";

/** Wire shape of `GET /api/agents` — the agent row minus its bearer token. */
interface AgentRow {
  id: string;
  handle: string;
  displayName: string;
  blueprintId: string;
  status: AgentStatus;
  activity: AgentActivity;
  statusLine: string | null;
  runtimeUsed: string | null;
  sandboxRuntime: string | null;
  egressPolicy: string | null;
  pausedAt: string | null;
}

interface BlueprintRow {
  id: string;
  name: string;
  cli: string;
  sandboxRuntime: string;
  egressPolicy: string;
}

/** Two initials for the avatar tile, taken from the handle. */
function initials(handle: string): string {
  const cleaned = handle.replace(/[^a-z0-9]/gi, "");
  return (cleaned.slice(0, 2) || "??").toUpperCase();
}

function chipStyle(tone: StatusTone) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "var(--ny-font-mono)",
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: ".04em",
    borderRadius: 5,
    padding: "1px 7px",
    border: `1px solid ${tone === "neutral" ? "var(--ny-border)" : `var(--ny-${tone}-border)`}`,
    background: tone === "neutral" ? "var(--ny-surface-sunken)" : `var(--ny-${tone}-subtle)`,
    color: toneTextVar(tone),
  };
}

const metaChip = {
  fontFamily: "var(--ny-font-mono)",
  fontSize: 10.5,
  color: "var(--ny-text-subtle)",
  border: "1px solid var(--ny-border)",
  borderRadius: 5,
  padding: "1px 6px",
};

export function AgentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { theme, setTheme } = useAppTheme();
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which destructive action is awaiting confirmation, if any. */
  const [confirm, setConfirm] = useState<{ agent: AgentRow; kind: "stop" | "destroy" } | null>(
    null,
  );

  const agents = useResource<AgentRow[]>(
    async () => unwrap<AgentRow[]>(await client.api.agents.$get()),
    [],
  );
  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );

  const blueprintName = (id: string) =>
    blueprints.data?.find((b) => b.id === id)?.name ?? t("agents.unknownBlueprint");

  async function run(agent: AgentRow, kind: "start" | "stop" | "destroy") {
    setPending(agent.id);
    setActionError(null);
    try {
      const param = { id: agent.id };
      const res =
        kind === "start"
          ? await client.api.agents[":id"].start.$post({ param })
          : kind === "stop"
            ? await client.api.agents[":id"].stop.$post({ param })
            : await client.api.agents[":id"].$delete({ param });
      await unwrap(res);
      agents.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      setConfirm(null);
    }
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--ny-bg)",
        color: "var(--ny-text)",
        fontFamily: "var(--ny-font-sans)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "11px 20px",
          borderBottom: "1px solid var(--ny-border)",
          background: "var(--ny-surface-sunken)",
        }}
      >
        <Link
          to="/channels"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            textDecoration: "none",
            color: "var(--ny-text-subtle)",
            fontFamily: "var(--ny-font-mono)",
            fontSize: 12.5,
          }}
        >
          <ChevronLeft size={15} />
          {t("settings.backToWorkspace")}
        </Link>
        <span style={{ color: "var(--ny-text-subtle)" }}>/</span>
        <span style={{ fontFamily: "var(--ny-font-mono)", fontSize: 12.5, fontWeight: 600 }}>
          {t("agents.breadcrumb")}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <LanguageSwitcher />
          <ThemeToggle theme={theme} onChange={setTheme} label={t("nav.toggleTheme")} />
        </div>
      </header>

      <main
        className="bh-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "26px 24px 60px" }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <Heading as="h1" size="2xl">
                {t("agents.title")}
              </Heading>
              <Text
                as="p"
                size="sm"
                tone="muted"
                style={{ marginTop: 4, maxWidth: 560, lineHeight: 1.5 }}
              >
                {t("agents.description")}
              </Text>
            </div>
            <Button
              variant="primary"
              size="sm"
              iconStart={<Plus size={14} />}
              onClick={() => navigate("/agents/new")}
            >
              {t("agents.newAgent")}
            </Button>
          </div>

          {(agents.error || actionError) && (
            <div style={{ marginTop: 18 }}>
              <Alert
                tone="danger"
                title={t("agents.actionFailed")}
                onDismiss={() => setActionError(null)}
              >
                {actionError ?? agents.error}
              </Alert>
            </div>
          )}

          {agents.loading && !agents.data ? (
            <div style={{ marginTop: 40, display: "grid", placeItems: "center" }} aria-busy="true">
              <Spinner size="lg" label={t("common.loading")} />
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 14,
                marginTop: 20,
              }}
            >
              {(agents.data ?? []).map((agent) => {
                const statusEntry = agentStatusConfig[agent.status];
                const activityEntry = agentActivityConfig[agent.activity];
                const busy = pending === agent.id;
                return (
                  <div
                    key={agent.id}
                    style={{
                      border: "1px solid var(--ny-border)",
                      borderRadius: 12,
                      background: "var(--ny-surface)",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <div style={{ padding: "14px 15px 12px", flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ position: "relative", flex: "none" }}>
                          <span
                            style={{
                              width: 36,
                              height: 36,
                              display: "grid",
                              placeItems: "center",
                              borderRadius: 9,
                              background: "var(--ny-surface-raised)",
                              border: "1px solid var(--ny-accent-border)",
                              color: "var(--ny-accent-text)",
                              fontFamily: "var(--ny-font-mono)",
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            {initials(agent.handle)}
                          </span>
                          {/* Process dot on the avatar, activity pill beside the
                              handle — they fail independently, so they are drawn
                              as two signals rather than one. */}
                          <span
                            title={t(statusEntry.labelKey as TranslationKey)}
                            style={{
                              position: "absolute",
                              right: -2,
                              bottom: -2,
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              background: toneVar(statusEntry.tone),
                              border: "2px solid var(--ny-surface)",
                              animation: statusEntry.pulse
                                ? "nyPulse 1.4s ease-in-out infinite"
                                : undefined,
                            }}
                          />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <Link
                              to={`/agents/${agent.id}`}
                              style={{
                                fontFamily: "var(--ny-font-mono)",
                                fontSize: 13.5,
                                fontWeight: 700,
                                color: "var(--ny-text)",
                                textDecoration: "none",
                              }}
                            >
                              @{agent.handle}
                            </Link>
                            <span style={chipStyle(activityEntry.tone)}>
                              {activityEntry.ring && (
                                <span
                                  style={{
                                    width: 5,
                                    height: 5,
                                    borderRadius: "50%",
                                    background: toneVar(activityEntry.tone),
                                    animation: "nyPulse 1.1s ease-in-out infinite",
                                  }}
                                />
                              )}
                              {t(activityEntry.labelKey as TranslationKey)}
                            </span>
                          </div>
                          <Text size="xs" tone="subtle" truncate>
                            {agent.displayName}
                          </Text>
                        </div>
                      </div>

                      <div style={{ marginTop: 10, minHeight: 32 }}>
                        <Text size="xs" tone="subtle" style={{ lineHeight: 1.45 }}>
                          {agent.statusLine ?? t("agents.noStatusLine")}
                        </Text>
                      </div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                        <span style={metaChip}>{blueprintName(agent.blueprintId)}</span>
                        {/* Requested vs effective are separate columns on the
                            server for a reason: an invisible fallback lets
                            someone believe they have isolation they don't. */}
                        <span style={metaChip}>
                          {agent.runtimeUsed ?? agent.sandboxRuntime ?? "auto"}
                        </span>
                        <span style={metaChip}>
                          {t("agents.egressChip", { policy: agent.egressPolicy ?? "inherit" })}
                        </span>
                        {agent.pausedAt && (
                          <Badge tone="warning" size="sm">
                            {t("agents.paused")}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "9px 15px",
                        borderTop: "1px solid var(--ny-border)",
                        background: "var(--ny-surface-sunken)",
                      }}
                    >
                      <Link
                        to={`/agents/${agent.id}`}
                        style={{
                          fontFamily: "var(--ny-font-mono)",
                          fontSize: 11.5,
                          color: "var(--ny-accent-text)",
                          textDecoration: "none",
                        }}
                      >
                        {t("agents.attach")}
                      </Link>
                      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        {agent.status === "running" ? (
                          <Button
                            iconOnly
                            label={t("agents.stop")}
                            variant="ghost"
                            size="sm"
                            loading={busy}
                            onClick={() => setConfirm({ agent, kind: "stop" })}
                          >
                            <Square size={13} />
                          </Button>
                        ) : (
                          <Button
                            iconOnly
                            label={t("agents.start")}
                            variant="ghost"
                            size="sm"
                            loading={busy}
                            onClick={() => void run(agent, "start")}
                          >
                            <Play size={13} />
                          </Button>
                        )}
                        <Button
                          iconOnly
                          label={t("agents.destroy")}
                          variant="ghost"
                          size="sm"
                          loading={busy}
                          onClick={() => setConfirm({ agent, kind: "destroy" })}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </span>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={() => navigate("/agents/new")}
                style={{
                  border: "1px dashed var(--ny-border-strong)",
                  borderRadius: 12,
                  background: "transparent",
                  display: "grid",
                  placeItems: "center",
                  minHeight: 170,
                  color: "var(--ny-text-subtle)",
                  cursor: "pointer",
                  fontFamily: "var(--ny-font-mono)",
                  fontSize: 12,
                }}
              >
                <span
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
                >
                  <Plus size={20} />
                  {t("agents.newAgent")}
                </span>
              </button>
            </div>
          )}
        </div>
      </main>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={confirm?.kind === "destroy" ? t("agents.destroyTitle") : t("agents.stopTitle")}
        description={
          confirm
            ? confirm.kind === "destroy"
              ? t("agents.destroyBody", { handle: confirm.agent.handle })
              : t("agents.stopBody", { handle: confirm.agent.handle })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => confirm && void run(confirm.agent, confirm.kind)}
            >
              {confirm?.kind === "destroy" ? t("agents.destroy") : t("agents.stop")}
            </Button>
          </>
        }
      />
    </div>
  );
}
