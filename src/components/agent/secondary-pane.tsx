import type { ReactNode } from "react";
import { BrowserViewer } from "@/components/browser-viewer";
import { IdeViewer } from "@/components/ide-viewer";
import type { AgentBlueprint, AgentDetail, EffectiveEgress } from "./agent-data";
import type { SecondaryTab } from "./agent-view-bar";
import { AgentSettingsPane } from "./agent-settings-pane";
import { ArtifactsPane } from "./artifacts-pane";

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
  /** `GET /api/agents/:id/blueprint`, or null while it loads / if it fails. */
  blueprint: AgentBlueprint | null;
  /** The resolved egress policy, or null while it loads / if it fails. */
  egress: EffectiveEgress | null;
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

/**
 * The blueprint does not start this service, so there is nothing to attach to.
 *
 * `enableIde` and `enableBrowser` are real blueprint columns and both default
 * to false: a full VS Code server plus node + Playwright + Chromium alongside
 * the CLI took a 2-CPU host to load average 27. With the flag off the
 * entrypoint never starts the service, so the viewer would sit forever on a
 * connection that cannot be made and read as a bug. Naming the switch turns
 * "broken" into "off".
 *
 * Only rendered when the blueprint has actually loaded and says false — a
 * failed fetch must not hide a tab that works.
 */
function ServiceOff({ compact, service }: { compact: boolean; service: "IDE" | "Browser" }) {
  return (
    <Frame compact={compact} dark={false}>
      <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24 }}>
        <div
          style={{
            maxWidth: 380,
            textAlign: "center",
            fontSize: 12.5,
            lineHeight: 1.6,
            color: "var(--ny-text-muted)",
          }}
        >
          <strong style={{ color: "var(--ny-text)" }}>{service} is off for this blueprint.</strong>{" "}
          Its container never starts the service, so there is nothing to connect to. Turn it on in
          Settings → Blueprints and restart the agent.
        </div>
      </div>
    </Frame>
  );
}

export function SecondaryPane({
  tab,
  agent,
  blueprint,
  egress,
  compact = false,
  onDestroy,
  navigateTo,
  onNavigated,
}: SecondaryPaneProps) {
  switch (tab) {
    case "ide":
      if (blueprint && !blueprint.enableIde) return <ServiceOff compact={compact} service="IDE" />;
      return (
        <Frame compact={compact} dark>
          <IdeViewer agentId={agent.id} status={agent.status} />
        </Frame>
      );
    case "browser":
      if (blueprint && !blueprint.enableBrowser)
        return <ServiceOff compact={compact} service="Browser" />;
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
          egress={egress}
          compact={compact}
          onDestroy={onDestroy}
        />
      );
  }
}
