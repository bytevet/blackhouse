import { AgentAvatar } from "./agent-avatar";
import { ArtifactCard } from "./artifact-card";
import { clockTime } from "./format";
import { Markdown } from "./markdown";
import type { AgentView, ArtifactView } from "./types";

/**
 * An agent's prose reply — the one kind of agent output that gets full-width
 * rich text.
 *
 * The `agent` badge next to the handle is not decoration. In a room where
 * humans and agents post side by side, "who said this" changes how much you
 * trust it, and the badge has to survive skimming: mono, bordered, always in
 * the same position relative to the handle.
 */
export function MessageAgentText({
  agent,
  createdAt,
  body,
  artifact,
}: {
  agent: AgentView;
  createdAt: Date;
  body: string;
  artifact?: ArtifactView;
}) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 8px", borderRadius: 10 }}>
      <AgentAvatar agent={agent} size={38} surface="var(--ny-bg)" emphasis />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontFamily: "var(--ny-font-mono)",
              fontWeight: 700,
              fontSize: 14,
              color: "var(--ny-text)",
            }}
          >
            @{agent.handle}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: "var(--ny-font-mono)",
              color: "var(--ny-accent-text)",
              border: "1px solid var(--ny-accent-border)",
              background: "var(--ny-accent-subtle)",
              borderRadius: 5,
              padding: "0 5px",
            }}
          >
            agent
          </span>
          <time
            dateTime={createdAt.toISOString()}
            style={{
              fontSize: 11,
              color: "var(--ny-text-subtle)",
              fontFamily: "var(--ny-font-mono)",
            }}
          >
            {clockTime(createdAt)}
          </time>
        </div>

        <div style={{ marginTop: 5, overflowWrap: "anywhere" }}>
          <Markdown source={body} />
        </div>

        {artifact && <ArtifactCard artifact={artifact} />}
      </div>
    </div>
  );
}
