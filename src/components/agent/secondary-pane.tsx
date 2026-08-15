import type { ReactNode } from "react";
import { BrowserViewer } from "@/components/browser-viewer";
import { IdeViewer } from "@/components/ide-viewer";
import type { AgentDetail } from "./agent-data";
import type { SecondaryTab } from "./agent-view-bar";
import { AgentSettingsPane } from "./agent-settings-pane";
import { ArtifactsPane } from "./artifacts-pane";
import type { MockBlueprint } from "./mock-data";

/**
 * Everything that is not the terminal: the IDE, the headless browser, the
 * artifacts grid, and the agent's own settings.
 *
 * One component rather than four call sites because both modes need the same
 * switch — single-pane renders it full width, split renders it on the right —
 * and the only difference between them is inset. `compact` carries that.
 *
 * The IDE and browser viewers are owned by the viewer port; their contract
 * after it is `agentId` + `status`.
 */
export interface SecondaryPaneProps {
  tab: SecondaryTab;
  agent: AgentDetail;
  /** ⚠️ mock — see `mock-data.ts`. */
  blueprint: MockBlueprint;
  /** Split mode: no outer inset, no rounded frame. */
  compact?: boolean;
  onDestroy: () => void;
  /** One-shot URL for the embedded browser — see `BrowserViewer`. */
  navigateTo?: string | null;
  onNavigated?: () => void;
}

/** The dark, chrome-less frame the IDE and browser sit in. */
function Frame({
  compact,
  dark,
  children,
}: {
  compact: boolean;
  dark: boolean;
  children: ReactNode;
}) {
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
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: dark ? "var(--ny-ink-0)" : "var(--ny-surface)",
          border: compact
            ? undefined
            : `1px solid ${dark ? "var(--ny-ink-4)" : "var(--ny-border)"}`,
          borderRadius: compact ? 0 : 12,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function SecondaryPane({
  tab,
  agent,
  blueprint,
  compact = false,
  onDestroy,
  navigateTo,
  onNavigated,
}: SecondaryPaneProps) {
  switch (tab) {
    case "ide":
      return (
        <Frame compact={compact} dark>
          <IdeViewer agentId={agent.id} status={agent.status} />
        </Frame>
      );
    case "browser":
      return (
        <Frame compact={compact} dark={false}>
          <BrowserViewer
            agentId={agent.id}
            status={agent.status}
            navigateTo={navigateTo}
            onNavigated={onNavigated}
          />
        </Frame>
      );
    case "artifacts":
      return <ArtifactsPane agent={agent} compact={compact} />;
    case "settings":
      return (
        <AgentSettingsPane
          agent={agent}
          blueprint={blueprint}
          compact={compact}
          onDestroy={onDestroy}
        />
      );
  }
}
