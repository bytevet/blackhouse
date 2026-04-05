import { useParams, useNavigate } from "react-router";
import { useState, useCallback, useEffect } from "react";
import {
  Square,
  Play,
  Trash2,
  PanelRightOpen,
  PanelRightClose,
  PanelBottomOpen,
  PanelBottomClose,
  Loader2,
  Copy,
  ExternalLink,
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
import { FileExplorer } from "@/components/file-explorer";
import { FileViewer } from "@/components/file-viewer";
import { ResultViewer } from "@/components/result-viewer";
import type { CodingSession, SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export function SessionPage() {
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
          <h2 className="text-lg font-semibold text-foreground">Session not found</h2>
          <p className="text-sm text-muted-foreground">
            This session may have been destroyed or does not exist.
          </p>
        </div>
      </div>
    );
  }

  return <SessionView initialSession={session} />;
}

function SessionView({ initialSession }: { initialSession: CodingSession }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [session, setSession] = useState(initialSession);
  const [explorerOpen, setExplorerOpen] = useState(!!initialSession.hasResult);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [explorerTab, setExplorerTab] = useState<string>(
    initialSession.hasResult ? "result" : "files",
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: "stop" | "destroy" } | null>(null);

  useEffect(() => {
    if (!session || session.status !== "running") return;

    const interval = setInterval(async () => {
      try {
        const updated = await client.api.sessions[":id"]
          .$get({ param: { id: session.id } })
          .then((r) => unwrap<CodingSession>(r));
        if (updated) {
          const isNewResult =
            updated.hasResult && (!session.hasResult || updated.updatedAt > session.updatedAt);
          setSession(updated);
          if (isNewResult) {
            setExplorerOpen(true);
            setExplorerTab("result");
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [session]);

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
        <h1 className="text-sm font-semibold text-foreground">{session.name}</h1>
        {session.agentTitle && (
          <span className="text-xs text-muted-foreground">— {session.agentTitle}</span>
        )}
        <Badge variant="outline" className="text-xs">
          {session.preset}
        </Badge>
        <Badge
          variant="outline"
          className={sessionStatusConfig[session.status as SessionStatus]?.className ?? ""}
        >
          {actionLoading ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {session.status === "running" ? "Stopping..." : "Restarting..."}
            </span>
          ) : (
            session.status
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
              <span className="hidden sm:inline">{actionLoading ? "Stopping..." : "Stop"}</span>
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
                {actionLoading ? "Restarting..." : "Restart"}
              </span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button variant="outline" size="sm" onClick={handleRecreate} disabled={actionLoading}>
              <Copy className="size-3" />
              <span className="hidden sm:inline">Re-create</span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmAction({ type: "destroy" })}
              disabled={actionLoading}
            >
              <Trash2 className="size-3" />
              <span className="hidden sm:inline">Destroy</span>
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
            <span className="hidden sm:inline">{explorerOpen ? "Hide Panel" : "Files"}</span>
          </Button>
        </div>
      </div>

      {/* Main content */}
      {explorerOpen ? (
        <ResizablePanelGroup orientation={isMobile ? "vertical" : "horizontal"} className="flex-1">
          <ResizablePanel id="terminal" defaultSize={50} minSize={20}>
            <TerminalPanel sessionId={session.id} status={session.status} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="sidebar" defaultSize={50} minSize={15}>
            <Tabs
              value={explorerTab}
              onValueChange={setExplorerTab}
              className="flex h-full flex-col"
            >
              <TabsList variant="line" className="w-full border-b">
                <TabsTrigger value="files" className="text-xs">
                  File Explorer
                </TabsTrigger>
                <TabsTrigger value="result" className="text-xs">
                  Result
                  {session.hasResult && <span className="ml-1 size-1.5 rounded-full bg-primary" />}
                  {session.hasResult && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <a
                            href={`/api/sessions/${session.id}/results/latest`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-1 opacity-50 hover:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <ExternalLink className="size-3" />
                      </TooltipTrigger>
                      <TooltipContent>Open in new tab</TooltipContent>
                    </Tooltip>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="files" className="flex-1 overflow-hidden">
                <ResizablePanelGroup orientation="horizontal" className="h-full">
                  <ResizablePanel id="file-tree" defaultSize={35} minSize={20}>
                    <div className="h-full overflow-auto">
                      <FileExplorer
                        sessionId={session.id}
                        onFileSelect={setSelectedFile}
                        selectedFile={selectedFile}
                        status={session.status}
                        rootPath={
                          session.gitRepoUrl
                            ? `/workspace/${session.gitRepoUrl
                                .replace(/\.git$/, "")
                                .split("/")
                                .pop()}`
                            : "/workspace"
                        }
                      />
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel id="file-viewer" defaultSize={65} minSize={20}>
                    <div className="h-full overflow-auto">
                      {selectedFile ? (
                        <FileViewer
                          sessionId={session.id}
                          filePath={selectedFile}
                          status={session.status}
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                          Select a file to view
                        </div>
                      )}
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
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
                    No result yet. The coding agent can submit results via MCP.
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex-1">
          <TerminalPanel sessionId={session.id} status={session.status} />
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
                ? "Are you sure you want to stop this session?"
                : "Are you sure you want to destroy this session? This action cannot be undone."}
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
                const action = confirmAction.type;
                setConfirmAction(null);
                await handleAction(action);
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
