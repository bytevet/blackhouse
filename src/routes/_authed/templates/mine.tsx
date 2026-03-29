import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useForm } from "@tanstack/react-form";
import { useSession } from "@/lib/auth-client";
import { listTemplates, createTemplate, updateTemplate, deleteTemplate } from "@/server/templates";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldLabel, FieldError, FieldGroup } from "@/components/ui/field";
import { toFieldErrors } from "@/lib/form-errors";
import { Plus, Edit, Trash2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { Template } from "@/db/schema";

export const Route = createFileRoute("/_authed/templates/mine")({
  loader: () => listTemplates({ data: { mine: true } }),
  component: MyTemplatesPage,
});

function MyTemplatesPage() {
  const initialTemplates = Route.useLoaderData() as Template[];
  const { data: session } = useSession();

  const [templates, setTemplates] = useState(initialTemplates);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
      systemPrompt: "",
      isPublic: false,
      gitRequired: false,
    },
    onSubmit: async ({ value }) => {
      if (!value.name.trim()) return;
      setSaving(true);
      try {
        if (editingTemplate) {
          await updateTemplate({
            data: {
              id: editingTemplate.id,
              name: value.name.trim(),
              description: value.description.trim(),
              systemPrompt: value.systemPrompt.trim(),
              isPublic: value.isPublic,
              gitRequired: value.gitRequired,
            },
          });
        } else {
          await createTemplate({
            data: {
              name: value.name.trim(),
              description: value.description.trim(),
              systemPrompt: value.systemPrompt.trim(),
              isPublic: value.isPublic,
              gitRequired: value.gitRequired,
            },
          });
        }
        setDialogOpen(false);
        await refreshTemplates();
      } finally {
        setSaving(false);
      }
    },
  });

  useEffect(() => {
    setTemplates(initialTemplates);
  }, [initialTemplates]);

  const refreshTemplates = async () => {
    const mine = await listTemplates({ data: { mine: true } });
    setTemplates(mine as Template[]);
  };

  const openCreate = () => {
    setEditingTemplate(null);
    form.reset();
    setDialogOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    form.reset();
    form.setFieldValue("name", template.name);
    form.setFieldValue("description", template.description || "");
    form.setFieldValue("systemPrompt", template.systemPrompt || "");
    form.setFieldValue("isPublic", template.isPublic ?? false);
    form.setFieldValue("gitRequired", template.gitRequired ?? false);
    setDialogOpen(true);
  };

  const openDelete = (template: Template) => {
    setDeletingTemplate(template);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingTemplate) return;
    await deleteTemplate({ data: { id: deletingTemplate.id } });
    setDeleteDialogOpen(false);
    setDeletingTemplate(null);
    await refreshTemplates();
  };

  const isOwner = (template: Template) => template.userId === session?.user?.id;

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Create reusable prompt templates for your coding agent sessions.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          New Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No templates yet. Create one to get started.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <span className="truncate">{template.name}</span>
                  <span className="flex shrink-0 gap-1">
                    {template.gitRequired && <Badge className="shrink-0">Git Required</Badge>}
                    <Badge variant="outline" className="shrink-0">
                      {template.isPublic ? "Public" : "Private"}
                    </Badge>
                  </span>
                </CardTitle>
                {template.description && (
                  <CardDescription className="line-clamp-2">{template.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <div className="text-xs text-muted-foreground">
                  Created {timeAgo(template.createdAt)}
                </div>
              </CardContent>
              {isOwner(template) && (
                <CardFooter className="gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => openEdit(template)}>
                    <Edit className="size-3" />
                    Edit
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => openDelete(template)}>
                    <Trash2 className="size-3" />
                    Delete
                  </Button>
                </CardFooter>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Template" : "Create Template"}</DialogTitle>
            <DialogDescription>
              {editingTemplate ? "Update your template details." : "Create a new prompt template."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <form.Field
              name="name"
              validators={{
                onBlur: ({ value }) => (!value.trim() ? "Name is required" : undefined),
              }}
              children={(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid || undefined}>
                    <FieldLabel>Name</FieldLabel>
                    <Input
                      placeholder="Template name"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                    {isInvalid && <FieldError errors={toFieldErrors(field.state.meta.errors)} />}
                  </Field>
                );
              }}
            />
            <form.Field
              name="description"
              children={(field) => (
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea
                    placeholder="Brief description"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              )}
            />
            <form.Field
              name="systemPrompt"
              children={(field) => (
                <Field>
                  <FieldLabel>System Prompt</FieldLabel>
                  <Textarea
                    placeholder="System prompt for the coding agent..."
                    className="min-h-32"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </Field>
              )}
            />
            <form.Field
              name="isPublic"
              children={(field) => (
                <Field>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={field.state.value}
                      onCheckedChange={field.handleChange}
                      size="sm"
                    />
                    <FieldLabel className="text-xs">Public template</FieldLabel>
                  </div>
                </Field>
              )}
            />
            <form.Field
              name="gitRequired"
              children={(field) => (
                <Field>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={field.state.value}
                      onCheckedChange={field.handleChange}
                      size="sm"
                    />
                    <FieldLabel className="text-xs">Require Git repository</FieldLabel>
                  </div>
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
              children={([canSubmit, isSubmitting]) => (
                <Button
                  onClick={() => form.handleSubmit()}
                  disabled={!canSubmit || isSubmitting || saving}
                >
                  {saving ? "Saving..." : editingTemplate ? "Update Template" : "Create Template"}
                </Button>
              )}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Template</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingTemplate?.name}"? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
