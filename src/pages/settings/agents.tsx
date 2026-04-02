import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useSession } from "@/lib/auth-client";
import { client, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Plus, Trash2, Edit, Hammer, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { AGENT_PRESETS, PRESET_OPTIONS, type PresetId } from "@/lib/agent-presets";
import type { AgentConfig } from "@/db/schema";

function BuildLogView({ content }: { content: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content]);

  return (
    <div ref={scrollRef} className="max-h-96 overflow-auto rounded border bg-muted p-3">
      <pre className="whitespace-pre-wrap font-mono text-xs">{content}</pre>
    </div>
  );
}

function BuildStatusBadge({
  status,
  lastBuiltAt,
  onClick,
}: {
  status: string;
  lastBuiltAt?: Date | string | null;
  onClick?: () => void;
}) {
  const clickProps = onClick ? { onClick, role: "button" as const } : {};
  switch (status) {
    case "building":
      return (
        <Badge
          className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          {...clickProps}
        >
          Building...
        </Badge>
      );
    case "built":
      return (
        <span
          className={`flex items-center gap-2 ${onClick ? "cursor-pointer" : ""}`}
          {...clickProps}
        >
          <Badge className="border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400">
            Built
          </Badge>
          {lastBuiltAt && (
            <span className="text-xs text-muted-foreground">{timeAgo(lastBuiltAt)}</span>
          )}
        </span>
      );
    case "failed":
      return (
        <Badge
          className="border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
          {...clickProps}
        >
          Failed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" {...clickProps}>
          Not Built
        </Badge>
      );
  }
}

export function AgentsPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState<AgentConfig | null>(null);

  // Build log dialog
  const [buildLogDialogOpen, setBuildLogDialogOpen] = useState(false);
  const [buildLogContent, setBuildLogContent] = useState("");
  const [buildLogTitle, setBuildLogTitle] = useState("");
  const [buildLogAgentId, setBuildLogAgentId] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    preset: "claude-code",
    displayName: "",
    agentCommand: "",
    dockerfileContent: "",
  });
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [volumeMounts, setVolumeMounts] = useState<{ name: string; mountPath: string }[]>([]);

  useEffect(() => {
    if (!isAdmin && session) {
      navigate("/settings/profile", { replace: true });
      return;
    }
    client.api.settings["agent-configs"]
      .$get()
      .then((r) => unwrap<AgentConfig[]>(r))
      .then(setConfigs)
      .finally(() => setLoading(false));
  }, [isAdmin, session, navigate]);

  // Poll for building agents
  useEffect(() => {
    const buildingConfigs = configs.filter((c) => c.imageBuildStatus === "building");
    if (buildingConfigs.length === 0) return;

    const interval = setInterval(async () => {
      let hasChanges = false;
      const updatedConfigs = [...configs];

      for (const bc of buildingConfigs) {
        try {
          const status = await client.api.settings["agent-configs"][":id"]["build-status"]
            .$get({ param: { id: bc.id } })
            .then((r) =>
              unwrap<{
                imageBuildStatus: string;
                imageBuildLog: string | null;
                lastBuiltAt: string | null;
              }>(r),
            );
          const idx = updatedConfigs.findIndex((c) => c.id === bc.id);
          if (idx !== -1) {
            updatedConfigs[idx] = {
              ...updatedConfigs[idx],
              imageBuildStatus: status.imageBuildStatus,
              imageBuildLog: status.imageBuildLog,
              lastBuiltAt: status.lastBuiltAt ? new Date(status.lastBuiltAt) : null,
            };
            if (buildLogAgentId === bc.id && status.imageBuildLog) {
              setBuildLogContent(status.imageBuildLog);
            }
            if (status.imageBuildStatus !== "building") {
              hasChanges = true;
            }
          }
        } catch {
          // ignore polling errors
        }
      }

      setConfigs(updatedConfigs);
      if (hasChanges) {
        const res = await client.api.settings["agent-configs"].$get();
        setConfigs(await unwrap<AgentConfig[]>(res));
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [configs, buildLogAgentId]);

  const refresh = async () => {
    const res = await client.api.settings["agent-configs"].$get();
    setConfigs(await unwrap<AgentConfig[]>(res));
  };

  const handlePresetChange = async (value: string) => {
    setFormData((prev) => ({ ...prev, preset: value }));
    const p = AGENT_PRESETS[value as PresetId];
    if (p) {
      setFormData((prev) => ({
        ...prev,
        preset: value,
        displayName: p.displayName,
        agentCommand: p.agentCommand,
      }));
      setVolumeMounts(p.volumeMounts.map((v) => ({ ...v })));
      try {
        const res = await client.api.settings["default-dockerfile"].$get({
          query: { preset: value },
        });
        const content = await res.text();
        setFormData((prev) => ({ ...prev, dockerfileContent: content }));
      } catch {
        /* ignore */
      }
    }
  };

  const openCreate = async () => {
    setEditing(null);
    setEnvVars([]);
    setFormData({
      preset: "claude-code",
      displayName: "",
      agentCommand: "",
      dockerfileContent: "Loading...",
    });
    setDialogOpen(true);
    await handlePresetChange("claude-code");
  };

  const openEdit = (config: AgentConfig) => {
    setEditing(config);
    setFormData({
      preset: config.preset || "custom",
      displayName: config.displayName,
      agentCommand: config.agentCommand || "",
      dockerfileContent: config.dockerfileContent || "",
    });
    setEnvVars(
      Array.isArray(config.envVars) ? (config.envVars as { key: string; value: string }[]) : [],
    );
    setVolumeMounts(
      Array.isArray(config.volumeMounts)
        ? (config.volumeMounts as { name: string; mountPath: string }[])
        : [],
    );
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.displayName.trim()) return;
    setSaving(true);
    try {
      const body = {
        preset: formData.preset,
        displayName: formData.displayName.trim(),
        agentCommand: formData.agentCommand.trim() || undefined,
        envVars: envVars.filter((e) => e.key.trim()),
        volumeMounts: volumeMounts.filter((v) => v.name.trim() && v.mountPath.trim()),
        dockerfileContent: formData.dockerfileContent.trim() || null,
      };
      if (editing) {
        await client.api.settings["agent-configs"][":id"].$put({
          param: { id: editing.id },
          json: body,
        });
      } else {
        await client.api.settings["agent-configs"].$post({ json: body });
      }
      setDialogOpen(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await client.api.settings["agent-configs"][":id"].$delete({ param: { id } });
    await refresh();
  };

  const handleBuild = async (agentConfigId: string) => {
    const config = configs.find((c) => c.id === agentConfigId);
    await client.api.settings["agent-configs"][":id"].build.$post({ param: { id: agentConfigId } });
    setConfigs((prev) =>
      prev.map((c) =>
        c.id === agentConfigId ? { ...c, imageBuildStatus: "building", imageBuildLog: null } : c,
      ),
    );
    setBuildLogTitle(`Build Log: ${config?.displayName || "Agent"}`);
    setBuildLogContent("Build started...");
    setBuildLogAgentId(agentConfigId);
    setBuildLogDialogOpen(true);
  };

  const handleResetDockerfile = async () => {
    try {
      const res = await client.api.settings["default-dockerfile"].$get({
        query: { preset: formData.preset },
      });
      const content = await res.text();
      setFormData((prev) => ({ ...prev, dockerfileContent: content }));
    } catch {
      /* ignore */
    }
  };

  const openBuildLog = (config: AgentConfig) => {
    setBuildLogTitle(`Build Log: ${config.displayName}`);
    setBuildLogContent(config.imageBuildLog || "No build log available.");
    setBuildLogAgentId(config.id);
    setBuildLogDialogOpen(true);
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading agent configurations...</div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Coding Agents
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3" />
              Add Agent
            </Button>
          </CardTitle>
          <CardDescription>
            Configure coding agents with custom commands, Dockerfiles, and environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Display Name</TableHead>
                <TableHead>Preset</TableHead>
                <TableHead>Build Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No agent configurations yet.
                  </TableCell>
                </TableRow>
              ) : (
                configs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.displayName}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{c.preset}</Badge>
                    </TableCell>
                    <TableCell>
                      <BuildStatusBadge
                        status={c.imageBuildStatus}
                        lastBuiltAt={c.lastBuiltAt}
                        onClick={c.imageBuildStatus !== "none" ? () => openBuildLog(c) : undefined}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleBuild(c.id)}
                          disabled={c.imageBuildStatus === "building"}
                          title={c.imageBuildStatus === "built" ? "Rebuild" : "Build"}
                        >
                          <Hammer className="size-3" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(c)}>
                          <Edit className="size-3" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setDeletingAgent(c)}>
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Agent Config" : "Add Agent Config"}</DialogTitle>
            <DialogDescription>Configure a coding agent for sessions.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>Preset</FieldLabel>
              <Select
                value={formData.preset}
                onValueChange={(v) => v !== null && handlePresetChange(v)}
                items={PRESET_OPTIONS.map((p) => ({ label: p.displayName, value: p.id }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_OPTIONS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Display Name</FieldLabel>
              <Input
                placeholder="Claude Code"
                value={formData.displayName}
                onChange={(e) => setFormData((prev) => ({ ...prev, displayName: e.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel>Agent Command</FieldLabel>
              <Input
                placeholder="e.g. claude --dangerously-skip-permissions"
                value={formData.agentCommand}
                onChange={(e) => setFormData((prev) => ({ ...prev, agentCommand: e.target.value }))}
              />
            </Field>
            <div className="space-y-2">
              <Label>Environment Variables</Label>
              {envVars.map((ev, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="KEY"
                    value={ev.key}
                    onChange={(e) => {
                      const n = [...envVars];
                      n[i] = { ...n[i], key: e.target.value };
                      setEnvVars(n);
                    }}
                    className="flex-1"
                  />
                  <Input
                    placeholder="value"
                    value={ev.value}
                    onChange={(e) => {
                      const n = [...envVars];
                      n[i] = { ...n[i], value: e.target.value };
                      setEnvVars(n);
                    }}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
              >
                <Plus className="size-3" /> Add Variable
              </Button>
            </div>
            <div className="space-y-2">
              <Label>Volume Mounts</Label>
              {volumeMounts.map((vm, i) => (
                <div key={i} className="flex gap-2">
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
                  <Input
                    placeholder="mountPath"
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
                    onClick={() => setVolumeMounts(volumeMounts.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVolumeMounts([...volumeMounts, { name: "", mountPath: "" }])}
              >
                <Plus className="size-3" /> Add Mount
              </Button>
            </div>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel>Dockerfile Content</FieldLabel>
                <Button variant="outline" size="sm" type="button" onClick={handleResetDockerfile}>
                  <FileText className="size-3" />
                  Reset to Default
                </Button>
              </div>
              <Textarea
                placeholder="Leave empty to use default Dockerfile"
                value={formData.dockerfileContent}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, dockerfileContent: e.target.value }))
                }
                className="max-h-64 overflow-auto font-mono text-xs"
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button onClick={handleSave} disabled={!formData.displayName.trim() || saving}>
              {saving ? "Saving..." : editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingAgent} onOpenChange={(open) => !open && setDeletingAgent(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete agent &apos;{deletingAgent?.displayName}&apos;? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingAgent(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!deletingAgent) return;
                await handleDelete(deletingAgent.id);
                setDeletingAgent(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Build Log Dialog */}
      <Dialog
        open={buildLogDialogOpen}
        onOpenChange={(open) => {
          setBuildLogDialogOpen(open);
          if (!open) setBuildLogAgentId(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{buildLogTitle}</DialogTitle>
            <DialogDescription>
              {buildLogAgentId &&
              configs.find((c) => c.id === buildLogAgentId)?.imageBuildStatus === "building"
                ? "Build in progress — logs update automatically."
                : "Docker image build output."}
            </DialogDescription>
          </DialogHeader>
          <BuildLogView content={buildLogContent} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuildLogDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
