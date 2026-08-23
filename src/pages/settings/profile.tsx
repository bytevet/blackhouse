import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { LogOut } from "lucide-react";
import {
  Alert,
  Button,
  Field,
  Input,
  Panel,
  PanelHeading,
  Text,
  Toast,
  ToastViewport,
} from "@notyet.im/ui";
import { client, unwrap } from "@/lib/api";
import { signOut, useSession } from "@/lib/auth-client";

/**
 * The signed-in user's own account: display name, password, sign out.
 *
 * Kept separate from Members because the operations are different — this
 * screen calls `PUT /api/settings/profile`, which any member may use on
 * themselves, while Members is admin-only and acts on other people.
 */
export function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();

  const [name, setName] = useState(session?.user?.name ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      await unwrap(await client.api.settings.profile.$put({ json: body }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    setErrors({});
    if (!name.trim()) {
      setErrors({ name: t("profile.nameRequired") });
      return;
    }
    await save({ name: name.trim() });
  }

  async function savePassword() {
    const next: Record<string, string> = {};
    if (!currentPassword) next.currentPassword = t("profile.currentRequired");
    if (newPassword.length < 8) next.newPassword = t("profile.passwordTooShort");
    if (newPassword !== confirmPassword) next.confirmPassword = t("profile.passwordMismatch");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    await save({ currentPassword, newPassword });
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" }}>
          {t("profile.title")}
        </h1>
        <Text as="p" size="sm" tone="muted" style={{ marginTop: 4, lineHeight: 1.5 }}>
          {t("profile.description")}
        </Text>
      </div>

      {error && (
        <Alert tone="danger" title={t("profile.failed")} onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Panel
        header={<PanelHeading title={t("profile.identity")} subtitle={session?.user?.email} />}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field
            label={t("profile.displayName")}
            help={t("profile.displayNameHelp")}
            error={errors.name}
          >
            <Input value={name} onChange={setName} placeholder={t("profile.namePlaceholder")} />
          </Field>
          <div>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void saveName()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel
        header={
          <PanelHeading
            title={t("profile.changePassword")}
            subtitle={t("profile.changePasswordHelp")}
          />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={t("profile.currentPassword")} error={errors.currentPassword}>
            <Input
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
            />
          </Field>
          <div className="bh-form-pair">
            <Field label={t("profile.newPassword")} error={errors.newPassword}>
              <Input
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
              />
            </Field>
            <Field label={t("profile.confirmPassword")} error={errors.confirmPassword}>
              <Input
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void savePassword()}>
              {t("profile.updatePassword")}
            </Button>
          </div>
        </div>
      </Panel>

      <div>
        <Button
          variant="secondary"
          size="sm"
          iconStart={<LogOut size={14} />}
          onClick={() => {
            void signOut().then(() => navigate("/login", { replace: true }));
          }}
        >
          {t("nav.signOut")}
        </Button>
      </div>

      <ToastViewport>
        <Toast
          open={saved}
          onClose={() => setSaved(false)}
          tone="success"
          title={t("profile.updated")}
        />
      </ToastViewport>
    </div>
  );
}
