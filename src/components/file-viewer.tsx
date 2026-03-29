import { useState, useEffect, useRef } from "react";

interface FileViewerProps {
  sessionId: string;
  filePath: string;
  status?: string;
}

export function FileViewer({ sessionId, filePath, status }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const contentRef = useRef<string | null>(null);
  const diffRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFile() {
      setLoading(true);
      setContent(null);
      setDiff(null);
      contentRef.current = null;
      diffRef.current = null;

      try {
        const { readFile, getFileDiff } = await import("@/server/files");

        const [fileContent, fileDiff] = await Promise.all([
          readFile({ data: { sessionId, path: filePath } }),
          getFileDiff({ data: { sessionId, path: filePath } }).catch(() => null),
        ]);

        if (!cancelled) {
          contentRef.current = fileContent as string;
          diffRef.current = fileDiff as string | null;
          setContent(fileContent as string);
          setDiff(fileDiff as string | null);
          setShowDiff(!!fileDiff);
        }
      } catch {
        if (!cancelled) {
          setContent("Failed to load file");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFile();
    return () => {
      cancelled = true;
    };
  }, [sessionId, filePath]);

  // Poll for content changes when session is running
  useEffect(() => {
    if (status !== "running" || !filePath) return;

    const poll = async () => {
      try {
        const { readFile, getFileDiff } = await import("@/server/files");
        const [newContent, newDiff] = await Promise.all([
          readFile({ data: { sessionId, path: filePath } }),
          getFileDiff({ data: { sessionId, path: filePath } }).catch(() => null),
        ]);

        const nc = newContent as string;
        const nd = newDiff as string | null;

        if (nc !== contentRef.current) {
          contentRef.current = nc;
          setContent(nc);
        }
        if (nd !== diffRef.current) {
          diffRef.current = nd;
          setDiff(nd);
        }
      } catch {
        // ignore polling errors
      }
    };

    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [status, sessionId, filePath]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  const displayContent = showDiff && diff ? diff : content;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">{filePath}</span>
        {diff && (
          <button
            type="button"
            onClick={() => setShowDiff(!showDiff)}
            className="shrink-0 text-[10px] text-primary hover:underline"
          >
            {showDiff ? "Show file" : "Show diff"}
          </button>
        )}
      </div>
      <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-foreground">
        {displayContent && renderContent(displayContent, showDiff)}
      </pre>
    </div>
  );
}

function renderContent(content: string, isDiff: boolean) {
  if (!isDiff) return content;

  return content.split("\n").map((line, i) => {
    let className = "";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      className = "bg-green-500/10 text-green-600 dark:text-green-400";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      className = "bg-red-500/10 text-red-600 dark:text-red-400";
    } else if (line.startsWith("@@")) {
      className = "text-blue-500";
    }

    return (
      <div key={i} className={className}>
        {line}
      </div>
    );
  });
}
