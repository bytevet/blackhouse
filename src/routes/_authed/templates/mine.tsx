import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Plus, Edit, Trash2 } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { Template } from "@/db/schema";

export const Route = createFileRoute("/_authed/templates/mine")({
  loader: () => listTemplates({ data: { mine: true } }),
  component: MyTemplatesPage,
});

function MyTemplatesPage() {
  const initialTemplates = Route.useLoaderData();
  const { data: session } = useSession();

  const [templates, setTemplates] = useState(initialTemplates);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [gitRequired, setGitRequired] = useState(false);

  useEffect(() => {
    setTemplates(initialTemplates);
  }, [initialTemplates]);

  const refreshTemplates = async () => {
    const mine = await listTemplates({ data: { mine: true } });
    setTemplates(mine);
  };

  const openCreate = () => {
    setEditingTemplate(null);
    setName("");
    setDescription("");
    setSystemPrompt("");
    setIsPublic(false);
    setGitRequired(false);
    setDialogOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    setName(template.name);
    setDescription(template.description || "");
    setSystemPrompt(template.systemPrompt || "");
    setIsPublic(template.isPublic ?? false);
    setGitRequired(template.gitRequired ?? false);
    setDialogOpen(true);
  };

  const openDelete = (template: Template) => {
    setDeletingTemplate(template);
    setDeleteDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editingTemplate) {
        await updateTemplate({
          data: {
            id: editingTemplate.id,
            name: name.trim(),
            description: description.trim(),
            systemPrompt: systemPrompt.trim(),
            isPublic,
            gitRequired,
          },
        });
      } else {
        await createTemplate({
          data: {
            name: name.trim(),
            description: description.trim(),
            systemPrompt: systemPrompt.trim(),
            isPublic,
            gitRequired,
          },
        });
      }
      setDialogOpen(false);
      await refreshTemplates();
    } finally {
      setSaving(false);
    }
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
      <div className="flex items-center justify-end">
        <Button onClick={openCreate}>
          <Plus className="size-3.5" />
          New Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">You haven't created any templates yet.</p>
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
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="Template name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-desc">Description</Label>
              <Textarea
                id="tpl-desc"
                placeholder="Brief description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tpl-prompt">System Prompt</Label>
              <Textarea
                id="tpl-prompt"
                placeholder="System prompt for the coding agent..."
                className="min-h-32"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isPublic} onCheckedChange={setIsPublic} size="sm" />
              <Label className="text-xs">Public template</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="git-required"
                checked={gitRequired}
                onCheckedChange={setGitRequired}
                size="sm"
              />
              <Label htmlFor="git-required" className="text-xs">
                Require Git repository
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSave} disabled={!name.trim() || saving}>
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
    </>
  );
}
