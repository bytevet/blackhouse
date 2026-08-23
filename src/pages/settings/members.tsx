import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Dialog, Field, Input, Select, Spinner, Text } from "@notyet.im/ui";
import { client, unwrap, type Paginated } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useSession } from "@/lib/auth-client";
import { SettingsHeader } from "@/layouts/settings-layout";
import { agentStatusConfig, toneVar } from "@/lib/agent-status";
import type { AgentStatus } from "@/db/schema";
import type { TranslationKey } from "@/i18n";

interface UserRow {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string | null;
  banned: boolean | null;
}

interface AgentRow {
  id: string;
  handle: string;
  displayName: string;
  blueprintId: string;
  status: AgentStatus;
}

interface InviteDraft {
  name: string;
  email: string;
  username: string;
  password: string;
  role: "admin" | "user";
}

const EMPTY_INVITE: InviteDraft = {
  name: "",
  email: "",
  username: "",
  password: "",
  role: "user",
};

function initials(text: string): string {
  const parts = text
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : text.replace(/^@/, "").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * People and agents in this workspace, in one list.
 *
 * They share a screen because they share a channel — an agent is a member you
 * can @mention — but they are badged apart, because only humans can approve an
 * agent→agent dispatch and that distinction is a safety property, not a
 * cosmetic one. Agents carry no role for the same reason.
 *
 * The design calls this "Invite people" with an email invite flow. Better Auth
 * has no invite table here, so this creates the account directly with a
 * starting password — the same thing the old team screen did.
 */
export function MembersPage() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const selfId = session?.user?.id;

  const [draft, setDraft] = useState<InviteDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const users = useResource<Paginated<UserRow>>(
    async () => unwrap<Paginated<UserRow>>(await client.api.settings.users.$get({ query: {} })),
    [],
  );
  const agents = useResource<AgentRow[]>(
    async () => unwrap<AgentRow[]>(await client.api.agents.$get()),
    [],
  );

  async function invite() {
    if (!draft) return;
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(
        await client.api.settings.users.$post({
          json: {
            name: draft.name.trim(),
            email: draft.email.trim(),
            username: draft.username.trim() || undefined,
            password: draft.password,
            role: draft.role,
          },
        }),
      );
      setDraft(null);
      users.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: UserRow) {
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(await client.api.settings.users[":id"].$delete({ param: { id: row.id } }));
      setConfirmRemove(null);
      users.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(row: UserRow, role: string) {
    setBusy(true);
    setActionError(null);
    try {
      await unwrap(
        await client.api.settings.users[":id"].role.$put({
          param: { id: row.id },
          json: { role },
        }),
      );
      users.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const rowStyle = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 15px",
    borderBottom: "1px solid var(--ny-border)",
    flexWrap: "wrap" as const,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <SettingsHeader
        title={t("members.title")}
        description={t("members.description")}
        action={
          isAdmin ? (
            <Button
              variant="primary"
              size="sm"
              iconStart={<Plus size={14} />}
              onClick={() => setDraft(EMPTY_INVITE)}
            >
              {t("members.add")}
            </Button>
          ) : undefined
        }
      />

      {(users.error || actionError) && (
        <Alert tone="danger" title={t("members.failed")} onDismiss={() => setActionError(null)}>
          {actionError ?? users.error}
        </Alert>
      )}

      {users.loading && !users.data ? (
        <div style={{ display: "grid", placeItems: "center", padding: 40 }} aria-busy="true">
          <Spinner label={t("common.loading")} />
        </div>
      ) : (
        <div
          style={{
            border: "1px solid var(--ny-border)",
            borderRadius: 11,
            overflow: "hidden",
            background: "var(--ny-surface)",
          }}
        >
          {(users.data?.data ?? []).map((user) => (
            <div key={user.id} data-testid={`member-row-${user.id}`} style={rowStyle}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  flex: "none",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  background: "var(--ny-info-subtle)",
                  color: "var(--ny-info-text)",
                }}
              >
                {initials(user.name || user.email)}
              </span>
              <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                <Text size="sm" weight="semibold" truncate>
                  {user.name || user.email}
                </Text>
                <Text as="div" size="xs" tone="subtle" mono truncate>
                  {user.email}
                </Text>
              </div>
              <Badge tone="neutral" variant="outline" size="sm">
                {t("members.human")}
              </Badge>
              {isAdmin && user.id !== selfId ? (
                <>
                  <div style={{ width: 120 }}>
                    <Select
                      label={t("members.role")}
                      value={(user.role ?? "user") as "admin" | "user"}
                      onChange={(role) => void changeRole(user, role)}
                      options={[
                        { value: "user", label: t("members.roles.user") },
                        { value: "admin", label: t("members.roles.admin") },
                      ]}
                    />
                  </div>
                  <Button
                    iconOnly
                    label={t("members.remove")}
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmRemove(user)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </>
              ) : (
                <Text size="xs" tone="subtle" mono>
                  {user.role ?? "user"}
                  {user.id === selfId ? ` · ${t("members.you")}` : ""}
                </Text>
              )}
            </div>
          ))}

          {(agents.data ?? []).map((agent) => {
            const statusEntry = agentStatusConfig[agent.status];
            return (
              <div key={agent.id} style={rowStyle}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    flex: "none",
                    borderRadius: 9,
                    display: "grid",
                    placeItems: "center",
                    fontFamily: "var(--ny-font-mono)",
                    fontSize: 11,
                    fontWeight: 700,
                    background: "var(--ny-surface-raised)",
                    border: "1px solid var(--ny-accent-border)",
                    color: "var(--ny-accent-text)",
                  }}
                >
                  {initials(agent.handle)}
                </span>
                <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                  <Text size="sm" weight="semibold" truncate>
                    @{agent.handle}
                  </Text>
                  <Text as="div" size="xs" tone="subtle" mono truncate>
                    <span
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        marginRight: 6,
                        background: toneVar(statusEntry.tone),
                      }}
                    />
                    {agent.displayName} · {t(statusEntry.labelKey as TranslationKey)}
                  </Text>
                </div>
                <Badge tone="accent" variant="outline" size="sm">
                  {t("members.agent")}
                </Badge>
                {/* Agents hold no role: approving a dispatch is a human act, and
                    giving one a role here would suggest otherwise. */}
                <Text size="xs" tone="subtle" mono>
                  —
                </Text>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        size="sm"
        title={t("members.add")}
        description={t("members.addDescription")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void invite()}>
              {t("members.create")}
            </Button>
          </>
        }
      >
        {draft && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="bh-form-pair">
              <Field label={t("members.name")} required>
                <Input value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
              </Field>
              <Field label={t("members.username")}>
                <Input
                  value={draft.username}
                  onChange={(v) => setDraft({ ...draft, username: v })}
                />
              </Field>
            </div>
            <Field label={t("members.email")} required>
              <Input
                type="email"
                value={draft.email}
                onChange={(v) => setDraft({ ...draft, email: v })}
              />
            </Field>
            <Field label={t("members.password")} help={t("members.passwordHelp")} required>
              <Input
                type="password"
                value={draft.password}
                onChange={(v) => setDraft({ ...draft, password: v })}
              />
            </Field>
            <Field label={t("members.role")}>
              <Select
                label={t("members.role")}
                value={draft.role}
                onChange={(role) => setDraft({ ...draft, role })}
                options={[
                  { value: "user", label: t("members.roles.user") },
                  { value: "admin", label: t("members.roles.admin") },
                ]}
              />
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        size="sm"
        title={t("members.removeTitle")}
        description={
          confirmRemove
            ? t("members.removeBody", { name: confirmRemove.name || confirmRemove.email })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => confirmRemove && void remove(confirmRemove)}
            >
              {t("members.remove")}
            </Button>
          </>
        }
      />
    </div>
  );
}
