import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Code, Eye, Trash2 } from "lucide-react";
import { Button, Dialog, Spinner, Text } from "@notyet.im/ui";
import { timeAgo } from "@/lib/time";
import { getHighlighter } from "@/lib/shiki";

interface ResultViewerProps {
  agentId: string;
  updatedAt?: string | Date;
  onDelete?: () => void;
}

export function ResultViewer({ agentId, updatedAt, onDelete }: ResultViewerProps) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sourceHtml, setSourceHtml] = useState<string | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  const resultUrl = `/api/agents/${agentId}/results/latest`;
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid var(--ny-border)",
        }}
      >
        {updatedAt && (
          <Text size="xs" tone="subtle">
            {t("result.submitted", { when: timeAgo(updatedAt) })}
          </Text>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <Button
            variant={showSource ? "primary" : "secondary"}
            size="sm"
            onClick={() => setShowSource(!showSource)}
            iconStart={showSource ? <Code size={13} /> : <Eye size={13} />}
          >
            {showSource ? t("result.source") : t("result.preview")}
          </Button>
          {onDelete && (
            <Button
              iconOnly
              label={t("result.delete")}
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>

      {showSource ? (
        loadingSource && !highlightedHtml && !sourceHtml ? (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            <Spinner label={t("common.loading")} />
          </div>
        ) : highlightedHtml ? (
          <div
            className="bh-scroll line-numbers"
            style={{ flex: 1, minHeight: 0, overflow: "auto" }}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre
            className="bh-scroll"
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              margin: 0,
              padding: 12,
              fontFamily: "var(--ny-font-mono)",
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--ny-text)",
            }}
          >
            {sourceHtml}
          </pre>
        )
      ) : (
        /* The artifact is agent-authored HTML: it renders in a sandboxed frame
         * on a white ground regardless of theme, since it carries no `--ny-*`
         * tokens of its own and would otherwise be unreadable in dark mode. */
        <iframe
          src={`${resultUrl}?t=${cacheBuster}`}
          sandbox="allow-scripts allow-same-origin"
          style={{ flex: 1, minHeight: 0, border: 0, background: "#fff" }}
          title="Agent result"
        />
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("result.delete")}
        description={t("result.confirmDelete")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                onDelete?.();
              }}
            >
              {t("common.delete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
