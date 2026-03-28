import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import {
  listAgentConfigs,
  upsertAgentConfig,
  deleteAgentConfig,
  buildAgentImage,
  getAgentBuildStatus,
  getDefaultDockerfile,
} from "@/server/settings";
import { getServerSession } from "@/lib/auth-server";
import { Button } from "@/components/ui/button";
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
import { Plus, Trash2, Edit, Hammer, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { AGENT_PRESETS, PRESET_OPTIONS, type PresetId } from "@/lib/agent-presets";
import type { AgentConfig } from "@/db/schema";

export const Route = createFileRoute("/_authed/settings/agents")({
  beforeLoad: async () => {
    const session = await getServerSession();
    if (!session || session.user.role !== "admin") {
      throw redirect({ to: "/settings/profile" });
    }
  },
  loader: async () => {
    const agentConfigs = await listAgentConfigs();
    return { agentConfigs };
  },
  component: AgentsTab,
});

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
  const clickProps = onClick ? { onClick, className: "cursor-pointer" } : {};
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
        <span className="flex items-center gap-1.5" {...clickProps}>
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

function AgentsTab() {
  const { agentConfigs: initial } = Route.useLoaderData();
  const [configs, setConfigs] = useState(initial);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  const [saving, setSaving] = useState(false);

  // Build log dialog
  const [buildLogDialogOpen, setBuildLogDialogOpen] = useState(false);
  const [buildLogContent, setBuildLogContent] = useState("");
  const [buildLogTitle, setBuildLogTitle] = useState("");
  const [buildLogAgentId, setBuildLogAgentId] = useState<string | null>(null);

  // Form
  const [preset, setPreset] = useState<string>("claude-code");
  const [displayName, setDisplayName] = useState("");
  const [agentCommand, setAgentCommand] = useState("");
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [volumeMounts, setVolumeMounts] = useState<{ name: string; mountPath: string }[]>([]);
  const [dockerfileContent, setDockerfileContent] = useState("");

  useEffect(() => {
    setConfigs(initial);
  }, [initial]);

  // Poll for building agents
  useEffect(() => {
    const buildingConfigs = configs.filter((c: AgentConfig) => c.imageBuildStatus === "building");
    if (buildingConfigs.length === 0) return;

    const interval = setInterval(async () => {
      let hasChanges = false;
      const updatedConfigs = [...configs];

      for (const bc of buildingConfigs) {
        try {
          const status = await getAgentBuildStatus({ data: { agentConfigId: bc.id } });
          const idx = updatedConfigs.findIndex((c: AgentConfig) => c.id === bc.id);
          if (idx !== -1) {
            updatedConfigs[idx] = {
              ...updatedConfigs[idx],
              imageBuildStatus: status.imageBuildStatus,
              imageBuildLog: status.imageBuildLog,
              lastBuiltAt: status.lastBuiltAt,
            };
            // Auto-update the build log dialog if it's open for this agent
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
        // Refresh full list to ensure consistency
        const refreshed = await listAgentConfigs();
        setConfigs(refreshed);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [configs]);

  const refresh = async () => {
    const updated = await listAgentConfigs();
    setConfigs(updated);
  };

  const handlePresetChange = async (value: string) => {
    setPreset(value);
    const p = AGENT_PRESETS[value as PresetId];
    if (p) {
      setDisplayName(p.displayName);
      setAgentCommand(p.agentCommand);
      setVolumeMounts(p.volumeMounts.map((v) => ({ ...v })));
      try {
        const content = await getDefaultDockerfile({ data: { preset: value } });
        setDockerfileContent(content);
      } catch {
        /* ignore */
      }
    }
  };

  const openCreate = async () => {
    setEditing(null);
    setEnvVars([]);
    setDockerfileContent("Loading...");
    setDialogOpen(true);
    await handlePresetChange("claude-code");
  };

  const openEdit = (config: AgentConfig) => {
    setEditing(config);
    setPreset(config.preset || "custom");
    setDisplayName(config.displayName);
    setAgentCommand(config.agentCommand || "");
    setEnvVars(
      Array.isArray(config.envVars) ? (config.envVars as { key: string; value: string }[]) : [],
    );
    setVolumeMounts(
      Array.isArray(config.volumeMounts)
        ? (config.volumeMounts as { name: string; mountPath: string }[])
        : [],
    );
    setDockerfileContent(config.dockerfileContent || "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    try {
      await upsertAgentConfig({
        data: {
          id: editing?.id,
          preset,
          displayName: displayName.trim(),
          agentCommand: agentCommand.trim() || undefined,
          envVars: envVars.filter((e) => e.key.trim()),
          volumeMounts: volumeMounts.filter((v) => v.name.trim() && v.mountPath.trim()),
          dockerfileContent: dockerfileContent.trim() || null,
        },
      });
      setDialogOpen(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteAgentConfig({ data: { id } });
    await refresh();
  };

  const handleBuild = async (agentConfigId: string) => {
    const config = configs.find((c: AgentConfig) => c.id === agentConfigId);
    await buildAgentImage({ data: { agentConfigId } });
    // Immediately update local state to show building
    setConfigs((prev) =>
      prev.map((c: AgentConfig) =>
        c.id === agentConfigId ? { ...c, imageBuildStatus: "building", imageBuildLog: null } : c,
      ),
    );
    // Auto-open build log dialog
    setBuildLogTitle(`Build Log: ${config?.displayName || "Agent"}`);
    setBuildLogContent("Build started...");
    setBuildLogAgentId(agentConfigId);
    setBuildLogDialogOpen(true);
  };

  const handleResetDockerfile = async () => {
    try {
      const content = await getDefaultDockerfile({ data: { preset } });
      setDockerfileContent(content);
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

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Agent Configurations</h3>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3" />
          Add Agent
        </Button>
      </div>

      <div className="overflow-x-auto">
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
              configs.map((c: AgentConfig) => (
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
                      <Button variant="ghost" size="icon-sm" onClick={() => handleDelete(c.id)}>
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Agent Config" : "Add Agent Config"}</DialogTitle>
            <DialogDescription>Configure a coding agent for sessions.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Preset</Label>
              <Select value={preset} onValueChange={handlePresetChange}>
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
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-name">Display Name</Label>
              <Input
                id="ac-name"
                placeholder="Claude Code"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-command">Agent Command</Label>
              <Input
                id="ac-command"
                placeholder="e.g. claude --dangerously-skip-permissions"
                value={agentCommand}
                onChange={(e) => setAgentCommand(e.target.value)}
              />
            </div>
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
                    placeholder="name"
                    value={vm.name}
                    onChange={(e) => {
                      const n = [...volumeMounts];
                      n[i] = { ...n[i], name: e.target.value };
                      setVolumeMounts(n);
                    }}
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
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="ac-dockerfile">Dockerfile Content</Label>
                <Button variant="outline" size="sm" type="button" onClick={handleResetDockerfile}>
                  <FileText className="size-3" />
                  Reset to Default
                </Button>
              </div>
              <Textarea
                id="ac-dockerfile"
                placeholder="Leave empty to use default Dockerfile"
                value={dockerfileContent}
                onChange={(e) => setDockerfileContent(e.target.value)}
                className="font-mono text-xs max-h-64 overflow-auto"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSave} disabled={!displayName.trim() || saving}>
              {saving ? "Saving..." : editing ? "Update" : "Create"}
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
              configs.find((c: AgentConfig) => c.id === buildLogAgentId)?.imageBuildStatus ===
                "building"
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
