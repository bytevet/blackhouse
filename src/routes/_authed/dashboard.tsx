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
  getSessionRecreateParams,
} from "@/server/sessions";
import { listTemplates } from "@/server/templates";
import { listAgentConfigs } from "@/server/settings";
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
import { Field, FieldLabel, FieldError, FieldGroup } from "@/components/ui/field";
import { toFieldErrors } from "@/lib/form-errors";
import { Plus, Eye, Square, Trash2, RotateCcw, GitBranch, Bot, FileText } from "lucide-react";
import { timeAgo } from "@/lib/time";
import type { CodingSession, Template, AgentConfig, SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export const Route = createFileRoute("/_authed/dashboard")({
  loader: async () => {
    const [sessions, myTemplates, publicTemplates, agentConfigs] = (await Promise.all([
      listSessions(),
      listTemplates({ data: { mine: true } }),
      listTemplates({ data: { mine: false } }),
      listAgentConfigs(),
    ])) as [CodingSession[], Template[], Template[], AgentConfig[]];
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
  const {
    sessions: initialSessions,
    templates,
    agentConfigs,
  } = Route.useLoaderData() as {
    sessions: CodingSession[];
    templates: Template[];
    agentConfigs: AgentConfig[];
  };
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [sessions, setSessions] = useState(initialSessions);
  const [showAll, setShowAll] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "stop" | "destroy";
    sessionId: string;
    sessionName: string;
  } | null>(null);

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

  const handleRecreate = async (sessionId: string) => {
    try {
      const params = await getSessionRecreateParams({ data: { sessionId } });
      const newSession = await createSession({
        data: {
          name: params.name,
          agentConfigId: params.agentConfigId || undefined,
          gitRepoUrl: params.gitRepoUrl || undefined,
          gitBranch: params.gitBranch || undefined,
          templateId: params.templateId || undefined,
        },
      });
      if (newSession?.id) {
        navigate({ to: "/sessions/$sessionId", params: { sessionId: newSession.id } });
      }
    } catch {
      // ignore errors
    }
  };

  const filteredSessions =
    isAdmin && showAll
      ? sessions
      : sessions.filter((s: CodingSession) => s.userId === session?.user?.id);

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
            <form.Subscribe
              selector={(state) => state.values.templateId}
              children={(templateId) => {
                const previewTemplate = templates.find((t: Template) => t.id === templateId);
                return (
                  <DialogContent className={previewTemplate ? "sm:max-w-3xl" : "sm:max-w-md"}>
                    <DialogHeader>
                      <DialogTitle>Create New Session</DialogTitle>
                      <DialogDescription>Start a new coding agent session.</DialogDescription>
                    </DialogHeader>
                    <div className={previewTemplate ? "grid grid-cols-2 gap-6" : ""}>
                      <div>
                        <FieldGroup>
                          <form.Field
                            name="name"
                            validators={{
                              onBlur: ({ value }) =>
                                !value.trim() ? "Name is required" : undefined,
                            }}
                            children={(field) => {
                              const isInvalid =
                                field.state.meta.isTouched && !field.state.meta.isValid;
                              return (
                                <Field data-invalid={isInvalid || undefined}>
                                  <FieldLabel>Name</FieldLabel>
                                  <Input
                                    placeholder="My session"
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                  />
                                  {isInvalid && (
                                    <FieldError errors={toFieldErrors(field.state.meta.errors)} />
                                  )}
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
                              const isInvalid =
                                field.state.meta.isTouched && !field.state.meta.isValid;
                              return (
                                <Field data-invalid={isInvalid || undefined}>
                                  <FieldLabel>Coding Agent</FieldLabel>
                                  <Select
                                    value={field.state.value}
                                    onValueChange={(v) => v !== null && field.handleChange(v)}
                                    items={[
                                      { label: "Select an agent", value: null },
                                      ...agentConfigs.map((ac: AgentConfig) => ({
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
                                      {agentConfigs.map((ac: AgentConfig) => (
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
                                  {isInvalid && (
                                    <FieldError errors={toFieldErrors(field.state.meta.errors)} />
                                  )}
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
                                  onValueChange={(v) =>
                                    v !== null && field.handleChange(v === "__none__" ? "" : v)
                                  }
                                  items={[
                                    { label: "None", value: "__none__" },
                                    ...templates.map((t: Template) => ({
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
                            children={(innerTemplateId) => {
                              const selectedTemplate = templates.find(
                                (t: Template) => t.id === innerTemplateId,
                              );
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
                                      const isInvalid =
                                        field.state.meta.isTouched && !field.state.meta.isValid;
                                      return (
                                        <Field data-invalid={isInvalid || undefined}>
                                          <FieldLabel>
                                            Git Repo URL{" "}
                                            {gitRequired && (
                                              <span className="text-destructive">*</span>
                                            )}
                                          </FieldLabel>
                                          <Input
                                            placeholder="https://github.com/user/repo"
                                            value={field.state.value}
                                            onChange={(e) => field.handleChange(e.target.value)}
                                            onBlur={field.handleBlur}
                                          />
                                          {isInvalid && (
                                            <FieldError
                                              errors={toFieldErrors(field.state.meta.errors)}
                                            />
                                          )}
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
                                <p className="font-medium mb-1">System Prompt</p>
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
                      <form.Subscribe
                        selector={(state) => [state.canSubmit, state.isSubmitting, state.values]}
                        children={([canSubmit, isSubmitting, values]) => {
                          const v = values as {
                            name: string;
                            agentConfigId: string;
                            templateId: string;
                            gitRepoUrl: string;
                          };
                          const selectedTemplate = templates.find(
                            (t: Template) => t.id === v.templateId,
                          );
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
                );
              }}
            />
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
          {filteredSessions.map((s: CodingSession) => {
            const status = (s.status as SessionStatus) || "pending";
            const config = sessionStatusConfig[status] || sessionStatusConfig.pending;
            return (
              <Card key={s.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2">
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: s.id }}
                      className="truncate hover:underline"
                    >
                      {s.name}
                    </Link>
                    <Badge variant="outline" className={`shrink-0 ${config.className}`}>
                      {config.label}
                    </Badge>
                  </CardTitle>
                  {s.agentTitle && (
                    <p className="truncate text-[10px] text-muted-foreground">{s.agentTitle}</p>
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
                      className="gap-1 border-green-500/30 bg-green-500/10 text-[10px] text-green-700 dark:text-green-400"
                    >
                      <span className="size-1.5 rounded-full bg-green-500" />
                      Result
                    </Badge>
                  )}
                  <div className="text-[10px] text-muted-foreground">{timeAgo(s.createdAt)}</div>
                </CardContent>
                <CardFooter className="gap-1.5">
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: s.id }}
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
                const action = confirmAction.type === "stop" ? stopSession : destroySession;
                await handleSessionAction(confirmAction.sessionId, action);
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
