import { useState, useEffect } from "react";
import { Code, Eye, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/time";
import { getHighlighter } from "@/lib/shiki";

interface ResultViewerProps {
  sessionId: string;
  html: string;
  updatedAt?: string | Date;
  onDelete?: () => void;
}

export function ResultViewer({ sessionId, html, updatedAt, onDelete }: ResultViewerProps) {
  const [showSource, setShowSource] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  const resultUrl = `/api/sessions/${sessionId}/results/latest`;
  const cacheBuster = updatedAt ? new Date(updatedAt).getTime() : Date.now();

  useEffect(() => {
    if (!showSource) {
      setHighlightedHtml(null);
      return;
    }
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        const result = hl.codeToHtml(html, {
          lang: "html",
          themes: { dark: "github-dark", light: "github-light" },
          defaultColor: false,
        });
        setHighlightedHtml(result);
      })
      .catch(() => setHighlightedHtml(null));
    return () => {
      cancelled = true;
    };
  }, [html, showSource]);

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
        highlightedHtml ? (
          <div
            className="flex-1 overflow-auto"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-foreground">
            {html}
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
