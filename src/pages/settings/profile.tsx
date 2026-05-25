import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { client } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Save } from "lucide-react";

const displayNameSchema = z.object({
  displayName: z
    .string()
    .min(1, "Display name is required")
    .transform((v) => v.trim()),
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(1, "New password is required"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export function ProfilePage() {
  const { t } = useTranslation();
  const { data: session } = useSession();

  const [nameData, setNameData] = useState({ displayName: session?.user?.name || "" });
  const [nameErrors, setNameErrors] = useState<Record<string, string>>({});
  const [nameSaving, setNameSaving] = useState(false);

  const [passwordData, setPasswordData] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [passwordSaving, setPasswordSaving] = useState(false);

  async function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameErrors({});
    const result = displayNameSchema.safeParse(nameData);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) {
        errs[issue.path[0] as string] = issue.message;
      }
      setNameErrors(errs);
      return;
    }
    setNameSaving(true);
    try {
      await client.api.settings.profile.$put({ json: { name: result.data.displayName } });
    } finally {
      setNameSaving(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordErrors({});
    const result = passwordSchema.safeParse(passwordData);
    if (!result.success) {
      const errs: Record<string, string> = {};
      for (const issue of result.error.issues) {
        errs[issue.path[0] as string] = issue.message;
      }
      setPasswordErrors(errs);
      return;
    }
    setPasswordSaving(true);
    try {
      await client.api.settings.profile.$put({
        json: {
          currentPassword: result.data.currentPassword,
          newPassword: result.data.newPassword,
        },
      });
      setPasswordData({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile.displayName")}</CardTitle>
          <CardDescription>{t("settings.profile.displayNameDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleNameSubmit}>
            <div className="flex gap-2">
              <Field data-invalid={!!nameErrors.displayName} className="flex-1">
                <Input
                  value={nameData.displayName}
                  onChange={(e) => setNameData({ displayName: e.target.value })}
                  aria-invalid={!!nameErrors.displayName}
                  placeholder={t("settings.profile.namePlaceholder")}
                />
                {nameErrors.displayName && (
                  <FieldError errors={[{ message: nameErrors.displayName }]} />
                )}
              </Field>
              <Button type="submit" disabled={nameSaving}>
                <Save className="size-3" />
                {nameSaving ? t("common.saving") : t("common.save")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile.changePassword")}</CardTitle>
          <CardDescription>{t("settings.profile.changePasswordDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit}>
            <FieldGroup>
              <Field data-invalid={!!passwordErrors.currentPassword}>
                <FieldLabel>{t("settings.profile.currentPassword")}</FieldLabel>
                <Input
                  type="password"
                  value={passwordData.currentPassword}
                  onChange={(e) =>
                    setPasswordData((prev) => ({ ...prev, currentPassword: e.target.value }))
                  }
                  aria-invalid={!!passwordErrors.currentPassword}
                />
                {passwordErrors.currentPassword && (
                  <FieldError errors={[{ message: passwordErrors.currentPassword }]} />
                )}
              </Field>

              <Field data-invalid={!!passwordErrors.newPassword}>
                <FieldLabel>{t("settings.profile.newPassword")}</FieldLabel>
                <Input
                  type="password"
                  value={passwordData.newPassword}
                  onChange={(e) =>
                    setPasswordData((prev) => ({ ...prev, newPassword: e.target.value }))
                  }
                  aria-invalid={!!passwordErrors.newPassword}
                />
                {passwordErrors.newPassword && (
                  <FieldError errors={[{ message: passwordErrors.newPassword }]} />
                )}
              </Field>

              <Field data-invalid={!!passwordErrors.confirmPassword}>
                <FieldLabel>{t("settings.profile.confirmPassword")}</FieldLabel>
                <Input
                  type="password"
                  value={passwordData.confirmPassword}
                  onChange={(e) =>
                    setPasswordData((prev) => ({ ...prev, confirmPassword: e.target.value }))
                  }
                  aria-invalid={!!passwordErrors.confirmPassword}
                />
                {passwordErrors.confirmPassword && (
                  <FieldError errors={[{ message: passwordErrors.confirmPassword }]} />
                )}
              </Field>

              <Button type="submit" disabled={passwordSaving} className="w-fit">
                {passwordSaving
                  ? t("settings.profile.updating")
                  : t("settings.profile.updatePassword")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
