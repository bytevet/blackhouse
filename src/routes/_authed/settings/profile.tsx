import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import { useSession } from "@/lib/auth-client";
import { updateProfile } from "@/server/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Save } from "lucide-react";

export const Route = createFileRoute("/_authed/settings/profile")({
  component: ProfileTab,
});

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

function ProfileTab() {
  const { data: session } = useSession();

  const nameForm = useForm({
    defaultValues: { displayName: session?.user?.name || "" },
    validators: { onSubmit: displayNameSchema },
    onSubmit: async ({ value }) => {
      await updateProfile({ data: { name: value.displayName } });
    },
  });

  const passwordForm = useForm({
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      await updateProfile({
        data: {
          currentPassword: value.currentPassword,
          newPassword: value.newPassword,
        },
      });
      passwordForm.reset();
    },
  });

  return (
    <div className="max-w-md space-y-6">
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Display Name</h2>
        <p className="text-xs text-muted-foreground">
          This is the name displayed across the platform.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            nameForm.handleSubmit();
          }}
        >
          <div className="flex gap-2">
            <nameForm.Field
              name="displayName"
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid} className="flex-1">
                    <Input
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={isInvalid}
                      placeholder="Your name"
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            />
            <Button type="submit" disabled={nameForm.state.isSubmitting}>
              <Save className="size-3" />
              {nameForm.state.isSubmitting ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Change Password</h2>
        <p className="text-xs text-muted-foreground">
          Update your password to keep your account secure.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            passwordForm.handleSubmit();
          }}
        >
          <FieldGroup>
            <passwordForm.Field
              name="currentPassword"
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel>Current Password</FieldLabel>
                    <Input
                      type="password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={isInvalid}
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            />

            <passwordForm.Field
              name="newPassword"
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel>New Password</FieldLabel>
                    <Input
                      type="password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={isInvalid}
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            />

            <passwordForm.Field
              name="confirmPassword"
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel>Confirm Password</FieldLabel>
                    <Input
                      type="password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={isInvalid}
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            />

            <Button type="submit" disabled={passwordForm.state.isSubmitting} className="w-fit">
              {passwordForm.state.isSubmitting ? "Updating..." : "Update Password"}
            </Button>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}
