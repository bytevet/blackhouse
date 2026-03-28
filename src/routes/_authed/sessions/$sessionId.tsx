import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import { Square, Play, Trash2, PanelRightOpen, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TerminalPanel } from "@/components/terminal";
import { FileExplorer } from "@/components/file-explorer";
import { FileViewer } from "@/components/file-viewer";
import { ResultViewer } from "@/components/result-viewer";
import { getSession, stopSession, destroySession, restartSession } from "@/server/sessions";
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
        // handle error
      } finally {
        setActionLoading(false);
      }
    },
    [session, navigate],
  );

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
          {session.status}
        </Badge>
        <span className="hidden text-xs text-muted-foreground sm:inline">{session.gitRepoUrl}</span>

        <div className="ml-auto flex items-center gap-1">
          {session.status === "running" && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => handleAction("stop")}
              disabled={actionLoading}
            >
              <Square className="size-3" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => handleAction("restart")}
              disabled={actionLoading}
            >
              <Play className="size-3" />
              <span className="hidden sm:inline">Restart</span>
            </Button>
          )}
          {session.status === "stopped" && (
            <Button
              variant="destructive"
              size="xs"
              onClick={() => handleAction("destroy")}
              disabled={actionLoading}
            >
              <Trash2 className="size-3" />
              <span className="hidden sm:inline">Destroy</span>
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={() => setExplorerOpen(!explorerOpen)}>
            {explorerOpen ? (
              <PanelRightClose className="size-3.5" />
            ) : (
              <PanelRightOpen className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Main content — stack on mobile, side-by-side on desktop */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {/* Terminal */}
        <div
          className={
            explorerOpen ? "min-h-[200px] flex-1 border-b md:border-b-0 md:border-r" : "flex-1"
          }
        >
          <TerminalPanel sessionId={session.id} status={session.status} />
        </div>

        {/* Explorer panel — full width on mobile, fixed on desktop */}
        {explorerOpen && (
          <div className="flex w-full flex-col md:w-[480px]">
            <Tabs
              value={explorerTab}
              onValueChange={setExplorerTab}
              className="flex h-full flex-col"
            >
              <TabsList className="w-full shrink-0 justify-start border-b bg-transparent px-2">
                <TabsTrigger value="files" className="text-xs">
                  File Explorer
                </TabsTrigger>
                <TabsTrigger value="result" className="text-xs">
                  Result
                  {session.resultHtml && <span className="ml-1 size-1.5 rounded-full bg-primary" />}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="files" className="m-0 flex-1 overflow-hidden">
                <div className="flex h-full flex-col sm:flex-row">
                  <div className="w-full shrink-0 border-b sm:w-40 sm:border-b-0 sm:border-r md:w-48 overflow-auto max-h-[200px] sm:max-h-none">
                    <FileExplorer
                      sessionId={session.id}
                      onFileSelect={setSelectedFile}
                      selectedFile={selectedFile}
                    />
                  </div>
                  <div className="flex-1 overflow-auto">
                    {selectedFile ? (
                      <FileViewer sessionId={session.id} filePath={selectedFile} />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        Select a file to view
                      </div>
                    )}
                  </div>
                </div>
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
          </div>
        )}
      </div>
    </div>
  );
}
