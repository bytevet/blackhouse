import { useId, useState } from "react";
import { AppWindow, FileText, Link2, Maximize2, Type } from "lucide-react";
import type { ArtifactKind } from "@/db/schema";
import { toneTextVar } from "@/lib/agent-status";
import { fileSize } from "./format";
import type { ArtifactPreviewNode, ArtifactView } from "./types";

const KIND_ICON: Record<ArtifactKind, typeof AppWindow> = {
  html: AppWindow,
  file: FileText,
  link: Link2,
  text: Type,
};

/**
 * An artifact posted into the channel — the replacement for the old result
 * pane. Header plus a live mini-preview that **expands in place**, 150px to
 * 300px, rather than opening a modal.
 *
 * Expanding in place is the whole point: an artifact is a piece of the
 * conversation, and a modal would take you out of the conversation to look at
 * something the message you are reading is about. The full-pane escape hatch
 * stays available for when you really do want to leave.
 */
export function ArtifactCard({
  artifact,
  onOpenFull,
}: {
  artifact: ArtifactView;
  onOpenFull?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const Icon = KIND_ICON[artifact.kind];

  return (
    <div
      style={{
        marginTop: 12,
        border: "1px solid var(--ny-border)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--ny-surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 12px",
          borderBottom: "1px solid var(--ny-border)",
          background: "var(--ny-surface-sunken)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            flex: "none",
            borderRadius: 6,
            display: "grid",
            placeItems: "center",
            background: "var(--ny-info-subtle)",
            color: "var(--ny-info-text)",
          }}
        >
          <Icon size={13} strokeWidth={2} />
        </span>
        <div style={{ flex: 1, minWidth: 120 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {artifact.title ?? "untitled artifact"}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
            }}
          >
            artifact · {artifact.description} · {fileSize(artifact.sizeBytes)}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-info-text)",
            border: "1px solid var(--ny-info-border)",
            background: "var(--ny-info-subtle)",
            borderRadius: 5,
            padding: "1px 6px",
          }}
        >
          preview
        </span>
        <button
          type="button"
          className="bh-reset bh-hover bh-focusable"
          aria-expanded={expanded}
          aria-controls={previewId}
          onClick={() => {
            if (expanded && onOpenFull) onOpenFull();
            setExpanded((v) => !v);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontFamily: "var(--ny-font-mono)",
            color: "var(--ny-text-muted)",
            cursor: "pointer",
            padding: "3px 7px",
            borderRadius: 6,
          }}
        >
          <Maximize2 size={13} strokeWidth={2} />
          {expanded ? "collapse" : "expand"}
        </button>
      </div>

      <div
        id={previewId}
        style={{
          height: expanded ? 300 : 150,
          transition: "height 200ms var(--ny-ease-standard, ease)",
          overflow: "hidden",
        }}
      >
        <ArtifactPreview nodes={artifact.previewNodes} />
      </div>
    </div>
  );
}

/**
 * Stand-in for the rendered artifact. When the real viewer lands this becomes
 * a sandboxed iframe; the card's geometry and expand behaviour do not change.
 */
function ArtifactPreview({ nodes }: { nodes: ArtifactPreviewNode[] }) {
  return (
    <div
      style={{
        height: "100%",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
        background:
          "radial-gradient(circle at 20% 10%, var(--ny-surface-hover), var(--ny-surface))",
      }}
    >
      {nodes.map((node, i) =>
        node.depth === 0 ? (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              aria-hidden
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: node.tone === "accent" ? "var(--ny-accent)" : `var(--ny-${node.tone})`,
              }}
            />
            <span
              style={{
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11,
                color: "var(--ny-text-muted)",
              }}
            >
              {node.label}
            </span>
          </div>
        ) : (
          <div key={i} style={{ paddingLeft: node.depth * 16 }}>
            <PreviewChip node={node} />
          </div>
        ),
      )}
    </div>
  );
}

function PreviewChip({ node }: { node: ArtifactPreviewNode }) {
  const neutral = node.tone === "neutral";
  const color = node.tone === "accent" ? "var(--ny-accent-text)" : toneTextVar(node.tone);
  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: "var(--ny-font-mono)",
        fontSize: 11,
        color: neutral ? "var(--ny-text-subtle)" : color,
        border: `1px solid ${neutral ? "var(--ny-border)" : `var(--ny-${node.tone}-border)`}`,
        background: neutral ? "transparent" : `var(--ny-${node.tone}-subtle)`,
        borderRadius: 6,
        padding: "3px 8px",
        marginRight: 10,
      }}
    >
      {node.label}
    </span>
  );
}
