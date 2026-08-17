import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Database,
  FileSearch,
  GitPullRequest,
  Hammer,
  Plus,
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
  Text,
  Textarea,
} from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useSession } from "@/lib/auth-client";
import { SettingsHeader } from "@/layouts/settings-layout";
import { AGENT_PRESETS, PRESET_OPTIONS, type PresetId } from "@/lib/agent-presets";

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
  sandboxRuntime: string;
  egressPolicy: string;
}

interface DraftState {
  id: string | null;
  name: string;
  cli: PresetId;
  agentCommand: string;
  dockerfileContent: string;
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: "",
  cli: "claude-code",
  agentCommand: AGENT_PRESETS["claude-code"].agentCommand,
  dockerfileContent: "",
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
 */
function buildState(status: string | null): BuildState {
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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );

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
                <Badge tone={buildTone[buildState(bp.imageBuildStatus)]} variant="subtle" size="sm">
                  {t(`blueprints.build.${buildState(bp.imageBuildStatus)}` as const)}
                </Badge>
                {isAdmin && (
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <Button
                      iconOnly
                      label={t("blueprints.buildImage")}
                      variant="ghost"
                      size="sm"
                      disabled={busy || bp.imageBuildStatus === "building"}
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
