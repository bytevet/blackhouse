import { useState, useEffect, useRef } from "react";
import { Code, Eye, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/time";
import { getHighlighter } from "@/lib/shiki";

interface ResultViewerProps {
  sessionId: string;
  updatedAt?: string | Date;
  onDelete?: () => void;
}

export function ResultViewer({ sessionId, updatedAt, onDelete }: ResultViewerProps) {
  const [showSource, setShowSource] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const resultUrl = `/api/sessions/${sessionId}/results/latest`;
  const stableFallback = useRef(Date.now());
  const cacheBuster = updatedAt ? new Date(updatedAt).getTime() : stableFallback.current;

  // Invalidate cached source when result updates
  const prevUpdatedAt = useRef(cacheBuster);
  if (prevUpdatedAt.current !== cacheBuster) {
    prevUpdatedAt.current = cacheBuster;
    setSourceHtml(null);
    setHighlightedHtml(null);
  }

  useEffect(() => {
    if (!showSource) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;

    (async () => {
      // Fetch raw HTML if not cached
      let raw = sourceHtml;
      if (!raw) {
        setLoadingSource(true);
        try {
          const res = await fetch(resultUrl);
          raw = await res.text();
          if (!cancelled) setSourceHtml(raw);
        } catch {
          if (!cancelled) setLoadingSource(false);
          return;
        }
      }

      // Syntax highlight
      try {
        const hl = await getHighlighter();
        if (cancelled) return;
        const result = hl.codeToHtml(raw, {
          lang: "html",
          themes: { dark: "github-dark", light: "github-light" },
          defaultColor: false,
        });
        setHighlightedHtml(result);
      } catch {
        setHighlightedHtml(null);
      }
      if (!cancelled) setLoadingSource(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [showSource, resultUrl, sourceHtml]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        {updatedAt && (
          <span className="text-xs text-muted-foreground">Submitted {timeAgo(updatedAt)}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={showSource ? "default" : "outline"}
            size="xs"
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? (
              <>
                <Code className="size-3" />
                Source
              </>
            ) : (
              <>
                <Eye className="size-3" />
                Preview
              </>
            )}
          </Button>
          {onDelete && (
            <Button
              variant="destructive"
              size="xs"
              onClick={() => {
                if (confirmDelete) {
                  onDelete();
                  setConfirmDelete(false);
                } else {
                  setConfirmDelete(true);
                  setTimeout(() => setConfirmDelete(false), 3000);
                }
              }}
            >
              <Trash2 className="size-3" />
              {confirmDelete && "Confirm?"}
            </Button>
          )}
        </div>
      </div>
      {showSource ? (
        loadingSource && !highlightedHtml && !sourceHtml ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : highlightedHtml ? (
          <div
            className="flex-1 overflow-auto"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-foreground">
            {sourceHtml}
          </pre>
        )
      ) : (
        <iframe
          src={`${resultUrl}?t=${cacheBuster}`}
          sandbox="allow-scripts allow-same-origin"
          className="flex-1 border-0 bg-white"
          title="Session Result"
        />
      )}
    </div>
  );
}
