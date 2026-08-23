import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ShieldCheck, ShieldOff, TriangleAlert, X } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Input,
  Spinner,
  Switch,
  Text,
  VisuallyHidden,
} from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useSession } from "@/lib/auth-client";
import { SettingsHeader } from "@/layouts/settings-layout";

type EgressPolicy = "none" | "allowlist" | "open";

type EnforcementReason =
  | "policy-open"
  | "disabled"
  | "host-mode"
  | "unroutable-harness-url"
  | "no-token";

interface RuleRow {
  id: string;
  host: string;
  scope: "workspace" | "blueprint" | "agent";
  blueprintId: string | null;
  agentId: string | null;
  /** Resolved server-side: `workspace`, a blueprint name, or `@handle`. */
  scopeLabel: string;
  note: string | null;
  addedByName: string | null;
}

/** `GET /api/egress/status` — what was asked for, and what is actually in force. */
interface EgressStatus {
  enforced: boolean;
  reason: EnforcementReason | null;
  egressEnforceFlag: boolean;
  containerNetwork: string | null;
  harnessHost: string | null;
}

interface BlueprintRow {
  id: string;
  name: string;
  egressPolicy: EgressPolicy;
  egressAllowlist: string[] | null;
}

/**
 * Egress — the switch that decides whether a policy is binding, and the rules
 * it binds.
 *
 * This page used to be read-only, and its header said why: the rule table and
 * the proxy that enforces it had not shipped, so an editable table would have
 * let an operator add a host, see it listed, and believe an agent could reach
 * it. Both have shipped since. What had not was any way to turn enforcement
 * *on* — `docker_configs.egress_enforce` was a column with no writer, so a
 * blueprint could say `allowlist` while every agent ran unrestricted.
 *
 * Enforcement is not only a restriction, and the switch says both halves.
 * Under gVisor a container cannot reach Docker's embedded resolver: only names
 * pinned into `/etc/hosts` resolve. The CONNECT proxy resolves on the agent's
 * behalf, so enforcement is also the only working DNS such an agent has. With
 * it off, a gVisor agent does not reach *less* than its allowlist — it reaches
 * nothing, and dies against `api.anthropic.com` with `ETIMEOUT`.
 *
 * The flag and the effect are two signals, kept apart for the same reason the
 * sandbox runtime keeps `requested` and `used` apart. `BLACKHOUSE_NETWORK`
 * unset, an unroutable `BLACKHOUSE_CONTAINER_URL`, or a missing proxy token
 * each leave the switch on and nothing enforced — the one outcome worse than
 * enforcement being off, because it is isolation someone believes in.
 * `GET /api/egress/status` answers both, and the card renders the gap rather
 * than the setting.
 *
 * Rules, not the blueprint jsonb, are what the proxy reads. A blueprint's
 * `egressAllowlist` is a creation-time seed, copied into blueprint-scoped
 * rules once — on the first agent start, or from the button here — after which
 * editing the seed changes nothing. Editing therefore happens against the
 * table the matcher actually consults, and a seed that has not landed yet is
 * shown as pending rather than as an active rule.
 */
export function EgressPage() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which direction a confirmation is open for, or null for closed. */
  const [confirmEnforce, setConfirmEnforce] = useState<boolean | null>(null);
  /** Last value written to the flag, to catch an env override ignoring it. */
  const [wrote, setWrote] = useState<boolean | null>(null);

  const status = useResource<EgressStatus>(
    async () => unwrap<EgressStatus>(await client.api.egress.status.$get()),
    [],
  );
  const rules = useResource<RuleRow[]>(
    async () => unwrap<RuleRow[]>(await client.api.egress.rules.$get()),
    [],
  );
  const blueprints = useResource<BlueprintRow[]>(
    async () => unwrap<BlueprintRow[]>(await client.api.settings.blueprints.$get()),
    [],
  );
  // `GET /api/settings/docker` is deliberately not read here. It is admin-only
  // — a member would take a 403 for a page they are allowed to see — and the
  // only field this screen writes comes back on `status`, which any member can
  // read. The PUT leaves what it is not given alone, so the rest of the row
  // never has to make a round trip through the browser.

  /** Run a mutation, surface its message, and refresh the rule table. */
  function run(action: () => Promise<unknown>) {
    void (async () => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
        rules.reload();
      } catch (err) {
        setActionError(apiMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  function addRule(host: string, blueprintId: string | null) {
    run(async () => {
      await unwrap(
        await client.api.egress.rules.$post({
          json: { host, scope: blueprintId ? "blueprint" : "workspace", blueprintId },
        }),
      );
    });
  }

  /** Remove by position: within a scope a host is unique, but two agents can
   *  each be granted the same one, so the index is what identifies the row. */
  function removeRule(pool: RuleRow[], index: number) {
    const rule = pool[index];
    if (!rule) return;
    run(async () => {
      await unwrap(await client.api.egress.rules[":id"].$delete({ param: { id: rule.id } }));
    });
  }

  function copyDefaults(blueprintId: string) {
    run(async () => {
      await unwrap(
        await client.api.egress.blueprints[":id"].materialize.$post({
          param: { id: blueprintId },
        }),
      );
    });
  }

  async function setEnforce(next: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(
        await client.api.settings.docker.$put({
          // Just the switch. The route leaves every field it is not given
          // alone, so the daemon's host and TLS material do not have to make a
          // round trip through the browser to survive a write.
          json: { egressEnforce: next },
        }),
      );
      setWrote(next);
      // Refetched rather than assumed: the write says what was asked for, and
      // `status` is the only thing that knows whether it took effect.
      status.reload();
    } catch (err) {
      setActionError(apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const allRules = rules.data ?? [];
  const workspaceRules = allRules.filter((r) => r.scope === "workspace");
  const agentRules = allRules.filter((r) => r.scope === "agent");
  const blueprintRows = blueprints.data ?? [];

  const onAllowlist = blueprintRows.filter((bp) => bp.egressPolicy === "allowlist");
  const openPolicy = blueprintRows.filter((bp) => bp.egressPolicy === "open");

  // The column is not the only writer: `BLACKHOUSE_EGRESS_ENFORCE` overrides it
  // outright. Without this the switch would spring back with no explanation.
  // Only once the refetch has settled, though — `useResource` keeps the old
  // data visible while reloading, and reading it mid-flight would flash the
  // warning after every successful save.
  const overridden =
    wrote !== null &&
    !!status.data &&
    !status.loading &&
    !busy &&
    status.data.egressEnforceFlag !== wrote;

  const loading = (status.loading && !status.data) || (rules.loading && !rules.data);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SettingsHeader title={t("egress.title")} description={t("egress.description")} />

      {(status.error || rules.error || blueprints.error || actionError) && (
        <Alert tone="danger" title={t("egress.failed")} onDismiss={() => setActionError(null)}>
          {actionError ?? status.error ?? rules.error ?? blueprints.error}
        </Alert>
      )}

      <EnforcementCard
        status={status.data}
        canEdit={isAdmin}
        busy={busy}
        overridden={overridden}
        onRequest={setConfirmEnforce}
      />

      {loading ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }} aria-busy="true">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text size="sm" weight="semibold" style={{ marginRight: "auto" }}>
              {t("egress.rulesHeading")}
            </Text>
            <Badge tone="success" variant="subtle">
              {t("egress.countAllowlist", { count: onAllowlist.length })}
            </Badge>
            <Badge tone={openPolicy.length > 0 ? "warning" : "neutral"} variant="subtle">
              {t("egress.countOpen", { count: openPolicy.length })}
            </Badge>
          </div>

          <Text size="xs" tone="subtle">
            {t("egress.rulesApplyNote")}
          </Text>

          <RuleGroup
            title={t("egress.workspaceScope")}
            subtitle={t("egress.workspaceScopeHelp")}
            hosts={workspaceRules.map((r) => r.host)}
            canEdit={isAdmin}
            busy={busy}
            inputLabel={t("egress.addToWorkspace")}
            empty={t("egress.emptyWorkspace")}
            onAdd={(host) => addRule(host, null)}
            onRemove={(_host, index) => removeRule(workspaceRules, index)}
          />

          {blueprintRows.map((bp) => {
            const owned = allRules.filter((r) => r.blueprintId === bp.id);
            // A seed host with no matching rule has not been copied in yet, so
            // it grants nothing. Listing it beside the real rules would be the
            // exact lie this page was read-only to avoid. Compared
            // case-insensitively because the rule table stores the
            // canonicalized host and the jsonb seed stores whatever was typed.
            const pending = (bp.egressAllowlist ?? []).filter(
              (host) => !owned.some((r) => r.host.toLowerCase() === host.toLowerCase()),
            );

            return (
              <RuleGroup
                key={bp.id}
                title={bp.name}
                subtitle={t("egress.blueprintScopeHelp")}
                policy={bp.egressPolicy}
                hosts={owned.map((r) => r.host)}
                canEdit={isAdmin}
                busy={busy}
                inputLabel={t("egress.addToBlueprint", { name: bp.name })}
                empty={t("egress.emptyBlueprint")}
                onAdd={(host) => addRule(host, bp.id)}
                onRemove={(_host, index) => removeRule(owned, index)}
                footer={
                  pending.length > 0 ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                        marginTop: 10,
                      }}
                    >
                      <Text size="xs" tone="subtle" style={{ flex: "1 1 200px", minWidth: 0 }}>
                        {t("egress.pendingDefaults", {
                          count: pending.length,
                          hosts: pending.join(", "),
                        })}
                      </Text>
                      {isAdmin && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => copyDefaults(bp.id)}
                        >
                          {t("egress.copyDefaults")}
                        </Button>
                      )}
                    </div>
                  ) : undefined
                }
              />
            );
          })}

          {agentRules.length > 0 && (
            <RuleGroup
              title={t("egress.agentScope")}
              subtitle={t("egress.agentScopeHelp")}
              hosts={agentRules.map((r) => `${r.scopeLabel} · ${r.host}`)}
              canEdit={false}
              removable={isAdmin}
              busy={busy}
              empty={t("egress.emptyAgent")}
              onRemove={(_host, index) => removeRule(agentRules, index)}
            />
          )}
        </>
      )}

      <Dialog
        open={confirmEnforce === true}
        onClose={() => setConfirmEnforce(null)}
        size="sm"
        title={t("egress.confirmOnTitle")}
        description={t("egress.confirmOnBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnforce(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                setConfirmEnforce(null);
                void setEnforce(true);
              }}
            >
              {t("egress.confirmOnAction")}
            </Button>
          </>
        }
      >
        <Text size="sm" tone="muted">
          {t("egress.confirmOnDetail")}
        </Text>
      </Dialog>

      <Dialog
        open={confirmEnforce === false}
        onClose={() => setConfirmEnforce(null)}
        size="sm"
        title={t("egress.confirmOffTitle")}
        description={t("egress.confirmOffBody")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnforce(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => {
                setConfirmEnforce(null);
                void setEnforce(false);
              }}
            >
              {t("egress.confirmOffAction")}
            </Button>
          </>
        }
      >
        <Text size="sm" tone="muted">
          {t("egress.confirmOffDetail")}
        </Text>
      </Dialog>
    </div>
  );
}

/**
 * The switch, and the sentence that says what flipping it does.
 *
 * Three states, not two. `enforced` is the flag on and the setup able to carry
 * it; `off` is the flag off, where an `allowlist` policy is decorative; and
 * `ineffective` is the flag on with something in the environment preventing
 * it, which is warned about in danger tone because it is the state that looks
 * safe from the switch alone.
 */
function EnforcementCard({
  status,
  canEdit,
  busy,
  overridden,
  onRequest,
}: {
  status: EgressStatus | null;
  canEdit: boolean;
  busy: boolean;
  /** The write did not take: an env var is deciding this, not the column. */
  overridden: boolean;
  onRequest: (next: boolean) => void;
}) {
  const { t } = useTranslation();

  const flag = status?.egressEnforceFlag ?? false;
  const state: "enforced" | "ineffective" | "off" = status?.enforced
    ? "enforced"
    : flag
      ? "ineffective"
      : "off";

  // `as const` so the same value can name a `--ny-*` token family and a Badge
  // tone, rather than being widened to `string` and re-derived for the badge.
  const tone = ({ enforced: "success", ineffective: "danger", off: "warning" } as const)[state];
  const icon = {
    enforced: <ShieldCheck size={15} strokeWidth={2} />,
    ineffective: <TriangleAlert size={15} strokeWidth={2} />,
    off: <ShieldOff size={15} strokeWidth={2} />,
  }[state];

  return (
    <section
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        border: `1px solid var(--ny-${tone}-border)`,
        background: `var(--ny-${tone}-subtle)`,
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "none",
          width: 28,
          height: 28,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          background: "var(--ny-surface)",
          color: `var(--ny-${tone}-text)`,
        }}
      >
        {icon}
      </span>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text size="sm" weight="semibold">
            {t("egress.enforceTitle")}
          </Text>
          <Badge tone={tone} variant="outline" size="sm">
            {t(`egress.state.${state}` as const)}
          </Badge>
        </div>

        <Text size="xs" tone="subtle" style={{ lineHeight: 1.5 }}>
          {t(`egress.stateBody.${state}` as const)}
        </Text>

        {state === "ineffective" && status?.reason && (
          <Text size="xs" tone="danger" style={{ lineHeight: 1.5 }}>
            {t(`egress.reason.${status.reason}` as const, {
              network: status.containerNetwork ?? "—",
              host: status.harnessHost ?? "—",
            })}
          </Text>
        )}

        {state === "enforced" && status?.containerNetwork && (
          <Text size="xs" tone="subtle" mono>
            {t("egress.network", { network: status.containerNetwork })}
          </Text>
        )}

        {overridden && (
          <Text size="xs" tone="danger" style={{ lineHeight: 1.5 }}>
            {t("egress.envOverride")}
          </Text>
        )}

        {!canEdit && (
          <Text size="xs" tone="subtle">
            {t("egress.enforceAdminOnly")}
          </Text>
        )}
      </div>

      <div style={{ flex: "none", marginTop: 2 }}>
        <Switch
          checked={flag}
          disabled={!canEdit || busy || !status}
          onChange={onRequest}
          label={<VisuallyHidden>{t("egress.enforceTitle")}</VisuallyHidden>}
        />
      </div>
    </section>
  );
}

/** One scope's rules: the hosts it grants, and the controls that change them. */
function RuleGroup({
  title,
  subtitle,
  policy,
  hosts,
  canEdit,
  removable = canEdit,
  busy,
  inputLabel,
  empty,
  onAdd,
  onRemove,
  footer,
}: {
  title: string;
  subtitle: string;
  /** Shown for a blueprint group, where the policy decides if rules are read. */
  policy?: EgressPolicy;
  hosts: string[];
  canEdit: boolean;
  /** Split from `canEdit` for agent-scoped rules: they can be revoked here,
   *  but granting one belongs on the agent, not on this page. */
  removable?: boolean;
  busy: boolean;
  inputLabel?: string;
  empty: string;
  onAdd?: (host: string) => void;
  onRemove?: (host: string, index: number) => void;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <section
      style={{
        border: "1px solid var(--ny-border)",
        borderRadius: 12,
        background: "var(--ny-surface)",
        padding: "13px 15px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Text size="sm" weight="semibold" mono>
          {title}
        </Text>
        {policy && (
          <Badge
            tone={policy === "open" ? "warning" : policy === "none" ? "neutral" : "info"}
            variant="outline"
            size="sm"
          >
            {policy}
          </Badge>
        )}
        <span style={{ marginLeft: "auto" }}>
          <Text size="xs" tone="subtle" numeric>
            {t("egress.hostCount", { count: hosts.length })}
          </Text>
        </span>
      </div>

      <Text as="div" size="xs" tone="subtle" style={{ marginTop: 3, lineHeight: 1.5 }}>
        {subtitle}
      </Text>

      {policy === "open" && (
        <Text as="div" size="xs" tone="danger" style={{ marginTop: 6, lineHeight: 1.5 }}>
          {t("egress.policyOpenNote")}
        </Text>
      )}
      {policy === "none" && (
        <Text as="div" size="xs" tone="subtle" style={{ marginTop: 6, lineHeight: 1.5 }}>
          {t("egress.policyNoneNote")}
        </Text>
      )}

      <div style={{ marginTop: 10 }}>
        <AllowlistEditor
          hosts={hosts}
          empty={empty}
          label={inputLabel ?? title}
          busy={busy}
          canAdd={canEdit}
          canRemove={removable}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      </div>

      {footer}
    </section>
  );
}

/**
 * Hosts as chips, plus the box that adds one.
 *
 * Shared with the blueprint form, which edits a draft in memory rather than
 * the rule table — hence `onAdd`/`onRemove` callbacks over a plain `string[]`
 * instead of anything that knows about rows. Removal is by index because the
 * same host can legitimately appear twice in one list (two agents granted the
 * same name), and a lookup by value would delete the wrong one.
 */
export function AllowlistEditor({
  hosts,
  empty,
  label,
  busy = false,
  canAdd = true,
  canRemove = true,
  onAdd,
  onRemove,
}: {
  hosts: string[];
  /** What to say when there are none — the consequence, not "no items". */
  empty: string;
  /** Accessible name for the input; several editors share one page. */
  label: string;
  busy?: boolean;
  canAdd?: boolean;
  canRemove?: boolean;
  onAdd?: (host: string) => void;
  onRemove?: (host: string, index: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const host = normalizeHost(draft);
    if (!host) {
      setError(t("egress.invalidHost"));
      return;
    }
    if (hosts.includes(host)) {
      setError(t("egress.duplicateHost"));
      return;
    }
    setError(null);
    setDraft("");
    onAdd?.(host);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {hosts.length === 0 ? (
        <Text size="xs" tone="subtle" style={{ lineHeight: 1.5 }}>
          {empty}
        </Text>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {hosts.map((host, index) => (
            <span
              key={`${host}:${index}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid var(--ny-border)",
                borderRadius: 6,
                background: "var(--ny-surface-sunken)",
                padding: canRemove ? "2px 3px 2px 8px" : "3px 8px",
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11.5,
                color: "var(--ny-text)",
              }}
            >
              {host}
              {canRemove && (
                <Button
                  iconOnly
                  label={t("egress.removeHost", { host })}
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRemove?.(host, index)}
                >
                  <X size={12} />
                </Button>
              )}
            </span>
          ))}
        </div>
      )}

      {canAdd && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}
        >
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <Input
              value={draft}
              onChange={(value) => {
                setDraft(value);
                setError(null);
              }}
              size="sm"
              placeholder="api.anthropic.com"
              aria-label={label}
              invalid={error !== null}
              disabled={busy}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            iconStart={<Plus size={13} />}
            disabled={busy || draft.trim() === ""}
          >
            {t("egress.addHost")}
          </Button>
          <Text size="xs" tone={error ? "danger" : "subtle"} style={{ flexBasis: "100%" }}>
            {error ?? t("egress.hostHelp")}
          </Text>
        </form>
      )}
    </div>
  );
}

/**
 * Tidy what an operator typed into what the matcher compares against — a
 * pasted URL is the common case, and `https://api.anthropic.com/v1` stored
 * verbatim is a rule that can never fire.
 *
 * Deliberately not the matcher: the server canonicalizes and rejects (a rule
 * has to look like a name a resolver could answer for), and its message is
 * what the user sees when this passes something the server will not take. Two
 * copies of that grammar would drift.
 */
function normalizeHost(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "");
  if (!host || /\s/.test(host) || host.length > 253) return null;
  return host;
}

/** These routes answer `{error}`; `ApiError` carries the body verbatim. */
function apiMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const message = (parsed as { error: unknown }).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // Not JSON. The body is already the most specific thing we have.
  }
  return raw;
}
