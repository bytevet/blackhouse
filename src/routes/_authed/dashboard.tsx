import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import {
  listSessions,
  createSession,
  stopSession,
  destroySession,
  restartSession,
} from "@/server/sessions";
import { listTemplates } from "@/server/templates";
import { listAgentConfigs } from "@/server/settings";
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
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Plus,
  Eye,
  Square,
  Trash2,
  RotateCcw,
  GitBranch,
  Bot,
  FileText,
} from "lucide-react";

export const Route = createFileRoute("/_authed/dashboard")({
  loader: async () => {
    const [sessions, templates, agentConfigs] = await Promise.all([
      listSessions(),
      listTemplates({ mine: false }),
      listAgentConfigs(),
    ]);
    return { sessions, templates, agentConfigs };
  },
  component: DashboardPage,
});

function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type StatusType = "running" | "stopped" | "pending" | "destroyed";

const statusConfig: Record<
  StatusType,
  { className: string; label: string }
> = {
  running: {
    className: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
    label: "Running",
  },
  stopped: {
    className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
    label: "Stopped",
  },
  pending: {
    className: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    label: "Pending",
  },
  destroyed: {
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    label: "Destroyed",
  },
};

function DashboardPage() {
  const { sessions: initialSessions, templates, agentConfigs } =
    Route.useLoaderData();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const [sessions, setSessions] = useState(initialSessions);
  const [showAll, setShowAll] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [agentConfigId, setAgentConfigId] = useState<string>("");
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [templateId, setTemplateId] = useState<string>("");

  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  const refreshSessions = async () => {
    const updated = await listSessions();
    setSessions(updated);
  };

  const handleCreate = async () => {
    if (!name.trim() || !agentConfigId) return;
    setCreating(true);
    try {
      await createSession({
        name: name.trim(),
        agentConfigId,
        gitRepoUrl: gitRepoUrl.trim() || undefined,
        gitBranch: gitBranch.trim() || undefined,
        templateId: templateId || undefined,
      });
      setDialogOpen(false);
      setName("");
      setAgentConfigId("");
      setGitRepoUrl("");
      setGitBranch("main");
      setTemplateId("");
      await refreshSessions();
    } finally {
      setCreating(false);
    }
  };

  const handleStop = async (id: string) => {
    await stopSession({ id });
    await refreshSessions();
  };

  const handleDestroy = async (id: string) => {
    await destroySession({ id });
    await refreshSessions();
  };

  const handleRestart = async (id: string) => {
    await restartSession({ id });
    await refreshSessions();
  };

  const filteredSessions =
    isAdmin && showAll
      ? sessions
      : sessions.filter(
          (s: any) => s.userId === session?.user?.id
        );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-3.5" />
                New Session
              </Button>
            }
          />
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Session</DialogTitle>
              <DialogDescription>
                Start a new coding agent session.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="session-name">Name</Label>
                <Input
                  id="session-name"
                  placeholder="My session"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Coding Agent</Label>
                <Select
                  value={agentConfigId}
                  onValueChange={setAgentConfigId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentConfigs.map((ac: any) => (
                      <SelectItem key={ac.id} value={ac.id}>
                        {ac.displayName || ac.agentType}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="git-repo">Git Repo URL</Label>
                <Input
                  id="git-repo"
                  placeholder="https://github.com/user/repo"
                  value={gitRepoUrl}
                  onChange={(e) => setGitRepoUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="git-branch">Git Branch</Label>
                <Input
                  id="git-branch"
                  placeholder="main"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Template</Label>
                <Select
                  value={templateId}
                  onValueChange={setTemplateId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t: any) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleCreate}
                disabled={!name.trim() || !agentConfigId || creating}
              >
                {creating ? "Creating..." : "Create Session"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isAdmin && (
        <div className="flex items-center gap-2">
          <Switch
            checked={showAll}
            onCheckedChange={setShowAll}
            size="sm"
          />
          <Label className="text-xs text-muted-foreground">
            {showAll ? "Show all sessions" : "My sessions"}
          </Label>
        </div>
      )}

      {filteredSessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sessions yet. Create one to get started.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSessions.map((s: any) => {
            const status = (s.status as StatusType) || "pending";
            const config = statusConfig[status] || statusConfig.pending;
            return (
              <Card key={s.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.name}</span>
                    <Badge
                      variant="outline"
                      className={config.className}
                    >
                      {config.label}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="flex items-center gap-1">
                    <Bot className="size-3" />
                    {s.agentType || s.agentConfigId || "Unknown"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1">
                  {s.gitRepoUrl && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
                      <GitBranch className="size-3 shrink-0" />
                      <span className="truncate">{s.gitRepoUrl}</span>
                    </div>
                  )}
                  {s.templateName && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FileText className="size-3 shrink-0" />
                      {s.templateName}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Created {timeAgo(s.createdAt)}
                  </div>
                </CardContent>
                <CardFooter className="gap-1.5">
                  <Button variant="outline" size="sm" render={<Link to={`/sessions/${s.id}`} />}>
                    <Eye className="size-3" />
                    View
                  </Button>
                  {status === "running" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleStop(s.id)}
                    >
                      <Square className="size-3" />
                      Stop
                    </Button>
                  )}
                  {(status === "stopped" || status === "pending") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRestart(s.id)}
                    >
                      <RotateCcw className="size-3" />
                      Restart
                    </Button>
                  )}
                  {status !== "destroyed" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDestroy(s.id)}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
