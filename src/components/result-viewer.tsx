import { useState, useEffect, useRef } from "react";
import { Code, Eye, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { timeAgo } from "@/lib/time";
import type { Highlighter, ShikiTransformer } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

const stripPreBg: ShikiTransformer = {
  pre(node) {
    delete node.properties.style;
  },
};

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: ["html"],
      }),
    );
  }
  return highlighterPromise;
}

interface ResultViewerProps {
  html: string;
  updatedAt?: Date;
  onDelete?: () => void;
}

export function ResultViewer({ html, updatedAt, onDelete }: ResultViewerProps) {
  const [showSource, setShowSource] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

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
          transformers: [stripPreBg],
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
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="destructive" size="xs">
                    <Trash2 className="size-3" />
                  </Button>
                }
              />
              <PopoverContent className="w-auto space-y-2 p-3">
                <p className="text-xs text-muted-foreground">Delete this result?</p>
                <Button variant="destructive" size="xs" onClick={onDelete}>
                  Confirm
                </Button>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
      {showSource ? (
        highlightedHtml ? (
          <div
            className="flex-1 overflow-auto [&_pre]:bg-transparent [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed [&_code]:text-xs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-foreground">
            {html}
          </pre>
        )
      ) : (
        <iframe
          srcDoc={html}
          sandbox="allow-scripts"
          className="flex-1 border-0 bg-white"
          title="Session Result"
        />
      )}
    </div>
  );
}
