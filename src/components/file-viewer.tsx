import { useState, useEffect, useRef } from "react";
import type { Highlighter, ShikiTransformer } from "shiki";
import { FileCode, GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

let highlighterPromise: Promise<Highlighter> | null = null;

const stripPreBackground: ShikiTransformer = {
  pre(node) {
    delete node.properties.style;
  },
};

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [
          "javascript",
          "typescript",
          "jsx",
          "tsx",
          "json",
          "html",
          "css",
          "markdown",
          "python",
          "bash",
          "yaml",
          "toml",
          "sql",
          "rust",
          "go",
          "dockerfile",
          "diff",
        ],
      }),
    );
  }
  return highlighterPromise;
}

const EXT_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  rs: "rust",
  go: "go",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
};

function getLang(filePath: string): string | undefined {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  const ext = name.split(".").pop() ?? "";
  return EXT_LANG[ext];
}

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
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
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
        const [fileContent, fileDiff] = await Promise.all([
          api.get<string>(
            `/files/read?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
          ),
          api
            .get<string>(
              `/files/diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
            )
            .catch(() => null),
        ]);

        if (!cancelled) {
          contentRef.current = fileContent;
          diffRef.current = fileDiff;
          setContent(fileContent);
          setDiff(fileDiff);
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
        const [newContent, newDiff] = await Promise.all([
          api.get<string>(
            `/files/read?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
          ),
          api
            .get<string>(
              `/files/diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(filePath)}`,
            )
            .catch(() => null),
        ]);

        const nc = newContent;
        const nd = newDiff;

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

  useEffect(() => {
    const source = showDiff && diff ? diff : content;
    if (!source) {
      setHighlightedHtml(null);
      return;
    }
    const lang = showDiff ? "diff" : getLang(filePath);
    if (!lang) {
      setHighlightedHtml(null);
      return;
    }
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        const html = hl.codeToHtml(source, {
          lang,
          themes: { dark: "github-dark", light: "github-light" },
          defaultColor: false,
          transformers: [stripPreBackground],
        });
        setHighlightedHtml(html);
      })
      .catch(() => setHighlightedHtml(null));
    return () => {
      cancelled = true;
    };
  }, [content, diff, filePath, showDiff]);

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
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{filePath}</span>
        {diff !== null && (
          <Button
            variant={showDiff ? "default" : "outline"}
            size="xs"
            onClick={() => setShowDiff(!showDiff)}
          >
            {showDiff ? (
              <>
                <GitCompareArrows className="size-3" />
                Diff
              </>
            ) : (
              <>
                <FileCode className="size-3" />
                Plain
              </>
            )}
          </Button>
        )}
      </div>
      {highlightedHtml ? (
        <div
          className={cn(
            "flex-1 overflow-auto [&_pre]:bg-transparent [&_pre]:leading-relaxed",
            showDiff ? "p-2" : "line-numbers",
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto text-xs leading-relaxed">
          {displayContent && <LineNumberedContent content={displayContent} isDiff={showDiff} />}
        </div>
      )}
    </div>
  );
}

function LineNumberedContent({ content, isDiff }: { content: string; isDiff: boolean }) {
  const lines = content.split("\n");
  return (
    <table className="w-full border-collapse">
      <tbody>
        {lines.map((line, i) => {
          let lineClass = "text-foreground";
          if (isDiff) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              lineClass = "bg-green-500/10 text-green-600 dark:text-green-400";
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              lineClass = "bg-red-500/10 text-red-600 dark:text-red-400";
            } else if (line.startsWith("@@")) {
              lineClass = "text-blue-500";
            }
          }
          return (
            <tr key={i}>
              {!isDiff && (
                <td className="w-8 select-none text-right align-middle text-muted-foreground/50">
                  {i + 1}
                </td>
              )}
              <td className={cn("pl-2", lineClass)}>
                <pre className="whitespace-pre-wrap">{line || "\n"}</pre>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
