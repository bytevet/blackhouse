import { useParams, useNavigate } from "react-router";
import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Square,
  Play,
  UserX,
  PanelRightOpen,
  PanelRightClose,
  PanelBottomOpen,
  PanelBottomClose,
  Loader2,
  Copy,
  ExternalLink,
  Globe,
  Code2,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { client, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TerminalPanel } from "@/components/terminal";
import { IdeViewer } from "@/components/ide-viewer";
import { ResultViewer } from "@/components/result-viewer";
import { BrowserViewer } from "@/components/browser-viewer";
import type { CodingSession } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export function SessionPage() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<CodingSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    client.api.sessions[":id"]
      .$get({ param: { id: sessionId } })
      .then((r) => unwrap<CodingSession>(r))
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="space-y-2 text-center">
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            {t("worker.notFound")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("worker.notFoundDescription")}</p>
        </div>
      </div>
    );
  }

  return <SessionView initialSession={session} />;
}

function SessionView({ initialSession }: { initialSession: CodingSession }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [session, setSession] = useState(initialSession);
  const [explorerOpen, setExplorerOpen] = useState(!!initialSession.hasResult);
  const [explorerTab, setExplorerTab] = useState<string>(
    initialSession.hasResult ? "result" : "ide",
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: "stop" | "destroy" } | null>(null);
  // One-shot URL to navigate the embedded browser to (e.g. from terminal link
  // click — #46). Cleared by BrowserViewer via `onNavigated` so the same URL
  // clicked twice in a row still re-fires.
  const [pendingBrowserNav, setPendingBrowserNav] = useState<string | null>(null);

  const openBrowserAt = useCallback((url: string) => {
    setExplorerOpen(true);
    setExplorerTab("browser");
    setPendingBrowserNav(url);
  }, []);

  // Keep a ref to the latest session so the polling closure can diff against
  // current state without putting the whole `session` object in the effect's
  // dep array (which would tear down + recreate the interval on every tick).
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (!session || session.status !== "running") return;

    const sessionId = session.id;
    const interval = setInterval(async () => {
      try {
        const updated = await client.api.sessions[":id"]
          .$get({ param: { id: sessionId } })
          .then((r) => unwrap<CodingSession>(r));
        if (!updated) return;

        const prev = sessionRef.current;
        // No-op if nothing the UI cares about has changed
        if (
          prev &&
          updated.status === prev.status &&
          updated.hasResult === prev.hasResult &&
          updated.updatedAt === prev.updatedAt
        ) {
          return;
        }

        const isNewResult =
          updated.hasResult && (!prev?.hasResult || updated.updatedAt > prev.updatedAt);
        const resultDisappeared = prev?.hasResult && !updated.hasResult;
        setSession(updated);
        if (isNewResult) {
          setExplorerOpen(true);
          setExplorerTab("result");
        } else if (resultDisappeared) {
          // The user could be parked on the Result tab when the result is
          // deleted; the trigger is now hidden, so fall back to the IDE tab.
          setExplorerTab((cur) => (cur === "result" ? "ide" : cur));
        }
      } catch {
        // ignore polling errors
      }
    }, 10000);

    return () => clearInterval(interval);
    // Only re-run when the polled subject's identity changes — not on every
    // data refresh. sessionRef gives us the live `session` inside the closure.
  }, [session?.id, session?.status]);

  const handleAction = useCallback(
    async (action: "stop" | "destroy" | "restart") => {
      if (!session) return;
      setActionLoading(true);
      try {
        if (action === "destroy") {
          await client.api.sessions[":id"].$delete({ param: { id: session.id } });
        } else if (action === "stop") {
          await client.api.sessions[":id"].stop.$put({ param: { id: session.id } });
        } else {
          await client.api.sessions[":id"].restart.$put({ param: { id: session.id } });
        }
        if (action !== "destroy") {
          const updated = await client.api.sessions[":id"]
            .$get({ param: { id: session.id } })
            .then((r) => unwrap<CodingSession>(r));
          if (updated) setSession(updated);
        }
        if (action === "destroy") {
          navigate("/dashboard");
        }
      } catch {
        // ignored
      } finally {
        setActionLoading(false);
      }
    },
    [session, navigate],
  );

  const handleRecreate = useCallback(async () => {
    if (!session) return;
    setActionLoading(true);
    try {
      const params = await client.api.sessions[":id"]["recreate-params"]
        .$get({ param: { id: session.id } })
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
      // ignored
    } finally {
      setActionLoading(false);
    }
  }, [session, navigate]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Meta section */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 md:gap-3 md:px-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground">{session.name}</h1>
        {session.agentTitle && (
          <span className="text-xs text-muted-foreground">— {session.agentTitle}</span>
        )}
        <Badge variant="outline" className="text-xs">
          {session.preset}
        </Badge>
        <Badge variant="outline" className={sessionStatusConfig[session.status]?.className ?? ""}>
          {actionLoading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {session.status === "running" ? t("worker.sendingOffDuty") : t("worker.waking")}
            </span>
          ) : (
            t(sessionStatusConfig[session.status]?.labelKey ?? "status.pending")
          )}
        </Badge>
        <span className="hidden text-xs text-muted-foreground sm:inline">{session.gitRepoUrl}</span>

        <div className="ml-auto flex items-center gap-1">
          {session.status === "running" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmAction({ type: "stop" })}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3" />
              )}
              <span className="hidden sm:inline">
                {actionLoading ? t("worker.sendingOffDuty") : t("worker.sendOffDuty")}
              </span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction("restart")}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Play className="size-3" />
              )}
              <span className="hidden sm:inline">
                {actionLoading ? t("worker.waking") : t("worker.wake")}
              </span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button variant="outline" size="sm" onClick={handleRecreate} disabled={actionLoading}>
              <Copy className="size-3" />
              <span className="hidden sm:inline">{t("worker.respawn")}</span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmAction({ type: "destroy" })}
              disabled={actionLoading}
            >
              <UserX className="size-3" />
              <span className="hidden sm:inline">{t("worker.dismiss")}</span>
            </Button>
          )}
          <Button
            variant={explorerOpen ? "outline" : "default"}
            size="sm"
            onClick={() => setExplorerOpen((p) => !p)}
          >
            {explorerOpen ? (
              isMobile ? (
                <PanelBottomClose className="size-3" />
              ) : (
                <PanelRightClose className="size-3" />
              )
            ) : isMobile ? (
              <PanelBottomOpen className="size-3" />
            ) : (
              <PanelRightOpen className="size-3" />
            )}
            <span className="hidden sm:inline">
              {explorerOpen ? t("worker.panelHide") : t("worker.panelOpen")}
            </span>
          </Button>
        </div>
      </div>

      {/* Main content */}
      {explorerOpen ? (
        <ResizablePanelGroup orientation={isMobile ? "vertical" : "horizontal"} className="flex-1">
          <ResizablePanel id="terminal" defaultSize={50} minSize={20}>
            <TerminalPanel
              sessionId={session.id}
              status={session.status}
              onLinkClick={openBrowserAt}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="sidebar" defaultSize={50} minSize={15}>
            <Tabs
              value={explorerTab}
              onValueChange={setExplorerTab}
              className="flex h-full flex-col"
            >
              <TabsList variant="line" className="w-full border-b">
                <TabsTrigger value="ide" className="text-xs">
                  <Code2 className="mr-1 size-3" />
                  {t("worker.tabs.ide")}
                </TabsTrigger>
                {session.hasResult && (
                  <TabsTrigger value="result" className="text-xs">
                    {t("worker.tabs.result")}
                    <span className="ml-1 size-1.5 rounded-full bg-primary" />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="ml-1 size-5 opacity-50 hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(
                                `/api/sessions/${session.id}/results/latest`,
                                "_blank",
                                "noopener,noreferrer",
                              );
                            }}
                          />
                        }
                      >
                        <ExternalLink className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent>{t("worker.openInNewTab")}</TooltipContent>
                    </Tooltip>
                  </TabsTrigger>
                )}
                <TabsTrigger value="browser" className="text-xs">
                  <Globe className="mr-1 size-3" />
                  {t("worker.tabs.browser")}
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="ide"
                keepMounted
                className="m-0 flex-1 overflow-hidden data-[hidden]:hidden"
              >
                <IdeViewer sessionId={session.id} status={session.status} />
              </TabsContent>

              <TabsContent value="result" className="m-0 flex-1 overflow-hidden">
                {session.hasResult ? (
                  <ResultViewer
                    sessionId={session.id}
                    updatedAt={session.updatedAt}
                    onDelete={async () => {
                      await client.api.sessions[":id"].result.$delete({
                        param: { id: session.id },
                      });
                      const updated = await client.api.sessions[":id"]
                        .$get({ param: { id: session.id } })
                        .then((r) => unwrap<CodingSession>(r));
                      if (updated) setSession(updated);
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t("worker.tabs.noResult")}
                  </div>
                )}
              </TabsContent>

              <TabsContent
                value="browser"
                keepMounted
                className="m-0 flex-1 overflow-hidden data-[hidden]:hidden"
              >
                <BrowserViewer
                  sessionId={session.id}
                  status={session.status}
                  navigateTo={pendingBrowserNav}
                  onNavigated={() => setPendingBrowserNav(null)}
                />
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex-1">
          <TerminalPanel
            sessionId={session.id}
            status={session.status}
            onLinkClick={openBrowserAt}
          />
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
                ? t("worker.confirmDialog.sendOffDutyBody", { name: session.name })
                : t("worker.confirmDialog.dismissBody", { name: session.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!confirmAction) return;
                const action = confirmAction.type;
                setConfirmAction(null);
                await handleAction(action);
              }}
            >
              {confirmAction?.type === "stop" ? t("worker.sendOffDuty") : t("worker.dismiss")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
