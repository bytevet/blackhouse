import { useState, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import { client, unwrap, type Paginated } from "@/lib/api";
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Plus, Edit, Trash2, ChevronLeft, ChevronRight, Info } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { Template } from "@/db/schema";

export function MyTemplatesPage() {
  const { data: session } = useSession();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const perPage = 12;
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    systemPrompt: "",
    isPublic: false,
    gitRequired: false,
  });
  const [volumeMounts, setVolumeMounts] = useState<{ name: string; mountPath: string }[]>([]);
  const initialFormRef = useRef(formData);
  const initialVolumesRef = useRef(volumeMounts);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [existingVolumes, setExistingVolumes] = useState<{ name: string }[]>([]);

  const fetchTemplates = async (p = page) => {
    const res = await client.api.templates.$get({
      query: { mine: "true", page: String(p), perPage: String(perPage) },
    });
    const result = await unwrap<Paginated<Template>>(res);
    setTemplates(result.data);
    setTotal(result.total);
  };

  useEffect(() => {
    fetchTemplates().finally(() => setLoading(false));
    client.api.templates.volumes
      .$get()
      .then((r) => unwrap<{ name: string }[]>(r))
      .then(setExistingVolumes)
      .catch(() => {});
  }, [page]);

  const refreshTemplates = () => fetchTemplates();

  const openCreate = () => {
    setEditingTemplate(null);
    const initial = {
      name: "",
      description: "",
      systemPrompt: "",
      isPublic: false,
      gitRequired: false,
    };
    setFormData(initial);
    initialFormRef.current = initial;
    const vols: { name: string; mountPath: string }[] = [];
    setVolumeMounts(vols);
    initialVolumesRef.current = vols;
    setDialogOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    const initial = {
      name: template.name,
      description: template.description || "",
      systemPrompt: template.systemPrompt || "",
      isPublic: template.isPublic ?? false,
      gitRequired: template.gitRequired ?? false,
    };
    setFormData(initial);
    initialFormRef.current = initial;
    const vols = Array.isArray(template.volumeMounts)
      ? (template.volumeMounts as { name: string; mountPath: string }[])
      : [];
    setVolumeMounts(vols.map((v) => ({ ...v })));
    initialVolumesRef.current = vols;
    setDialogOpen(true);
  };

  const isFormDirty = () => {
    const init = initialFormRef.current;
    const initVols = initialVolumesRef.current;
    return (
      formData.name !== init.name ||
      formData.description !== init.description ||
      formData.systemPrompt !== init.systemPrompt ||
      formData.isPublic !== init.isPublic ||
      formData.gitRequired !== init.gitRequired ||
      JSON.stringify(volumeMounts) !== JSON.stringify(initVols)
    );
  };

  const handleDialogClose = (open: boolean) => {
    if (!open && isFormDirty()) {
      setConfirmCloseOpen(true);
      return;
    }
    setDialogOpen(open);
  };

  const openDelete = (template: Template) => {
    setDeletingTemplate(template);
    setDeleteDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) return;
    setSaving(true);
    try {
      const filteredMounts = volumeMounts.filter((v) => v.name.trim() && v.mountPath.trim());
      const body = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        systemPrompt: formData.systemPrompt.trim(),
        volumeMounts: filteredMounts.length > 0 ? filteredMounts : null,
        isPublic: formData.isPublic,
        gitRequired: formData.gitRequired,
      };
      if (editingTemplate) {
        await client.api.templates[":id"].$put({
          param: { id: editingTemplate.id },
          json: body,
        });
      } else {
        await client.api.templates.$post({ json: body });
      }
      setDialogOpen(false);
      await refreshTemplates();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingTemplate) return;
    await client.api.templates[":id"].$delete({
      param: { id: deletingTemplate.id },
    });
    setDeleteDialogOpen(false);
    setDeletingTemplate(null);
    await refreshTemplates();
  };

  const isOwner = (template: Template) => template.userId === session?.user?.id;

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading templates...</div>;
  }

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
        <p className="py-4 text-sm text-muted-foreground">
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

      {Math.ceil(total / perPage) > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="size-3" /> Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {Math.ceil(total / perPage)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= Math.ceil(total / perPage)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleDialogClose}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Template" : "Create Template"}</DialogTitle>
            <DialogDescription>
              {editingTemplate ? "Update your template details." : "Create a new prompt template."}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto -mx-4 px-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  placeholder="Template name"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                />
              </Field>
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Textarea
                  placeholder="Brief description"
                  value={formData.description}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, description: e.target.value }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel>System Prompt</FieldLabel>
                <Textarea
                  placeholder="System prompt for the coding agent..."
                  className="resize-y"
                  value={formData.systemPrompt}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, systemPrompt: e.target.value }))
                  }
                />
              </Field>
              <Field>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.isPublic}
                    onCheckedChange={(v) => setFormData((prev) => ({ ...prev, isPublic: v }))}
                    size="sm"
                  />
                  <FieldLabel className="text-xs">Public template</FieldLabel>
                </div>
              </Field>
              <Field>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={formData.gitRequired}
                    onCheckedChange={(v) => setFormData((prev) => ({ ...prev, gitRequired: v }))}
                    size="sm"
                  />
                  <FieldLabel className="text-xs">Require Git repository</FieldLabel>
                </div>
              </Field>
            </FieldGroup>

            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <Label>Volume Mounts</Label>
                <Tooltip>
                  <TooltipTrigger>
                    <Info className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 text-xs">
                    All sessions using this template share the same volumes, including other users
                    of public templates.
                  </TooltipContent>
                </Tooltip>
              </div>
              {volumeMounts.map((vm, i) => {
                const isExisting = existingVolumes.some((v) => v.name === vm.name);
                const selectValue = isExisting ? vm.name : "__new__";
                return (
                  <div key={i} className="flex gap-2">
                    <Select
                      value={selectValue}
                      onValueChange={(v) => {
                        if (v === null) return;
                        const n = [...volumeMounts];
                        n[i] = { ...n[i], name: v === "__new__" ? "" : v };
                        setVolumeMounts(n);
                      }}
                      items={[
                        { label: "New volume...", value: "__new__" },
                        ...existingVolumes.map((v) => ({ label: v.name, value: v.name })),
                      ]}
                    >
                      <SelectTrigger className="w-36 shrink-0">
                        <SelectValue placeholder="Volume" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__new__">New volume...</SelectItem>
                        {existingVolumes.map((v) => (
                          <SelectItem key={v.name} value={v.name}>
                            {v.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectValue === "__new__" && (
                      <Input
                        placeholder="volume-name"
                        value={vm.name}
                        onChange={(e) => {
                          const n = [...volumeMounts];
                          n[i] = { ...n[i], name: e.target.value };
                          setVolumeMounts(n);
                        }}
                        pattern="^[a-zA-Z0-9][a-zA-Z0-9._-]*$"
                        className="flex-1"
                      />
                    )}
                    <Input
                      placeholder="/mount/path"
                      value={vm.mountPath}
                      onChange={(e) => {
                        const n = [...volumeMounts];
                        n[i] = { ...n[i], mountPath: e.target.value };
                        setVolumeMounts(n);
                      }}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      onClick={() => setVolumeMounts(volumeMounts.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setVolumeMounts([...volumeMounts, { name: "", mountPath: "" }])}
              >
                <Plus className="size-3" /> Add Volume
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSave} disabled={!formData.name.trim() || saving}>
              {saving ? "Saving..." : editingTemplate ? "Update Template" : "Create Template"}
            </Button>
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

      {/* Discard Changes Confirmation */}
      <Dialog open={confirmCloseOpen} onOpenChange={setConfirmCloseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to discard them?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCloseOpen(false)}>
              Keep Editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmCloseOpen(false);
                setDialogOpen(false);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
