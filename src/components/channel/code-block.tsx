import { useEffect, useState } from "react";
import type { ThemedToken } from "@shikijs/core";
import { getHighlighter } from "@/lib/shiki";
import { useAppTheme } from "@/components/theme-provider";

/**
 * A fenced code block from an agent's prose reply.
 *
 * Highlighting goes through `codeToTokensBase` rather than `codeToHtml` so we
 * render React nodes and keep the container on `--ny-*` tokens — Shiki's own
 * `<pre>` carries a hard-coded background that would punch a GitHub-coloured
 * hole in both themes. Only the token colours come from the highlighter.
 *
 * Unhighlighted plain text is the first paint and the permanent fallback:
 * loading a highlighter must never be what stands between a reader and the
 * code an agent just wrote.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { theme } = useAppTheme();
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!lang) {
      setLines(null);
      return;
    }
    (async () => {
      try {
        const highlighter = await getHighlighter();
        if (cancelled) return;
        // The bundle carries a fixed language set; anything else stays plain.
        if (!highlighter.getLoadedLanguages().includes(lang)) return;
        const tokens = highlighter.codeToTokensBase(code.replace(/\n$/, ""), {
          lang,
          theme: theme === "dark" ? "github-dark" : "github-light",
        });
        if (!cancelled) setLines(tokens);
      } catch {
        if (!cancelled) setLines(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return (
    <pre
      className="bh-scroll"
      style={{
        margin: 0,
        fontFamily: "var(--ny-font-mono)",
        fontSize: 12.5,
        lineHeight: 1.6,
        background: "var(--ny-surface-sunken)",
        border: "1px solid var(--ny-border)",
        borderRadius: 9,
        padding: "12px 14px",
        overflowX: "auto",
        color: "var(--ny-text)",
      }}
    >
      <code>
        {lines
          ? lines.map((line, i) => (
              <span key={i}>
                {line.map((token, j) => (
                  <span key={j} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {"\n"}
              </span>
            ))
          : code.replace(/\n$/, "")}
      </code>
    </pre>
  );
}
