import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Check,
  Database,
  FileSearch,
  Globe,
  GitBranch,
  GitPullRequest,
  ShieldCheck,
  ShieldOff,
  SquareDashed,
} from "lucide-react";
import { Alert, Button, Dialog, Field, Input, Spinner, Text } from "@notyet.im/ui";
import { z } from "zod";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useRuntimes } from "@/hooks/use-runtimes";

interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  cli: string;
  image: string | null;
  sandboxRuntime: string;
  egressPolicy: string;
}

type EgressPolicy = "allowlist" | "open" | "none";

/** A glyph per CLI, matching the mockup's per-blueprint icons. */
function blueprintIcon(cli: string) {
  switch (cli) {
    case "claude-code":
      return <FileSearch size={19} strokeWidth={1.8} />;
    case "codex":
      return <GitPullRequest size={19} strokeWidth={1.8} />;
    case "antigravity":
      return <Database size={19} strokeWidth={1.8} />;
    default:
      return <SquareDashed size={19} strokeWidth={1.8} />;
  }
}

const handleSchema = z
  .string()
  .min(2)
  .max(32)
  // Mirrors `handleSchema` in `server/api/agents.ts`. Mention parsing,
  // the unique index and this field must agree on what a handle looks like.
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

const metaChip = {
  fontFamily: "var(--ny-font-mono)",
  fontSize: 10.5,
  color: "var(--ny-text-subtle)",
  border: "1px solid var(--ny-border)",
  borderRadius: 5,
  padding: "1px 6px",
};

/**
 * Two-step wizard: pick a blueprint, then configure the instance.
 *
 * The split is not cosmetic — step 1 chooses the defaults that step 2 shows,
 * so presenting both at once would mean rendering a form whose values change
 * under the user as they scroll.
 */
export function CreateAgentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  /**
   * Creating an agent is a step inside the roster, not a place of its own, so
   * it renders as a modal over `/agents` rather than replacing the screen. The
   * URL is still `/agents/new` — the route is nested under the roster and this
   * is its outlet — so the link stays shareable and Back still works. Closing
   * means returning to the list underneath, which is exactly what dismissing a
   * dialog should do.
   */
  const close = () => navigate("/agents");

  const [step, setStep] = useState<1 | 2>(1);
  const [blueprintId, setBlueprintId] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [runtime, setRuntime] = useState<string | null>(null);
  const [egress, setEgress] = useState<EgressPolicy | null>(null);
  const [budget, setBudget] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );
  const availability = useRuntimes();

  const selected = blueprints.data?.find((b) => b.id === blueprintId) ?? null;
  const runtimes = availability.tiers;
  // Inherit the blueprint's defaults until the user overrides them, so the
  // form always shows what would actually happen if they pressed Create now.
  const effectiveRuntime = runtime ?? selected?.sandboxRuntime ?? "auto";
  const effectiveEgress = (egress ?? selected?.egressPolicy ?? "allowlist") as EgressPolicy;

  async function submit() {
    const nextErrors: Record<string, string> = {};
    if (!handleSchema.safeParse(handle).success) nextErrors.handle = t("createAgent.handleInvalid");
    if (!displayName.trim()) nextErrors.displayName = t("createAgent.displayNameRequired");
    if (gitRepoUrl.trim() && !/^https?:\/\/|^git@/.test(gitRepoUrl.trim())) {
      nextErrors.gitRepoUrl = t("createAgent.repoInvalid");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !blueprintId) return;

    const dollars = Number.parseFloat(budget);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await unwrap<{ id: string }>(
        await client.api.agents.$post({
          json: {
            handle,
            displayName: displayName.trim(),
            blueprintId,
            gitRepoUrl: gitRepoUrl.trim() || null,
            gitBranch: gitBranch.trim() || "main",
            sandboxRuntime: effectiveRuntime as "auto" | "runc" | "runsc" | "kata",
            egressPolicy: effectiveEgress,
            dailyBudgetCents:
              Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null,
          },
        }),
      );
      navigate(`/agents/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const stepDot = (n: number, active: boolean) => (
    <span
      style={{
        width: 22,
        height: 22,
        flex: "none",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11,
        fontWeight: 700,
        background: active ? "var(--ny-accent)" : "var(--ny-surface-active)",
        color: active ? "var(--ny-text-on-accent)" : "var(--ny-text-subtle)",
      }}
    >
      {n}
    </span>
  );

  const footer = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
      {step === 2 && (
        <Button variant="ghost" onClick={() => setStep(1)}>
          {t("common.back")}
        </Button>
      )}
      <span style={{ marginLeft: "auto" }} />
      <Button variant="ghost" onClick={close}>
        {t("common.cancel")}
      </Button>
      {step === 1 ? (
        <Button variant="primary" disabled={!blueprintId} onClick={() => setStep(2)}>
          {t("createAgent.continue")}
        </Button>
      ) : (
        <Button variant="primary" loading={submitting} onClick={() => void submit()}>
          {t("createAgent.create")}
        </Button>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      title={t("createAgent.title")}
      description={selected ? selected.name : t("createAgent.pickBlueprintHint")}
      closeLabel={t("common.cancel")}
      footer={footer}
    >
      <div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: step === 1 ? "var(--ny-text)" : "var(--ny-text-muted)",
              }}
            >
              {stepDot(1, true)}
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("createAgent.step1")}</span>
            </div>
            <div style={{ flex: 1, height: 1, background: "var(--ny-border)" }} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: step === 2 ? "var(--ny-text)" : "var(--ny-text-subtle)",
              }}
            >
              {stepDot(2, step === 2)}
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t("createAgent.step2")}</span>
            </div>
          </div>
        </div>

        <div>
          {submitError && (
            <div style={{ marginBottom: 16 }}>
              <Alert
                tone="danger"
                title={t("createAgent.failed")}
                onDismiss={() => setSubmitError(null)}
              >
                {submitError}
              </Alert>
            </div>
          )}

          {step === 1 ? (
            <>
              <Text as="p" size="sm" tone="muted" style={{ marginBottom: 14, lineHeight: 1.5 }}>
                {t("createAgent.blueprintBlurb")}
              </Text>

              {blueprints.loading && !blueprints.data ? (
                <div
                  style={{ display: "grid", placeItems: "center", padding: 40 }}
                  aria-busy="true"
                >
                  <Spinner label={t("common.loading")} />
                </div>
              ) : (blueprints.data ?? []).length === 0 ? (
                <Alert tone="warning" title={t("createAgent.noBlueprints")}>
                  {t("createAgent.noBlueprintsBody")}
                </Alert>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(blueprints.data ?? []).map((bp) => {
                    const sel = bp.id === blueprintId;
                    return (
                      <button
                        key={bp.id}
                        type="button"
                        aria-pressed={sel}
                        onClick={() => setBlueprintId(bp.id)}
                        style={{
                          display: "flex",
                          gap: 13,
                          alignItems: "flex-start",
                          textAlign: "left",
                          padding: "13px 14px",
                          borderRadius: 12,
                          cursor: "pointer",
                          border: `1px solid ${sel ? "var(--ny-accent)" : "var(--ny-border)"}`,
                          background: sel ? "var(--ny-accent-subtle)" : "var(--ny-surface)",
                          color: "var(--ny-text)",
                          fontFamily: "var(--ny-font-sans)",
                        }}
                      >
                        <span
                          style={{
                            width: 38,
                            height: 38,
                            flex: "none",
                            borderRadius: 10,
                            display: "grid",
                            placeItems: "center",
                            background: "var(--ny-surface-sunken)",
                            border: "1px solid var(--ny-border)",
                            color: "var(--ny-text-muted)",
                          }}
                        >
                          {blueprintIcon(bp.cli)}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontFamily: "var(--ny-font-mono)",
                                fontSize: 13.5,
                                fontWeight: 700,
                              }}
                            >
                              {bp.name}
                            </span>
                            <span
                              style={{
                                fontFamily: "var(--ny-font-mono)",
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: ".04em",
                                color: "var(--ny-info-text)",
                                background: "var(--ny-info-subtle)",
                                border: "1px solid var(--ny-info-border)",
                                borderRadius: 5,
                                padding: "1px 6px",
                              }}
                            >
                              {bp.cli}
                            </span>
                          </span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 12,
                              color: "var(--ny-text-subtle)",
                              marginTop: 3,
                            }}
                          >
                            {bp.description ?? t("createAgent.noDescription")}
                          </span>
                          <span style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                            <span style={metaChip}>{bp.image ?? t("createAgent.builtImage")}</span>
                            <span style={metaChip}>sandbox {bp.sandboxRuntime}</span>
                            <span style={metaChip}>egress {bp.egressPolicy}</span>
                          </span>
                        </span>
                        <span
                          style={{
                            width: 22,
                            height: 22,
                            flex: "none",
                            borderRadius: "50%",
                            display: "grid",
                            placeItems: "center",
                            color: "var(--ny-text-on-accent)",
                            background: "var(--ny-accent)",
                            opacity: sel ? 1 : 0,
                          }}
                        >
                          <Check size={13} strokeWidth={3} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div className="bh-form-pair">
                <Field label={t("createAgent.handle")} error={errors.handle} required>
                  <Input
                    value={handle}
                    onChange={(v) => setHandle(v.toLowerCase())}
                    prefix={<span style={{ color: "var(--ny-accent-text)" }}>@</span>}
                    placeholder="scout"
                    autoComplete="off"
                  />
                </Field>
                <Field label={t("createAgent.displayName")} error={errors.displayName} required>
                  <Input
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="Scout"
                    autoComplete="off"
                  />
                </Field>
              </div>

              <div className="bh-form-pair">
                <Field
                  label={t("createAgent.repo")}
                  help={t("createAgent.repoHelp")}
                  error={errors.gitRepoUrl}
                >
                  <Input
                    value={gitRepoUrl}
                    onChange={setGitRepoUrl}
                    placeholder="https://github.com/acme/storefront"
                    prefix={<GitBranch size={14} />}
                    autoComplete="off"
                  />
                </Field>
                <Field label={t("createAgent.branch")}>
                  <Input value={gitBranch} onChange={setGitBranch} placeholder="main" />
                </Field>
              </div>

              {/* Sandbox runtime. Unavailable runtimes stay visible and
                  unselectable rather than being hidden: silently omitting
                  gVisor on a macOS host would let someone believe they had
                  isolation they never asked for and never got. */}
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8,
                    gap: 8,
                  }}
                >
                  <Text size="xs" weight="semibold" tone="muted">
                    {t("createAgent.sandboxRuntime")}
                  </Text>
                  <Text size="xs" tone="subtle" mono>
                    {availability.data
                      ? t("createAgent.detectedOnHost")
                      : t("createAgent.detecting")}
                  </Text>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {runtimes.map((rt) => {
                    const sel = effectiveRuntime === rt.id && rt.available;
                    return (
                      <button
                        key={rt.id}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        disabled={!rt.available}
                        onClick={() => rt.available && setRuntime(rt.id)}
                        style={{
                          display: "flex",
                          gap: 12,
                          alignItems: "flex-start",
                          textAlign: "left",
                          padding: "11px 13px",
                          borderRadius: 10,
                          cursor: rt.available ? "pointer" : "not-allowed",
                          opacity: rt.available ? 1 : 0.72,
                          border: `1px solid ${sel ? "var(--ny-accent)" : "var(--ny-border)"}`,
                          background: sel ? "var(--ny-accent-subtle)" : "var(--ny-surface)",
                          color: "var(--ny-text)",
                          fontFamily: "var(--ny-font-sans)",
                        }}
                      >
                        <span
                          style={{
                            width: 18,
                            height: 18,
                            flex: "none",
                            marginTop: 1,
                            borderRadius: "50%",
                            display: "grid",
                            placeItems: "center",
                            border: `2px solid ${sel ? "var(--ny-accent)" : "var(--ny-border-strong)"}`,
                            background: sel ? "var(--ny-accent)" : "transparent",
                          }}
                        >
                          {sel && (
                            <span
                              style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: "var(--ny-text-on-accent)",
                              }}
                            />
                          )}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span
                              style={{
                                fontFamily: "var(--ny-font-mono)",
                                fontSize: 13,
                                fontWeight: 600,
                                color: rt.available ? "var(--ny-text)" : "var(--ny-text-muted)",
                              }}
                            >
                              {rt.name}
                            </span>
                            <span
                              style={{
                                fontFamily: "var(--ny-font-mono)",
                                fontSize: 9.5,
                                textTransform: "uppercase",
                                letterSpacing: ".04em",
                                borderRadius: 5,
                                padding: "1px 6px",
                                border: `1px solid ${rt.available ? "var(--ny-success-border)" : "var(--ny-border)"}`,
                                color: rt.available
                                  ? "var(--ny-success-text)"
                                  : "var(--ny-text-subtle)",
                                background: rt.available
                                  ? "var(--ny-success-subtle)"
                                  : "var(--ny-surface-sunken)",
                              }}
                            >
                              {t(rt.available ? "runtimes.available" : "runtimes.unavailable")}
                            </span>
                          </span>
                          <span
                            style={{
                              display: "block",
                              fontSize: 11.5,
                              color: "var(--ny-text-subtle)",
                              marginTop: 3,
                            }}
                          >
                            {t(rt.noteKey)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Network egress */}
              <div>
                <Text as="div" size="xs" weight="semibold" tone="muted" style={{ marginBottom: 8 }}>
                  {t("createAgent.egress")}
                </Text>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {(
                    [
                      ["allowlist", <ShieldCheck size={16} key="a" />],
                      ["open", <Globe size={16} key="o" />],
                      ["none", <ShieldOff size={16} key="n" />],
                    ] as const
                  ).map(([id, icon]) => {
                    const sel = effectiveEgress === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => setEgress(id)}
                        style={{
                          flex: "1 1 150px",
                          display: "flex",
                          flexDirection: "column",
                          textAlign: "left",
                          padding: "11px 12px",
                          borderRadius: 10,
                          cursor: "pointer",
                          border: `1px solid ${sel ? "var(--ny-accent)" : "var(--ny-border)"}`,
                          background: sel ? "var(--ny-accent-subtle)" : "var(--ny-surface)",
                          color: sel ? "var(--ny-accent-text)" : "var(--ny-text)",
                          fontFamily: "var(--ny-font-sans)",
                        }}
                      >
                        <span style={{ marginBottom: 6, display: "inline-flex" }}>{icon}</span>
                        <span
                          style={{
                            fontFamily: "var(--ny-font-mono)",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {t(`createAgent.egressOptions.${id}.name`)}
                        </span>
                        <span
                          style={{
                            fontSize: 10.5,
                            color: "var(--ny-text-subtle)",
                            marginTop: 2,
                            lineHeight: 1.35,
                          }}
                        >
                          {t(`createAgent.egressOptions.${id}.note`)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Daily budget */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  border: "1px solid var(--ny-border)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  background: "var(--ny-surface-sunken)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" weight="semibold">
                    {t("createAgent.budget")}
                  </Text>
                  <Text as="div" size="xs" tone="subtle" style={{ marginTop: 2 }}>
                    {t("createAgent.budgetHelp")}
                  </Text>
                </div>
                <div style={{ width: 120 }}>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={budget}
                    onChange={setBudget}
                    placeholder={t("createAgent.budgetUncapped")}
                    aria-label={t("createAgent.budget")}
                    prefix={<span style={{ color: "var(--ny-text-subtle)" }}>$</span>}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
