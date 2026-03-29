import { useState } from "react";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      await api.put("/settings/profile", { name: result.data.displayName });
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
      await api.put("/settings/profile", {
        currentPassword: result.data.currentPassword,
        newPassword: result.data.newPassword,
      });
      setPasswordData({ currentPassword: "", newPassword: "", confirmPassword: "" });
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Display Name</h2>
        <p className="text-xs text-muted-foreground">
          This is the name displayed across the platform.
        </p>
        <form onSubmit={handleNameSubmit}>
          <div className="flex gap-2">
            <Field data-invalid={!!nameErrors.displayName} className="flex-1">
              <Input
                value={nameData.displayName}
                onChange={(e) => setNameData({ displayName: e.target.value })}
                aria-invalid={!!nameErrors.displayName}
                placeholder="Your name"
              />
              {nameErrors.displayName && (
                <FieldError errors={[{ message: nameErrors.displayName }]} />
              )}
            </Field>
            <Button type="submit" disabled={nameSaving}>
              <Save className="size-3" />
              {nameSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Change Password</h2>
        <p className="text-xs text-muted-foreground">
          Update your password to keep your account secure.
        </p>
        <form onSubmit={handlePasswordSubmit}>
          <FieldGroup>
            <Field data-invalid={!!passwordErrors.currentPassword}>
              <FieldLabel>Current Password</FieldLabel>
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
              <FieldLabel>New Password</FieldLabel>
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
              <FieldLabel>Confirm Password</FieldLabel>
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
              {passwordSaving ? "Updating..." : "Update Password"}
            </Button>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}
