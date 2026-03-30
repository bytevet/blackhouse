import { Link, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { client, unwrap } from "@/lib/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
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
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field";
import { Plus, Eye, Square, Trash2, RotateCcw, GitBranch, Bot } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { CodingSession, Template, AgentConfig, SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export function DashboardPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [sessions, setSessions] = useState<CodingSession[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "stop" | "destroy";
    sessionId: string;
    sessionName: string;
  } | null>(null);

  const [formData, setFormData] = useState({
    name: "",
    agentConfigId: "",
    gitRepoUrl: "",
    gitBranch: "main",
    templateId: "",
  });

  useEffect(() => {
    const load = async () => {
      try {
        const [sessionsData, myTemplates, publicTemplates, configs] = await Promise.all([
          client.api.sessions.$get().then((r) => unwrap<CodingSession[]>(r)),
          client.api.templates.$get({ query: { mine: "true" } }).then((r) => unwrap<Template[]>(r)),
          client.api.templates
            .$get({ query: { mine: "false" } })
            .then((r) => unwrap<Template[]>(r)),
          client.api.settings["agent-configs"].$get().then((r) => unwrap<AgentConfig[]>(r)),
        ]);
        setSessions(sessionsData);
        setAgentConfigs(configs);
        const seen = new Set<string>();
        const merged = [...myTemplates, ...publicTemplates].filter((t) => {
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
        setTemplates(merged);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const refreshSessions = async () => {
    const res = await client.api.sessions.$get();
    setSessions(await unwrap<CodingSession[]>(res));
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.agentConfigId) return;
    const selectedTemplate = templates.find((t) => t.id === formData.templateId);
    if (selectedTemplate?.gitRequired && !formData.gitRepoUrl.trim()) return;
    setCreating(true);
    try {
      const newSession = await client.api.sessions
        .$post({
          json: {
            name: formData.name.trim(),
            agentConfigId: formData.agentConfigId,
            gitRepoUrl: formData.gitRepoUrl.trim() || undefined,
            gitBranch: formData.gitBranch.trim() || undefined,
            templateId: formData.templateId || undefined,
          },
        })
        .then((r) => unwrap<CodingSession>(r));
      setDialogOpen(false);
      setFormData({
        name: "",
        agentConfigId: "",
        gitRepoUrl: "",
        gitBranch: "main",
        templateId: "",
      });
      if (newSession?.id) {
        navigate(`/sessions/${newSession.id}`);
      } else {
        await refreshSessions();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleSessionAction = async (id: string, action: "stop" | "destroy" | "restart") => {
    if (action === "destroy") {
      await client.api.sessions[":id"].$delete({ param: { id } });
    } else if (action === "stop") {
      await client.api.sessions[":id"].stop.$put({ param: { id } });
    } else {
      await client.api.sessions[":id"].restart.$put({ param: { id } });
    }
    await refreshSessions();
  };

  const handleRecreate = async (sessionId: string) => {
    try {
      const params = await client.api.sessions[":id"]["recreate-params"]
        .$get({ param: { id: sessionId } })
        .then((r) =>
          unwrap<{
            name: string;
            agentConfigId: string | null;
            gitRepoUrl: string | null;
            gitBranch: string | null;
            templateId: string | null;
          }>(r),
        );
      const newSession = await client.api.sessions
        .$post({
          json: {
            name: params.name,
            agentConfigId: params.agentConfigId || undefined,
            gitRepoUrl: params.gitRepoUrl || undefined,
            gitBranch: params.gitBranch || undefined,
            templateId: params.templateId || undefined,
          },
        })
        .then((r) => unwrap<CodingSession>(r));
      if (newSession?.id) {
        navigate(`/sessions/${newSession.id}`);
      }
    } catch {
      // ignore errors
    }
  };

  const filteredSessions =
    isAdmin && showAll ? sessions : sessions.filter((s) => s.userId === session?.user?.id);

  const previewTemplate = templates.find((t) => t.id === formData.templateId);
  const selectedTemplate = templates.find((t) => t.id === formData.templateId);
  const gitRequired = selectedTemplate?.gitRequired ?? false;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
        <p className="hidden text-xs text-muted-foreground md:block">
          Manage your coding agent sessions
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="size-3.5" />
                  New Session
                </Button>
              }
            />
            <DialogContent className={previewTemplate ? "sm:max-w-3xl" : "sm:max-w-md"}>
              <DialogHeader>
                <DialogTitle>Create New Session</DialogTitle>
                <DialogDescription>Start a new coding agent session.</DialogDescription>
              </DialogHeader>
              <div className={previewTemplate ? "grid grid-cols-2 gap-6" : ""}>
                <div>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Name</FieldLabel>
                      <Input
                        placeholder="My session"
                        value={formData.name}
                        onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Coding Agent</FieldLabel>
                      <Select
                        value={formData.agentConfigId}
                        onValueChange={(v) =>
                          v !== null && setFormData((prev) => ({ ...prev, agentConfigId: v }))
                        }
                        items={[
                          { label: "Select an agent", value: null },
                          ...agentConfigs.map((ac) => ({
                            label:
                              ac.displayName +
                              (ac.imageBuildStatus !== "built" ? " (not built)" : ""),
                            value: ac.id,
                            disabled: ac.imageBuildStatus !== "built",
                          })),
                        ]}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select an agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {agentConfigs.map((ac) => (
                            <SelectItem
                              key={ac.id}
                              value={ac.id}
                              disabled={ac.imageBuildStatus !== "built"}
                            >
                              {ac.displayName}
                              {ac.imageBuildStatus !== "built" ? " (not built)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Template</FieldLabel>
                      <Select
                        value={formData.templateId || "__none__"}
                        onValueChange={(v) =>
                          v !== null &&
                          setFormData((prev) => ({
                            ...prev,
                            templateId: v === "__none__" ? "" : v,
                          }))
                        }
                        items={[
                          { label: "None", value: "__none__" },
                          ...templates.map((t) => ({
                            label: t.name,
                            value: t.id,
                          })),
                        ]}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>
                        Git Repo URL {gitRequired && <span className="text-destructive">*</span>}
                      </FieldLabel>
                      <Input
                        placeholder="https://github.com/user/repo"
                        value={formData.gitRepoUrl}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, gitRepoUrl: e.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Git Branch</FieldLabel>
                      <Input
                        placeholder="main"
                        value={formData.gitBranch}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, gitBranch: e.target.value }))
                        }
                      />
                    </Field>
                  </FieldGroup>
                </div>
                {previewTemplate && (
                  <div className="space-y-3 border-l pl-6">
                    <h3 className="text-sm font-medium">Template Preview</h3>
                    <div className="space-y-2 text-xs">
                      <p className="font-medium">{previewTemplate.name}</p>
                      {previewTemplate.description && (
                        <p className="text-muted-foreground">{previewTemplate.description}</p>
                      )}
                      <div className="flex gap-1">
                        {previewTemplate.gitRequired && (
                          <Badge variant="outline">Git Required</Badge>
                        )}
                        <Badge variant="outline">
                          {previewTemplate.isPublic ? "Public" : "Private"}
                        </Badge>
                      </div>
                      {previewTemplate.systemPrompt && (
                        <div>
                          <p className="mb-1 font-medium">System Prompt</p>
                          <pre className="max-h-48 overflow-auto rounded border bg-muted p-2 text-xs whitespace-pre-wrap">
                            {previewTemplate.systemPrompt}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  onClick={handleCreateSession}
                  disabled={
                    !formData.name.trim() ||
                    !formData.agentConfigId ||
                    (gitRequired && !formData.gitRepoUrl.trim()) ||
                    creating
                  }
                >
                  {creating ? "Creating..." : "Create Session"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
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
          {filteredSessions.map((s) => {
            const status = (s.status as SessionStatus) || "pending";
            const config = sessionStatusConfig[status] || sessionStatusConfig.pending;
            return (
              <Card key={s.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <Link to={`/sessions/${s.id}`} className="truncate hover:underline">
                      {s.name}
                    </Link>
                    <Badge variant="outline" className={`shrink-0 ${config.className}`}>
                      {config.label}
                    </Badge>
                  </CardTitle>
                  {s.agentTitle && (
                    <p className="truncate text-xs text-muted-foreground">{s.agentTitle}</p>
                  )}
                </CardHeader>
                <CardContent className="flex-1 space-y-1.5">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Bot className="size-3 shrink-0" />
                    {s.preset}
                  </div>
                  {s.gitRepoUrl && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <GitBranch className="size-3 shrink-0" />
                      <span className="truncate">{s.gitRepoUrl}</span>
                    </div>
                  )}
                  {s.resultHtml && (
                    <Badge
                      variant="outline"
                      className="gap-1 border-green-500/30 bg-green-500/10 text-xs text-green-700 dark:text-green-400"
                    >
                      <span className="size-1.5 rounded-full bg-green-500" />
                      Result
                    </Badge>
                  )}
                  <div className="text-xs text-muted-foreground">{timeAgo(s.createdAt)}</div>
                </CardContent>
                <CardFooter className="gap-1.5">
                  <Link
                    to={`/sessions/${s.id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Eye className="size-3" />
                    View
                  </Link>
                  {status === "running" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setConfirmAction({
                          type: "stop",
                          sessionId: s.id,
                          sessionName: s.name,
                        })
                      }
                    >
                      <Square className="size-3" />
                      Stop
                    </Button>
                  )}
                  {status === "stopped" && (
                    <Button variant="outline" size="sm" onClick={() => handleRecreate(s.id)}>
                      <RotateCcw className="size-3" />
                      Re-create
                    </Button>
                  )}
                  {status === "stopped" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() =>
                        setConfirmAction({
                          type: "destroy",
                          sessionId: s.id,
                          sessionName: s.name,
                        })
                      }
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

      {/* Confirm Stop / Destroy Dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === "stop" ? "Stop Session" : "Destroy Session"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "stop"
                ? `Are you sure you want to stop session '${confirmAction.sessionName}'?`
                : `Are you sure you want to destroy session '${confirmAction?.sessionName}'? This will delete the session and all its data permanently.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!confirmAction) return;
                await handleSessionAction(confirmAction.sessionId, confirmAction.type);
                setConfirmAction(null);
              }}
            >
              {confirmAction?.type === "stop" ? "Stop" : "Destroy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
