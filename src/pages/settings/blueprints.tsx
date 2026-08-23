import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  FileSearch,
  GitPullRequest,
  Hammer,
  Plus,
  ScrollText,
  SquarePen,
  SquareDashed,
  Trash2,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  Text,
  Textarea,
  VisuallyHidden,
} from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useSession } from "@/lib/auth-client";
import { SettingsHeader } from "@/layouts/settings-layout";
import { timeAgo } from "@/lib/time";
import { AGENT_PRESETS, PRESET_OPTIONS, type PresetId } from "@/lib/agent-presets";
// The chip-and-input editor the egress screen is built around. Shared rather
// than re-cut here so a host typed in one place is tidied the same way in the
// other — this form seeds the list, that page edits what the proxy reads.
import { AllowlistEditor } from "./egress";

type EgressPolicy = "none" | "allowlist" | "open";

const EGRESS_POLICIES: EgressPolicy[] = ["none", "allowlist", "open"];

interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  cli: PresetId;
  agentCommand: string | null;
  image: string | null;
  dockerfileContent: string | null;
  /**
   * Null for a blueprint that names a prebuilt image and has never been built
   * here — which is every seeded blueprint, so it is the common case, not an
   * edge one. The column is nullable server-side; typing it `string` let
   * `blueprints.build.null` render as a raw i18n key in the card footer.
   */
  imageBuildStatus: string | null;
  /** Whatever the daemon streamed back, or the error that ended the build. */
  imageBuildLog: string | null;
  /**
   * The column is `last_built_at` and the list endpoint returns the whole row,
   * so this is `lastBuiltAt` — there is no `imageBuild` prefix on it, unlike
   * its two neighbours. Only set once a build has succeeded here; a failure
   * leaves the previous success's timestamp standing, which is why it is read
   * only in the `success` branch below.
   */
  lastBuiltAt: string | null;
  sandboxRuntime: string;
  egressPolicy: EgressPolicy;
  /**
   * A creation-time seed, not the live allowlist. It is copied into
   * blueprint-scoped `egress_rules` once — on the first agent start, or from
   * the button in Settings → Egress — and the rules are what the proxy reads
   * from then on.
   */
  egressAllowlist: string[] | null;
  /** Each one starts a real service inside the sandbox; both default off. */
  enableIde: boolean;
  enableBrowser: boolean;
}

interface DraftState {
  id: string | null;
  name: string;
  cli: PresetId;
  agentCommand: string;
  dockerfileContent: string;
  egressPolicy: EgressPolicy;
  egressAllowlist: string[];
  enableIde: boolean;
  enableBrowser: boolean;
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: "",
  cli: "claude-code",
  agentCommand: AGENT_PRESETS["claude-code"].agentCommand,
  dockerfileContent: "",
  // Matches the column defaults: an allowlist policy with nothing on it yet,
  // and neither service running. A new blueprint must not be heavier than the
  // one an operator would have got before these switches existed.
  egressPolicy: "allowlist",
  egressAllowlist: [],
  enableIde: false,
  enableBrowser: false,
};

function cliIcon(cli: string) {
  switch (cli) {
    case "claude-code":
      return <FileSearch size={17} strokeWidth={1.8} />;
    case "codex":
      return <GitPullRequest size={17} strokeWidth={1.8} />;
    case "antigravity":
      return <Database size={17} strokeWidth={1.8} />;
    default:
      return <SquareDashed size={17} strokeWidth={1.8} />;
  }
}

const buildTone = {
  none: "neutral",
  building: "info",
  success: "success",
  error: "danger",
} as const;

type BuildState = keyof typeof buildTone;

/**
 * Narrow the nullable, free-text build status to one of the four states we
 * have a label and a tone for.
 *
 * Null is the ordinary case, not an edge one: a blueprint that names a
 * prebuilt image has never been built here. Interpolating the raw value into
 * the translation key rendered `blueprints.build.null` verbatim in the card
 * footer — which is also why this returns a `BuildState` rather than a string,
 * so `t()` keeps checking the key against `en.json`.
 *
 * The runner writes `built` and `failed` while this vocabulary (and
 * `blueprints.build.*`) says `success` and `error`, so both spellings are
 * folded in here rather than in a second table beside `buildTone`. Without the
 * fold every finished build — including a failed one — falls through to
 * `none` and reads as "not built", which is how a build failure managed to
 * look like a build that never ran.
 */
function buildState(status: string | null): BuildState {
  if (status === "built") return "success";
  if (status === "failed") return "error";
  return status && status in buildTone ? (status as BuildState) : "none";
}

const metaChip = {
  fontFamily: "var(--ny-font-mono)",
  fontSize: 10.5,
  color: "var(--ny-text-subtle)",
  border: "1px solid var(--ny-border)",
  borderRadius: 5,
  padding: "1px 6px",
};

/**
 * The build outcome, at the density a card footer can afford: the chip, plus
 * the one detail the state raises a question about. A failure asks "why?", so
 * it gets the control that opens the log; a success asks "how stale is this?",
 * so it gets the time. `building` gets a spinner because a static chip alone
 * reads like a state the build has settled in.
 */
function BuildStatus({ row, onShowLog }: { row: BlueprintRow; onShowLog: () => void }) {
  const { t } = useTranslation();
  const state = buildState(row.imageBuildStatus);

  return (
    <>
      <Badge tone={buildTone[state]} variant="subtle" size="sm">
        {t(`blueprints.build.${state}` as const)}
      </Badge>
      {state === "building" && <Spinner size="sm" label={t("blueprints.build.building")} />}
      {state === "success" && row.lastBuiltAt && (
        <Text size="xs" tone="subtle" truncate style={{ minWidth: 0 }}>
          {t("blueprints.builtWhen", { when: timeAgo(row.lastBuiltAt) })}
        </Text>
      )}
      {state === "error" && (
        <Button variant="ghost" size="sm" iconStart={<ScrollText size={12} />} onClick={onShowLog}>
          {t("blueprints.viewLog")}
        </Button>
      )}
    </>
  );
}

/** One sandbox service: the switch, its name, and what running it costs. */
function ServiceToggle({
  checked,
  onChange,
  title,
  help,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  help: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <div style={{ flex: "none", marginTop: 1 }}>
        <Switch
          size="sm"
          checked={checked}
          onChange={onChange}
          // The visible name is to the right; this is the control's own.
          label={<VisuallyHidden>{title}</VisuallyHidden>}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <Text as="div" size="sm">
          {title}
        </Text>
        <Text as="div" size="xs" tone="subtle" style={{ marginTop: 2, lineHeight: 1.45 }}>
          {help}
        </Text>
      </div>
    </div>
  );
}

/**
 * Blueprints — the reusable agent definitions the create-agent wizard starts
 * from. Reads are open to any member; every mutation is admin-only on the
 * server, so the controls are hidden rather than left to fail with a 403.
 */
export function BlueprintsPage() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BlueprintRow | null>(null);
  const [logId, setLogId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );

  // Looked up rather than held: a rebuild reloads the list under an open
  // dialog, and a snapshot taken on click would keep showing the log of the
  // build the user just replaced. It also closes itself if the row goes away.
  const logRow = (blueprints.data ?? []).find((bp) => bp.id === logId) ?? null;

  async function save() {
    if (!draft) return;
    setBusy(true);
    setActionError(null);
    try {
      const json = {
        cli: draft.cli,
        name: draft.name.trim(),
        agentCommand: draft.agentCommand.trim() || undefined,
        dockerfileContent: draft.dockerfileContent.trim() || null,
        egressPolicy: draft.egressPolicy,
        egressAllowlist: draft.egressAllowlist,
        enableIde: draft.enableIde,
        enableBrowser: draft.enableBrowser,
      };
      const res = draft.id
        ? await client.api.settings.blueprints[":id"].$put({ param: { id: draft.id }, json })
        : await client.api.settings.blueprints.$post({ json });
      await unwrap(res);
      setDraft(null);
      blueprints.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function destroy(row: BlueprintRow) {
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(await client.api.settings.blueprints[":id"].$delete({ param: { id: row.id } }));
      setConfirmDelete(null);
      blueprints.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function build(row: BlueprintRow) {
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(
        await client.api.settings.blueprints[":id"].build.$post({ param: { id: row.id } }),
      );
      blueprints.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Pull the shipped Dockerfile for a preset into the editor. */
  async function loadDefaultDockerfile(cli: PresetId) {
    try {
      const text = await unwrap<string>(
        await client.api.settings["default-dockerfile"].$get({ query: { preset: cli } }),
      );
      setDraft((current) => (current ? { ...current, dockerfileContent: text } : current));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SettingsHeader
        title={t("blueprints.title")}
        description={t("blueprints.description")}
        action={
          isAdmin ? (
            <Button
              variant="primary"
              size="sm"
              iconStart={<Plus size={14} />}
              onClick={() => setDraft(EMPTY_DRAFT)}
            >
              {t("blueprints.new")}
            </Button>
          ) : undefined
        }
      />

      {(blueprints.error || actionError) && (
        <Alert tone="danger" title={t("blueprints.failed")} onDismiss={() => setActionError(null)}>
          {actionError ?? blueprints.error}
        </Alert>
      )}

      {blueprints.loading && !blueprints.data ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }} aria-busy="true">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 14,
          }}
        >
          {(blueprints.data ?? []).map((bp) => (
            <div
              key={bp.id}
              data-testid={`blueprint-card-${bp.id}`}
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
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      flex: "none",
                      borderRadius: 9,
                      background: "var(--ny-surface-sunken)",
                      border: "1px solid var(--ny-border)",
                      display: "grid",
                      placeItems: "center",
                      color: "var(--ny-text-muted)",
                    }}
                  >
                    {cliIcon(bp.cli)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--ny-font-mono)",
                        fontSize: 13.5,
                        fontWeight: 700,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {bp.name}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--ny-font-mono)",
                        fontSize: 10.5,
                        color: "var(--ny-info-text)",
                        marginTop: 1,
                      }}
                    >
                      {bp.cli}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 10, minHeight: 34 }}>
                  <Text size="xs" tone="subtle" style={{ lineHeight: 1.45 }}>
                    {bp.description ?? t("blueprints.noDescription")}
                  </Text>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  <span style={metaChip}>{bp.image ?? t("blueprints.builtImage")}</span>
                  <span style={metaChip}>{bp.sandboxRuntime}</span>
                  <span style={metaChip}>{bp.egressPolicy}</span>
                  {bp.enableIde && <span style={metaChip}>ide</span>}
                  {bp.enableBrowser && <span style={metaChip}>browser</span>}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: "9px 15px",
                  borderTop: "1px solid var(--ny-border)",
                  background: "var(--ny-surface-sunken)",
                }}
              >
                <BuildStatus row={bp} onShowLog={() => setLogId(bp.id)} />
                {isAdmin && (
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <Button
                      iconOnly
                      label={t("blueprints.buildImage")}
                      variant="ghost"
                      size="sm"
                      disabled={busy || buildState(bp.imageBuildStatus) === "building"}
                      onClick={() => void build(bp)}
                    >
                      <Hammer size={13} />
                    </Button>
                    <Button
                      iconOnly
                      label={t("common.edit")}
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          id: bp.id,
                          name: bp.name,
                          cli: bp.cli,
                          agentCommand: bp.agentCommand ?? "",
                          dockerfileContent: bp.dockerfileContent ?? "",
                          egressPolicy: bp.egressPolicy,
                          egressAllowlist: bp.egressAllowlist ?? [],
                          enableIde: bp.enableIde,
                          enableBrowser: bp.enableBrowser,
                        })
                      }
                    >
                      <SquarePen size={13} />
                    </Button>
                    <Button
                      iconOnly
                      label={t("common.delete")}
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDelete(bp)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </span>
                )}
              </div>
            </div>
          ))}

          {isAdmin && (
            <button
              type="button"
              onClick={() => setDraft(EMPTY_DRAFT)}
              style={{
                border: "1px dashed var(--ny-border-strong)",
                borderRadius: 12,
                background: "transparent",
                display: "grid",
                placeItems: "center",
                minHeight: 150,
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
                {t("blueprints.new")}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Create / edit */}
      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        size="lg"
        title={draft?.id ? t("blueprints.edit") : t("blueprints.new")}
        description={t("blueprints.dialogDescription")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              {draft?.id ? t("common.save") : t("common.create")}
            </Button>
          </>
        }
      >
        {draft && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="bh-form-pair">
              <Field label={t("blueprints.name")} required>
                <Input
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                  placeholder="repo-summariser"
                />
              </Field>
              <Field label={t("blueprints.cli")} help={t("blueprints.cliHelp")}>
                <Select
                  value={draft.cli}
                  label={t("blueprints.cli")}
                  onChange={(cli) =>
                    // Switching CLI re-seeds the command: it is the sidecar
                    // adapter key *and* the process the entrypoint execs, so a
                    // stale command from the previous CLI would never start.
                    setDraft({
                      ...draft,
                      cli,
                      agentCommand: AGENT_PRESETS[cli].agentCommand,
                    })
                  }
                  options={PRESET_OPTIONS.map((preset) => ({
                    value: preset.id,
                    label: preset.displayName,
                  }))}
                />
              </Field>
            </div>

            <Field label={t("blueprints.agentCommand")} help={t("blueprints.agentCommandHelp")}>
              <Input
                value={draft.agentCommand}
                onChange={(v) => setDraft({ ...draft, agentCommand: v })}
                placeholder="claude --dangerously-skip-permissions"
              />
            </Field>

            <Field label={t("blueprints.egressPolicy")} help={t("blueprints.egressPolicyHelp")}>
              <Select
                value={draft.egressPolicy}
                label={t("blueprints.egressPolicy")}
                onChange={(egressPolicy) => setDraft({ ...draft, egressPolicy })}
                options={EGRESS_POLICIES.map((policy) => ({
                  value: policy,
                  label: t(`blueprints.policy.${policy}` as const),
                }))}
              />
            </Field>

            {/* Not a dismissible aside: `open` is the one policy under which
                nothing below is consulted, and the list stays editable so a
                blueprint can be moved back off `open` without retyping it. */}
            {draft.egressPolicy === "open" && (
              <Alert tone="warning">{t("blueprints.egressOpenWarning")}</Alert>
            )}

            <Field
              label={t("blueprints.egressAllowlist")}
              help={t("blueprints.egressAllowlistHelp")}
            >
              <AllowlistEditor
                hosts={draft.egressAllowlist}
                empty={t("blueprints.egressAllowlistEmpty")}
                label={t("blueprints.egressAllowlistLabel")}
                onAdd={(host) =>
                  setDraft({ ...draft, egressAllowlist: [...draft.egressAllowlist, host] })
                }
                onRemove={(_host, index) =>
                  setDraft({
                    ...draft,
                    egressAllowlist: draft.egressAllowlist.filter((_, i) => i !== index),
                  })
                }
              />
            </Field>

            {/* Deliberately not a `Field`: two controls under one label would
                leave the label pointing at whichever switch came first. */}
            <div>
              <Text as="div" size="sm" weight="semibold">
                {t("blueprints.services")}
              </Text>
              <Text as="div" size="xs" tone="subtle" style={{ marginTop: 3, lineHeight: 1.5 }}>
                {t("blueprints.servicesHelp")}
              </Text>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                <ServiceToggle
                  checked={draft.enableIde}
                  onChange={(enableIde) => setDraft({ ...draft, enableIde })}
                  title={t("blueprints.enableIde")}
                  help={t("blueprints.enableIdeHelp")}
                />
                <ServiceToggle
                  checked={draft.enableBrowser}
                  onChange={(enableBrowser) => setDraft({ ...draft, enableBrowser })}
                  title={t("blueprints.enableBrowser")}
                  help={t("blueprints.enableBrowserHelp")}
                />
              </div>
            </div>

            <Field label={t("blueprints.dockerfile")} help={t("blueprints.dockerfileHelp")}>
              <Textarea
                value={draft.dockerfileContent}
                onChange={(v) => setDraft({ ...draft, dockerfileContent: v })}
                rows={10}
                size="sm"
                placeholder="FROM node:24-slim"
              />
            </Field>

            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void loadDefaultDockerfile(draft.cli)}
              >
                {t("blueprints.loadDefault")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Build log */}
      <Dialog
        open={logRow !== null}
        onClose={() => setLogId(null)}
        size="lg"
        title={t("blueprints.buildLog")}
        description={
          logRow ? t("blueprints.buildLogDescription", { name: logRow.name }) : undefined
        }
        footer={
          <Button variant="ghost" onClick={() => setLogId(null)}>
            {t("common.close")}
          </Button>
        }
      >
        {logRow &&
          (logRow.imageBuildLog?.trim() ? (
            <pre
              className="bh-scroll"
              data-testid="blueprint-build-log"
              tabIndex={0}
              aria-label={t("blueprints.buildLog")}
              style={{
                margin: 0,
                maxHeight: "min(52vh, 420px)",
                overflow: "auto",
                padding: "12px 14px",
                background: "var(--ny-surface-sunken)",
                border: "1px solid var(--ny-border)",
                borderRadius: 9,
                fontFamily: "var(--ny-font-mono)",
                fontSize: 12,
                lineHeight: 1.55,
                color: "var(--ny-text)",
                // Docker writes one long line as readily as a hundred short
                // ones, and the failure is usually the long one. `pre-wrap`
                // keeps the newlines that are there; `anywhere` breaks a run
                // with nothing to break on — an image digest, a path — instead
                // of letting it push the dialog sideways.
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {logRow.imageBuildLog}
            </pre>
          ) : (
            // A build that failed before the daemon said anything still has to
            // account for itself; an empty box would read as a UI fault.
            <Text size="sm" tone="subtle">
              {t("blueprints.buildLogEmpty")}
            </Text>
          ))}
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        size="sm"
        title={t("blueprints.deleteTitle")}
        description={
          confirmDelete ? t("blueprints.deleteBody", { name: confirmDelete.name }) : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => confirmDelete && void destroy(confirmDelete)}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
