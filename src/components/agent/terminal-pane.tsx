import { useRef, useState } from "react";
import { TerminalPanel } from "@/components/terminal";
import type { AgentBlueprint, AgentDetail } from "./agent-data";

/**
 * The terminal, in its window chrome.
 *
 * This is the marquee surface of the whole product — a real CLI on a real PTY
 * — so it gets a frame that reads as an application window rather than a
 * debug drawer: traffic lights, the container's short id, and a live attach
 * indicator. In split mode the chrome collapses to nothing (matching the
 * prototype) because at 26–50% width every pixel of the grid counts.
 *
 * `TerminalPanel` itself is owned by the viewer port; this only ever wraps it.
 */
export interface TerminalPaneProps {
  agent: AgentDetail;
  /**
   * Supplies the CLI name in the title bar. Null while it loads or if the
   * fetch fails, in which case the title is simply shorter — it used to carry
   * an invented shell name (`zsh`/`bash` picked by hashing the blueprint id)
   * alongside an invented CLI, and a missing word beats a wrong one.
   */
  blueprint: AgentBlueprint | null;
  /** Split mode: drop the chrome and the frame inset. */
  compact?: boolean;
  /** The red light is a real stop — it routes to the same confirmation. */
  onStopClick: () => void;
  /**
   * A URL was clicked in the terminal output. Provided so it opens in the
   * agent's own headless browser rather than in a new tab of the operator's —
   * `localhost:3000` means something different inside the sandbox.
   */
  onLinkClick?: (url: string) => void;
}

/** `f7a3…` — enough of the container id to match against `docker ps`. */
function shortContainerId(containerId: string | null): string | null {
  return containerId ? containerId.slice(0, 12) : null;
}

export function TerminalPane({
  agent,
  blueprint,
  compact = false,
  onStopClick,
  onLinkClick,
}: TerminalPaneProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const attached = agent.status === "running";

  function toggleFullscreen() {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().then(() => setFullscreen(false));
    } else {
      void el.requestFullscreen?.().then(
        () => setFullscreen(true),
        () => setFullscreen(false),
      );
    }
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: compact ? 0 : "16px 20px",
      }}
    >
      <div
        ref={frameRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--ny-ink-0)",
          border: compact ? undefined : "1px solid var(--ny-ink-4)",
          borderRadius: compact ? 0 : 12,
        }}
      >
        {!compact && (
          <div
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 14px",
              background: "var(--ny-ink-1)",
              borderBottom: "1px solid var(--ny-ink-4)",
            }}
          >
            <div style={{ display: "flex", gap: 7 }}>
              <button
                type="button"
                onClick={onStopClick}
                aria-label="Stop agent"
                title="Stop · ends the terminal session"
                style={lightStyle("#ff5f57")}
              />
              <span
                aria-hidden="true"
                title="Minimize — unavailable"
                style={{ ...lightStyle("#febc2e"), opacity: 0.32, cursor: "not-allowed" }}
              />
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen terminal"}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                style={lightStyle("#28c840")}
              />
            </div>
            <span
              style={{
                fontFamily: "var(--ny-font-mono)",
                fontSize: 12,
                color: "var(--ny-ink-7)",
                marginLeft: 6,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {[shortContainerId(agent.containerId) ?? `agent-${agent.handle}`, blueprint?.cli]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontFamily: "var(--ny-font-mono)",
                fontSize: 11,
                marginLeft: 4,
                color: attached ? "#28c840" : "var(--ny-ink-6)",
              }}
            >
              <span
                className="bh-pulse"
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: attached ? "#28c840" : "var(--ny-ink-5)",
                  animation: attached ? "bhPulse 1.8s ease-in-out infinite" : undefined,
                }}
              />
              {attached ? "attached" : "detached"}
            </span>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0 }}>
          {/* Contract after the viewer port: `agentId` + `status`. */}
          <TerminalPanel agentId={agent.id} status={agent.status} onLinkClick={onLinkClick} />
        </div>
      </div>
    </div>
  );
}

function lightStyle(color: string): React.CSSProperties {
  return {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: color,
    border: "none",
    padding: 0,
    cursor: "pointer",
    flex: "none",
  };
}
