import { useState, useEffect, useRef } from "react";
import type { Highlighter, ShikiTransformer } from "shiki";
import { FileCode, GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";

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
          className="flex-1 overflow-auto [&_pre]:bg-transparent [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-relaxed [&_code]:text-xs"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="flex-1 overflow-auto p-3 text-xs leading-relaxed text-foreground">
          {displayContent && renderContent(displayContent, showDiff)}
        </pre>
      )}
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
