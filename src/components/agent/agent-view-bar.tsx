import { Switch, Tabs, Tooltip } from "@notyet.im/ui";
import { Pin } from "lucide-react";

/** The five views. `terminal` is the marquee one and always the left pane. */
export const AGENT_TABS = ["terminal", "ide", "browser", "artifacts", "settings"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
/** What the right-hand pane can show. Terminal is excluded — it is the left pane. */
export type SecondaryTab = Exclude<AgentTab, "terminal">;

const TAB_LABELS: Record<AgentTab, string> = {
  terminal: "Terminal",
  ide: "IDE",
  browser: "Browser",
  artifacts: "Artifacts",
  settings: "Settings",
};

export interface AgentViewBarProps {
  tab: AgentTab;
  rightTab: SecondaryTab;
  split: boolean;
  /** False when the viewport is too narrow to make two panes usable. */
  splitAvailable: boolean;
  onTabChange: (tab: AgentTab) => void;
  onRightTabChange: (tab: SecondaryTab) => void;
  onSplitChange: (split: boolean) => void;
}

/**
 * Tab strip plus the split toggle.
 *
 * One strip serves both modes, as in the prototype. Single-pane, it selects
 * the whole view. Split, the terminal is pinned to the left pane — its tab
 * goes inert and picks up a pin glyph — and the same strip now selects what
 * the *right* pane shows. Two strips would have been more literal and worse:
 * the user's mental model is "which view am I looking at", and that question
 * has exactly one answer in either mode.
 */
export function AgentViewBar({
  tab,
  rightTab,
  split,
  splitAvailable,
  onTabChange,
  onRightTabChange,
  onSplitChange,
}: AgentViewBarProps) {
  const items = AGENT_TABS.map((value) => {
    if (value === "terminal" && split) {
      return {
        value,
        disabled: true,
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Pin size={12} strokeWidth={2} aria-hidden="true" />
            {TAB_LABELS.terminal}
          </span>
        ),
      };
    }
    return { value, label: TAB_LABELS[value] };
  });

  const value: AgentTab = split ? rightTab : tab;

  function handleChange(next: AgentTab) {
    if (!split) {
      onTabChange(next);
      return;
    }
    // The terminal item is disabled in split mode, but guard anyway: a
    // keyboard roving-focus implementation could still emit it.
    if (next === "terminal") return;
    onRightTabChange(next);
  }

  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        gap: 16,
        padding: "0 20px",
        borderBottom: "1px solid var(--ny-border)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, paddingTop: 6 }}>
        <Tabs
          items={items}
          value={value}
          onChange={handleChange}
          label={split ? "Right pane view" : "Agent view"}
          panelId="agent-view-panel"
        />
      </div>
      {splitAvailable && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, alignSelf: "stretch" }}>
          <Tooltip
            content={
              split
                ? "Collapse back to a single pane"
                : "Terminal on the left, a second view on the right"
            }
          >
            <span style={{ display: "inline-flex" }}>
              <Switch size="sm" checked={split} onChange={onSplitChange} label="Split" />
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
