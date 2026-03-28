import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
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
import { Plus, Trash2, Edit, Hammer, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
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

  // Form
  const [agentType, setAgentType] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dockerfileContent, setDockerfileContent] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [extraArgs, setExtraArgs] = useState("");

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

  const openCreate = () => {
    setEditing(null);
    setAgentType("");
    setDisplayName("");
    setApiKey("");
    setDockerfileContent("");
    setDefaultModel("");
    setExtraArgs("");
    setDialogOpen(true);
  };

  const openEdit = (config: AgentConfig) => {
    setEditing(config);
    setAgentType(config.agentType || "");
    setDisplayName(config.displayName || "");
    setApiKey("");
    setDockerfileContent(config.dockerfileContent || "");
    setDefaultModel(config.defaultModel || "");
    setExtraArgs(config.extraArgs ? JSON.stringify(config.extraArgs, null, 2) : "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!agentType.trim() || !displayName.trim()) return;
    setSaving(true);
    try {
      let parsedExtraArgs: Record<string, unknown> | undefined = undefined;
      if (extraArgs.trim()) {
        try {
          parsedExtraArgs = JSON.parse(extraArgs.trim());
        } catch {
          return;
        }
      }
      await upsertAgentConfig({
        data: {
          id: editing?.id,
          agentType: agentType.trim(),
          displayName: displayName.trim(),
          apiKey: apiKey.trim() || undefined,
          dockerfileContent: dockerfileContent.trim() || null,
          defaultModel: defaultModel.trim() || undefined,
          extraArgs: parsedExtraArgs,
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
    await buildAgentImage({ data: { agentConfigId } });
    // Immediately update local state to show building
    setConfigs((prev) =>
      prev.map((c: AgentConfig) =>
        c.id === agentConfigId ? { ...c, imageBuildStatus: "building", imageBuildLog: null } : c,
      ),
    );
  };

  const handleLoadDefault = async () => {
    const content = await getDefaultDockerfile();
    setDockerfileContent(content);
  };

  const openBuildLog = (config: AgentConfig) => {
    setBuildLogTitle(`Build Log: ${config.displayName || config.agentType}`);
    setBuildLogContent(config.imageBuildLog || "No build log available.");
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
              <TableHead>Agent Type</TableHead>
              <TableHead>Display Name</TableHead>
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
                  <TableCell>{c.agentType}</TableCell>
                  <TableCell>{c.displayName}</TableCell>
                  <TableCell>
                    <BuildStatusBadge
                      status={c.imageBuildStatus}
                      lastBuiltAt={c.lastBuiltAt}
                      onClick={
                        c.imageBuildStatus === "built" || c.imageBuildStatus === "failed"
                          ? () => openBuildLog(c)
                          : undefined
                      }
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
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Agent Config" : "Add Agent Config"}</DialogTitle>
            <DialogDescription>Configure a coding agent for sessions.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ac-type">Agent Type</Label>
              <Input
                id="ac-type"
                placeholder="e.g. claude-code"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
              />
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
              <Label htmlFor="ac-key">API Key</Label>
              <Input
                id="ac-key"
                type="password"
                placeholder={editing ? "(unchanged)" : "sk-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-model">Default Model</Label>
              <Input
                id="ac-model"
                placeholder="claude-sonnet-4-20250514"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="ac-dockerfile">Dockerfile Content</Label>
                <Button variant="outline" size="sm" type="button" onClick={handleLoadDefault}>
                  <FileText className="size-3" />
                  Load Default
                </Button>
              </div>
              <Textarea
                id="ac-dockerfile"
                placeholder="Leave empty to use default Dockerfile"
                value={dockerfileContent}
                onChange={(e) => setDockerfileContent(e.target.value)}
                className="font-mono text-xs min-h-64"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ac-extra">Extra Args (JSON)</Label>
              <Textarea
                id="ac-extra"
                placeholder='{"key": "value"}'
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={handleSave}
              disabled={!agentType.trim() || !displayName.trim() || saving}
            >
              {saving ? "Saving..." : editing ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Build Log Dialog */}
      <Dialog open={buildLogDialogOpen} onOpenChange={setBuildLogDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{buildLogTitle}</DialogTitle>
            <DialogDescription>Docker image build output.</DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto rounded border bg-muted p-3">
            <pre className="whitespace-pre-wrap font-mono text-xs">{buildLogContent}</pre>
          </div>
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
