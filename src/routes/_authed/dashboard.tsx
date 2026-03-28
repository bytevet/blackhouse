import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
import { Plus, Eye, Square, Trash2, RotateCcw, GitBranch, Bot, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { CodingSession, Template, AgentConfig, SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export const Route = createFileRoute("/_authed/dashboard")({
  loader: async () => {
    const [sessions, templates, agentConfigs] = await Promise.all([
      listSessions(),
      listTemplates({ data: { mine: false } }),
      listAgentConfigs(),
    ]);
    return { sessions, templates, agentConfigs };
  },
  component: DashboardPage,
});

function DashboardPage() {
  const { sessions: initialSessions, templates, agentConfigs } = Route.useLoaderData();
  const { data: session } = useSession();
  const navigate = useNavigate();
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
      const newSession = await createSession({
        data: {
          name: name.trim(),
          agentConfigId,
          gitRepoUrl: gitRepoUrl.trim() || undefined,
          gitBranch: gitBranch.trim() || undefined,
          templateId: templateId || undefined,
        },
      });
      setDialogOpen(false);
      setName("");
      setAgentConfigId("");
      setGitRepoUrl("");
      setGitBranch("main");
      setTemplateId("");
      if (newSession?.id) {
        navigate({ to: "/sessions/$sessionId", params: { sessionId: newSession.id } });
      } else {
        await refreshSessions();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSessionAction = async (
    id: string,
    action: typeof stopSession | typeof destroySession | typeof restartSession,
  ) => {
    await action({ data: { id } });
    await refreshSessions();
  };

  const filteredSessions =
    isAdmin && showAll
      ? sessions
      : sessions.filter((s: CodingSession) => s.userId === session?.user?.id);

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
              <DialogDescription>Start a new coding agent session.</DialogDescription>
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
                <Select value={agentConfigId} onValueChange={setAgentConfigId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentConfigs.map((ac: AgentConfig) => (
                      <SelectItem
                        key={ac.id}
                        value={ac.id}
                        disabled={ac.imageBuildStatus !== "built"}
                      >
                        <span className="flex items-center gap-1.5">
                          {ac.displayName}
                          <Badge variant="outline" className="text-[10px] px-1 py-0">
                            {ac.preset}
                          </Badge>
                        </span>
                        {ac.imageBuildStatus !== "built" && (
                          <span className="ml-1 text-muted-foreground">(not built)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="git-repo">
                  Git Repo URL{" "}
                  {templates.find((t: Template) => t.id === templateId)?.gitRequired && (
                    <span className="text-destructive">*</span>
                  )}
                </Label>
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
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((t: Template) => (
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
                disabled={
                  !name.trim() ||
                  !agentConfigId ||
                  creating ||
                  (!!templates.find((t: Template) => t.id === templateId)?.gitRequired &&
                    !gitRepoUrl.trim())
                }
              >
                {creating ? "Creating..." : "Create Session"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isAdmin && (
        <div className="flex items-center gap-2">
          <Switch checked={showAll} onCheckedChange={setShowAll} size="sm" />
          <Label className="text-xs text-muted-foreground">
            {showAll ? "Show all sessions" : "My sessions"}
          </Label>
        </div>
      )}

      {filteredSessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet. Create one to get started.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSessions.map((s: CodingSession) => {
            const status = (s.status as SessionStatus) || "pending";
            const config = sessionStatusConfig[status] || sessionStatusConfig.pending;
            return (
              <Card key={s.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.name}</span>
                    <Badge variant="outline" className={config.className}>
                      {config.label}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="flex items-center gap-1">
                    <Bot className="size-3" />
                    {s.preset || s.agentConfigId || "Unknown"}
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
                      onClick={() => handleSessionAction(s.id, stopSession)}
                    >
                      <Square className="size-3" />
                      Stop
                    </Button>
                  )}
                  {(status === "stopped" || status === "pending") && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSessionAction(s.id, restartSession)}
                    >
                      <RotateCcw className="size-3" />
                      Restart
                    </Button>
                  )}
                  {status !== "destroyed" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleSessionAction(s.id, destroySession)}
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
