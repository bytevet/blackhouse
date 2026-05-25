import { useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/lib/auth-client";
import { client, unwrap, type Paginated } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SessionWorkerCard } from "@/components/session-worker-card";
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
import { Plus, ChevronLeft, ChevronRight } from "lucide-react";
import type { CodingSession, Template, AgentConfig, SessionStatus } from "@/db/schema";
import { SESSION_STATUSES } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

type SessionWithUser = CodingSession & { user?: { name: string | null; email: string | null } };

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const navigate = useNavigate();
  const isAdmin = session?.user?.role === "admin";

  const [sessions, setSessions] = useState<SessionWithUser[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsPage, setSessionsPage] = useState(1);
  const sessionsPerPage = 12;
  const [templates, setTemplates] = useState<Template[]>([]);
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [filterStatus, setFilterStatus] = useState<SessionStatus | "">("");
  const [filterResult, setFilterResult] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterTemplate, setFilterTemplate] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "stop" | "destroy";
    sessionId: string;
    sessionName: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    agentConfigId: "",
    gitRepoUrl: "",
    gitBranch: "main",
    templateId: "",
  });

  const sessionQuery = (page: number) => ({
    page: String(page),
    perPage: String(sessionsPerPage),
    ...(isAdmin && showAll ? { all: "true" as const } : {}),
    ...(filterStatus ? { status: filterStatus } : {}),
    ...(filterResult ? { hasResult: filterResult } : {}),
    ...(filterAgent ? { agent: filterAgent } : {}),
    ...(filterTemplate ? { templateId: filterTemplate } : {}),
  });

  useEffect(() => {
    const load = async () => {
      try {
        const [sessionsResult, myTemplates, publicTemplates, configs] = await Promise.all([
          client.api.sessions
            .$get({ query: sessionQuery(sessionsPage) })
            .then((r) => unwrap<Paginated<SessionWithUser>>(r)),
          client.api.templates
            .$get({ query: { mine: "true", perPage: "100" } })
            .then((r) => unwrap<Paginated<Template>>(r)),
          client.api.templates
            .$get({ query: { mine: "false", perPage: "100" } })
            .then((r) => unwrap<Paginated<Template>>(r)),
          client.api.settings["agent-configs"].$get().then((r) => unwrap<AgentConfig[]>(r)),
        ]);
        setSessions(sessionsResult.data);
        setSessionsTotal(sessionsResult.total);
        setAgentConfigs(configs);
        const seen = new Set<string>();
        const merged = [...myTemplates.data, ...publicTemplates.data].filter((t) => {
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
  }, [sessionsPage, showAll, filterStatus, filterResult, filterAgent, filterTemplate]);

  const refreshSessions = async (page = sessionsPage) => {
    const res = await client.api.sessions.$get({ query: sessionQuery(page) });
    const result = await unwrap<Paginated<SessionWithUser>>(res);
    setSessions(result.data);
    setSessionsTotal(result.total);
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

  const totalPages = Math.ceil(sessionsTotal / sessionsPerPage);

  const selectedTemplate = templates.find((tpl) => tpl.id === formData.templateId);
  const previewTemplate = selectedTemplate;
  const gitRequired = selectedTemplate?.gitRequired ?? false;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground">{t("dashboard.title")}</h1>
        <p className="hidden text-xs text-muted-foreground md:block">{t("dashboard.subtitle")}</p>
        <div className="ml-auto flex items-center gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger
              render={
                <Button size="sm">
                  <Plus className="size-3.5" />
                  {t("dashboard.hireWorker")}
                </Button>
              }
            />
            <DialogContent className={previewTemplate ? "sm:max-w-3xl" : "sm:max-w-md"}>
              <DialogHeader>
                <DialogTitle>{t("dashboard.hireDialogTitle")}</DialogTitle>
                <DialogDescription>{t("dashboard.hireDialogDescription")}</DialogDescription>
              </DialogHeader>
              <div className={previewTemplate ? "grid grid-cols-2 gap-6" : ""}>
                <div>
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{t("dashboard.form.name")}</FieldLabel>
                      <Input
                        placeholder={t("dashboard.form.namePlaceholder")}
                        value={formData.name}
                        onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t("dashboard.form.role")}</FieldLabel>
                      <Select
                        value={formData.agentConfigId}
                        onValueChange={(v) =>
                          v !== null && setFormData((prev) => ({ ...prev, agentConfigId: v }))
                        }
                        items={[
                          { label: t("dashboard.form.selectRole"), value: null },
                          ...agentConfigs.map((ac) => ({
                            label:
                              ac.displayName +
                              (ac.imageBuildStatus !== "built"
                                ? t("dashboard.form.notProvisioned")
                                : ""),
                            value: ac.id,
                            disabled: ac.imageBuildStatus !== "built",
                          })),
                        ]}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("dashboard.form.selectRole")} />
                        </SelectTrigger>
                        <SelectContent>
                          {agentConfigs.map((ac) => (
                            <SelectItem
                              key={ac.id}
                              value={ac.id}
                              disabled={ac.imageBuildStatus !== "built"}
                            >
                              {ac.displayName}
                              {ac.imageBuildStatus !== "built"
                                ? t("dashboard.form.notProvisioned")
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{t("dashboard.form.briefing")}</FieldLabel>
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
                          { label: t("dashboard.form.noTemplate"), value: "__none__" },
                          ...templates.map((tpl) => ({
                            label: tpl.name,
                            value: tpl.id,
                          })),
                        ]}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("dashboard.form.noTemplate")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t("dashboard.form.noTemplate")}</SelectItem>
                          {templates.map((tpl) => (
                            <SelectItem key={tpl.id} value={tpl.id}>
                              {tpl.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>
                        {t("dashboard.form.gitRepoUrl")}{" "}
                        {gitRequired && <span className="text-destructive">*</span>}
                      </FieldLabel>
                      <Input
                        placeholder={t("dashboard.form.gitRepoUrlPlaceholder")}
                        value={formData.gitRepoUrl}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, gitRepoUrl: e.target.value }))
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t("dashboard.form.gitBranch")}</FieldLabel>
                      <Input
                        placeholder={t("dashboard.form.gitBranchPlaceholder")}
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
                    <h3 className="text-sm font-medium">{t("dashboard.form.templatePreview")}</h3>
                    <div className="space-y-2 text-xs">
                      <p className="font-medium">{previewTemplate.name}</p>
                      {previewTemplate.description && (
                        <p className="text-muted-foreground">{previewTemplate.description}</p>
                      )}
                      <div className="flex gap-1">
                        {previewTemplate.gitRequired && (
                          <Badge variant="outline">{t("dashboard.form.gitRequired")}</Badge>
                        )}
                        <Badge variant="outline">
                          {previewTemplate.isPublic
                            ? t("dashboard.form.public")
                            : t("dashboard.form.private")}
                        </Badge>
                      </div>
                      {previewTemplate.systemPrompt && (
                        <div>
                          <p className="mb-1 font-medium">{t("briefings.form.systemPrompt")}</p>
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
                  {creating ? t("dashboard.hiring") : t("dashboard.hire")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <>
            <Switch checked={showAll} onCheckedChange={setShowAll} size="sm" />
            <Label className="text-xs text-muted-foreground">
              {showAll ? t("dashboard.showAllAll") : t("dashboard.showAllMine")}
            </Label>
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        )}
        <Select
          value={filterStatus || "__all__"}
          onValueChange={(v) => {
            setFilterStatus(v === "__all__" ? "" : (v as SessionStatus));
            setSessionsPage(1);
          }}
          items={[
            { label: t("dashboard.filters.allStatuses"), value: "__all__" },
            ...SESSION_STATUSES.map((s) => ({
              label: t(sessionStatusConfig[s].labelKey),
              value: s,
            })),
          ]}
        >
          <SelectTrigger className="h-7 w-auto min-w-28 text-xs">
            <SelectValue placeholder={t("dashboard.filters.status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("dashboard.filters.allStatuses")}</SelectItem>
            {SESSION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(sessionStatusConfig[s].labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filterResult || "__all__"}
          onValueChange={(v) => {
            setFilterResult(v == null || v === "__all__" ? "" : v);
            setSessionsPage(1);
          }}
          items={[
            { label: t("dashboard.filters.allResults"), value: "__all__" },
            { label: t("dashboard.filters.hasResult"), value: "true" },
            { label: t("dashboard.filters.noResult"), value: "false" },
          ]}
        >
          <SelectTrigger className="h-7 w-auto min-w-28 text-xs">
            <SelectValue placeholder={t("dashboard.filters.result")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("dashboard.filters.allResults")}</SelectItem>
            <SelectItem value="true">{t("dashboard.filters.hasResult")}</SelectItem>
            <SelectItem value="false">{t("dashboard.filters.noResult")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filterAgent || "__all__"}
          onValueChange={(v) => {
            setFilterAgent(v == null || v === "__all__" ? "" : v);
            setSessionsPage(1);
          }}
          items={[
            { label: t("dashboard.filters.allRoles"), value: "__all__" },
            ...agentConfigs.map((a) => ({ label: a.displayName, value: a.id })),
          ]}
        >
          <SelectTrigger className="h-7 w-auto min-w-28 text-xs">
            <SelectValue placeholder={t("dashboard.filters.role")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("dashboard.filters.allRoles")}</SelectItem>
            {agentConfigs.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {templates.length > 0 && (
          <Select
            value={filterTemplate || "__all__"}
            onValueChange={(v) => {
              setFilterTemplate(v == null || v === "__all__" ? "" : v);
              setSessionsPage(1);
            }}
            items={[
              { label: t("dashboard.filters.allBriefings"), value: "__all__" },
              ...templates.map((tpl) => ({ label: tpl.name, value: tpl.id })),
            ]}
          >
            <SelectTrigger className="h-7 w-auto min-w-28 text-xs">
              <SelectValue placeholder={t("dashboard.filters.briefing")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t("dashboard.filters.allBriefings")}</SelectItem>
              {templates.map((tpl) => (
                <SelectItem key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("dashboard.emptyState")}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-3 gap-y-10 pt-8">
          {/* `auto-fill` with a narrow min keeps each ID-card around its
              natural ratio across viewports; `gap-y-10` + `pt-8` reserve
              room for the avatar's 50% top-overflow on every row including
              the first. */}
          {sessions.map((s) => (
            <SessionWorkerCard
              key={s.id}
              session={s}
              showOwner={showAll}
              onStop={(sessionId, sessionName) =>
                setConfirmAction({ type: "stop", sessionId, sessionName })
              }
              onDestroy={(sessionId, sessionName) =>
                setConfirmAction({ type: "destroy", sessionId, sessionName })
              }
              onRecreate={(sessionId) => handleRecreate(sessionId)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={sessionsPage <= 1}
            onClick={() => setSessionsPage((p) => p - 1)}
          >
            <ChevronLeft className="size-3" />
            {t("common.prev")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("dashboard.pageOf", { current: sessionsPage, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={sessionsPage >= totalPages}
            onClick={() => setSessionsPage((p) => p + 1)}
          >
            {t("common.next")}
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      {/* Confirm Send Off-Duty / Dismiss Dialog */}
      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === "stop"
                ? t("worker.confirmDialog.sendOffDutyTitle")
                : t("worker.confirmDialog.dismissTitle")}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "stop"
                ? t("worker.confirmDialog.sendOffDutyBody", {
                    name: confirmAction.sessionName,
                  })
                : t("worker.confirmDialog.dismissBody", { name: confirmAction?.sessionName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmAction(null)}
              disabled={actionLoading}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={actionLoading}
              onClick={async () => {
                if (!confirmAction) return;
                setActionLoading(true);
                try {
                  await handleSessionAction(confirmAction.sessionId, confirmAction.type);
                  setConfirmAction(null);
                } finally {
                  setActionLoading(false);
                }
              }}
            >
              {actionLoading
                ? confirmAction?.type === "stop"
                  ? t("worker.sendingOffDuty")
                  : t("worker.dismissing")
                : confirmAction?.type === "stop"
                  ? t("worker.sendOffDuty")
                  : t("worker.dismiss")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
