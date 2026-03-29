import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef } from "react";
import { Square, Play, Trash2, PanelRightOpen, PanelRightClose, Loader2, Copy } from "lucide-react";
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
import { TerminalPanel } from "@/components/terminal";
import { FileExplorer } from "@/components/file-explorer";
import { FileViewer } from "@/components/file-viewer";
import { ResultViewer } from "@/components/result-viewer";
import {
  getSession,
  stopSession,
  destroySession,
  restartSession,
  createSession,
  getSessionRecreateParams,
} from "@/server/sessions";
import type { SessionStatus } from "@/db/schema";
import { sessionStatusConfig } from "@/lib/session-status";

export const Route = createFileRoute("/_authed/sessions/$sessionId")({
  loader: async ({ params }) => {
    const session = await getSession({ data: { id: params.sessionId } });
    return { session };
  },
  component: SessionViewPage,
});

function SessionViewPage() {
  const { session: initialSession } = Route.useLoaderData();
  const navigate = useNavigate();
  const [session, setSession] = useState(initialSession);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [explorerTab, setExplorerTab] = useState<string>("files");
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: "stop" | "destroy" } | null>(null);

  useEffect(() => {
    if (!session || session.status !== "running") return;

    const interval = setInterval(async () => {
      try {
        const updated = await getSession({
          data: { id: session.id },
        });
        if (updated) {
          setSession(updated);
          if (updated.resultHtml && !session.resultHtml) {
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
        const fns = { stop: stopSession, destroy: destroySession, restart: restartSession };
        await fns[action]({ data: { id: session.id } });
        const updated = await getSession({ data: { id: session.id } });
        if (updated) setSession(updated);
        if (action === "destroy") {
          navigate({ to: "/dashboard" });
        }
      } catch {
        // ignored — UI already shows stale state until next poll
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
      const params = await getSessionRecreateParams({ data: { sessionId: session.id } });
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
      // ignored
    } finally {
      setActionLoading(false);
    }
  }, [session, navigate]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Session not found
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-5rem)] flex-col -m-4 md:-m-6">
      {/* Meta section */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 md:gap-3 md:px-4">
        <h1 className="text-sm font-semibold text-foreground">{session.name}</h1>
        <Badge variant="outline" className="text-[10px]">
          {session.agentType}
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
              size="xs"
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
              size="xs"
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
            <Button variant="outline" size="xs" onClick={handleRecreate} disabled={actionLoading}>
              <Copy className="size-3" />
              <span className="hidden sm:inline">Re-create</span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="destructive"
              size="xs"
              onClick={() => setConfirmAction({ type: "destroy" })}
              disabled={actionLoading}
            >
              <Trash2 className="size-3" />
              <span className="hidden sm:inline">Destroy</span>
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={() => setExplorerOpen((p) => !p)}>
            {explorerOpen ? (
              <PanelRightClose className="size-3.5" />
            ) : (
              <PanelRightOpen className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Main content */}
      {explorerOpen ? (
        <ResizablePanelGroup orientation="horizontal" className="flex-1">
          <ResizablePanel defaultSize={60} minSize={20}>
            <TerminalPanel sessionId={session.id} status={session.status} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={40} minSize={15}>
            <Tabs
              value={explorerTab}
              onValueChange={setExplorerTab}
              className="flex h-full flex-col"
            >
              <TabsList variant="line" className="w-full">
                <TabsTrigger value="files" className="text-xs">
                  File Explorer
                </TabsTrigger>
                <TabsTrigger value="result" className="text-xs">
                  Result
                  {session.resultHtml && <span className="ml-1 size-1.5 rounded-full bg-primary" />}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="files" className="flex-1 overflow-hidden">
                <ResizablePanelGroup orientation="horizontal" className="h-full">
                  <ResizablePanel defaultSize={35} minSize={20}>
                    <div className="h-full overflow-auto">
                      <FileExplorer
                        sessionId={session.id}
                        onFileSelect={setSelectedFile}
                        selectedFile={selectedFile}
                      />
                    </div>
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize={65} minSize={20}>
                    <div className="h-full overflow-auto">
                      {selectedFile ? (
                        <FileViewer sessionId={session.id} filePath={selectedFile} />
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
                {session.resultHtml ? (
                  <ResultViewer html={session.resultHtml} />
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
                await handleAction(confirmAction.type);
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
