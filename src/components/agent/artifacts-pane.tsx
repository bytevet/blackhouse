import { useState } from "react";
import { Badge, Button } from "@notyet.im/ui";
import { AppWindow, ChevronLeft } from "lucide-react";
import { ResultViewer } from "@/components/result-viewer";
import type { AgentDetail } from "./agent-data";
import { MOCK_ARTIFACTS, MOCK_NOTICE } from "./mock-data";

/**
 * What the agent has produced for humans to read.
 *
 * There is no artifacts endpoint yet (`server/api/` has agents, auth, settings
 * and skills), so the grid is placeholder data from `mock-data.ts` — with one
 * genuine entry: the agent's latest submitted HTML result, which
 * `ResultViewer` already fetches. That one is labelled `live`; every other
 * card says plainly that it has no bytes behind it, rather than opening onto a
 * convincing but fabricated preview.
 */
export interface ArtifactsPaneProps {
  agent: AgentDetail;
  /** Split mode: tighter insets. */
  compact?: boolean;
}

export function ArtifactsPane({ agent, compact = false }: ArtifactsPaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = MOCK_ARTIFACTS.find((artifact) => artifact.id === selectedId) ?? null;
  const padding = compact ? "16px 18px" : "20px";

  if (selected) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding,
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedId(null)}
            iconStart={<ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />}
          >
            All artifacts
          </Button>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ny-text)" }}>
            {selected.name}
          </span>
          {!selected.live && (
            <Badge tone="neutral" variant="outline" size="sm">
              placeholder
            </Badge>
          )}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            border: "1px solid var(--ny-border)",
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--ny-surface)",
          }}
        >
          {selected.live ? (
            // Contract after the viewer port: `agentId`.
            <ResultViewer agentId={agent.id} updatedAt={agent.updatedAt} />
          ) : (
            <div
              style={{
                height: "100%",
                display: "grid",
                placeItems: "center",
                padding: 24,
                textAlign: "center",
                color: "var(--ny-text-subtle)",
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              <div style={{ maxWidth: 420 }}>
                <AppWindow size={22} strokeWidth={1.8} aria-hidden="true" />
                <div style={{ marginTop: 10 }}>
                  {MOCK_NOTICE} Artifact history needs{" "}
                  <code style={{ fontFamily: "var(--ny-font-mono)" }}>
                    GET /api/agents/:id/artifacts
                  </code>
                  .
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bh-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))",
          gap: 16,
          maxWidth: 1100,
        }}
      >
        {MOCK_ARTIFACTS.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => setSelectedId(artifact.id)}
            style={{
              border: "1px solid var(--ny-border)",
              borderRadius: 12,
              overflow: "hidden",
              background: "var(--ny-surface)",
              padding: 0,
              textAlign: "left",
              cursor: "pointer",
              color: "inherit",
              font: "inherit",
              display: "block",
            }}
          >
            <div
              style={{
                height: 120,
                background: "var(--ny-surface-sunken)",
                display: "grid",
                placeItems: "center",
                borderBottom: "1px solid var(--ny-border)",
                color: `var(--ny-${artifact.tone === "neutral" ? "text-subtle" : `${artifact.tone}-text`})`,
              }}
            >
              <AppWindow size={22} strokeWidth={1.8} aria-hidden="true" />
            </div>
            <div style={{ padding: "11px 13px" }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ny-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {artifact.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ny-text-subtle)",
                  fontFamily: "var(--ny-font-mono)",
                  marginTop: 3,
                }}
              >
                {artifact.meta}
              </div>
            </div>
          </button>
        ))}
      </div>
      <p
        style={{
          marginTop: 16,
          fontSize: 11.5,
          color: "var(--ny-text-subtle)",
          maxWidth: 1100,
        }}
      >
        Only “Latest result” is live. {MOCK_NOTICE}
      </p>
    </div>
  );
}
