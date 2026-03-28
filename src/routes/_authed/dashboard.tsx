import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useForm } from "@tanstack/react-form";
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
import { Field, FieldLabel, FieldError, FieldGroup } from "@/components/ui/field";
import { Plus, Eye, Square, Trash2, RotateCcw, GitBranch, Bot, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { CodingSession, Template, AgentConfig, SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export const Route = createFileRoute("/_authed/dashboard")({
  loader: async () => {
    const [sessions, myTemplates, publicTemplates, agentConfigs] = await Promise.all([
      listSessions(),
      listTemplates({ data: { mine: true } }),
      listTemplates({ data: { mine: false } }),
      listAgentConfigs(),
    ]);
    // Merge and deduplicate (user's own + public)
    const seen = new Set<string>();
    const templates = [...myTemplates, ...publicTemplates].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
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

  const form = useForm({
    defaultValues: {
      name: "",
      agentConfigId: "",
      gitRepoUrl: "",
      gitBranch: "main",
      templateId: "",
    },
    onSubmit: async ({ value }) => {
      if (!value.name.trim() || !value.agentConfigId) return;
      const selectedTemplate = templates.find((t: Template) => t.id === value.templateId);
      if (selectedTemplate?.gitRequired && !value.gitRepoUrl.trim()) return;
      setCreating(true);
      try {
        const newSession = await createSession({
          data: {
            name: value.name.trim(),
            agentConfigId: value.agentConfigId,
            gitRepoUrl: value.gitRepoUrl.trim() || undefined,
            gitBranch: value.gitBranch.trim() || undefined,
            templateId: value.templateId || undefined,
          },
        });
        setDialogOpen(false);
        form.reset();
        if (newSession?.id) {
          navigate({ to: "/sessions/$sessionId", params: { sessionId: newSession.id } });
        } else {
          await refreshSessions();
        }
      } finally {
        setCreating(false);
      }
    },
  });

  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  const refreshSessions = async () => {
    const updated = await listSessions();
    setSessions(updated);
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
                        placeholder="My session"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                      />
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              />
              <form.Field
                name="agentConfigId"
                validators={{
                  onBlur: ({ value }) => (!value ? "Agent is required" : undefined),
                }}
                children={(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                  return (
                    <Field data-invalid={isInvalid || undefined}>
                      <FieldLabel>Coding Agent</FieldLabel>
                      <Select value={field.state.value} onValueChange={field.handleChange}>
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
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              />
              <form.Field
                name="templateId"
                children={(field) => (
                  <Field>
                    <FieldLabel>Template</FieldLabel>
                    <Select
                      value={field.state.value || "__none__"}
                      onValueChange={(v) => field.handleChange(v === "__none__" ? "" : v)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {templates.map((t: Template) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <form.Subscribe
                selector={(state) => state.values.templateId}
                children={(templateId) => {
                  const selectedTemplate = templates.find((t: Template) => t.id === templateId);
                  const gitRequired = selectedTemplate?.gitRequired ?? false;
                  return (
                    <>
                      <form.Field
                        name="gitRepoUrl"
                        validators={{
                          onBlur: ({ value }) =>
                            gitRequired && !value.trim()
                              ? "Git URL is required for this template"
                              : undefined,
                        }}
                        children={(field) => {
                          const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                          return (
                            <Field data-invalid={isInvalid || undefined}>
                              <FieldLabel>
                                Git Repo URL{" "}
                                {gitRequired && <span className="text-destructive">*</span>}
                              </FieldLabel>
                              <Input
                                placeholder="https://github.com/user/repo"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                              />
                              {isInvalid && <FieldError errors={field.state.meta.errors} />}
                            </Field>
                          );
                        }}
                      />
                    </>
                  );
                }}
              />
              <form.Field
                name="gitBranch"
                children={(field) => (
                  <Field>
                    <FieldLabel>Git Branch</FieldLabel>
                    <Input
                      placeholder="main"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </Field>
                )}
              />
            </FieldGroup>
            <DialogFooter>
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting, state.values]}
                children={([canSubmit, isSubmitting, values]) => {
                  const v = values as {
                    name: string;
                    agentConfigId: string;
                    templateId: string;
                    gitRepoUrl: string;
                  };
                  const selectedTemplate = templates.find((t: Template) => t.id === v.templateId);
                  const gitMissing = selectedTemplate?.gitRequired && !v.gitRepoUrl.trim();
                  return (
                    <Button
                      onClick={() => form.handleSubmit()}
                      disabled={
                        !v.name.trim() ||
                        !v.agentConfigId ||
                        !!gitMissing ||
                        (isSubmitting as boolean) ||
                        creating
                      }
                    >
                      {creating ? "Creating..." : "Create Session"}
                    </Button>
                  );
                }}
              />
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
                  {status === "stopped" && (
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
