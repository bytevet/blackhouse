export type PresetId = "claude-code" | "antigravity" | "codex" | "custom";

export interface AgentPreset {
  id: PresetId;
  displayName: string;
  agentCommand: string;
  volumeMounts: { name: string; mountPath: string }[];
  dockerfilePath: string;
}

export const AGENT_PRESETS: Record<PresetId, AgentPreset> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    agentCommand: "claude --dangerously-skip-permissions",
    volumeMounts: [
      { name: "claude-config", mountPath: "/home/workspace/.claude" },
      { name: "claude-auth", mountPath: "/home/workspace/.config/claude-auth" },
    ],
    dockerfilePath: "agent/dockerfiles/claude-code.Dockerfile",
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    agentCommand: "agy --dangerously-skip-permissions",
    // `agy` (Antigravity CLI) writes config + auth to `~/.gemini`, not
    // `~/.antigravity` — it inherits Gemini's config layout. Volume name
    // stays `antigravity-config` (it's just the named-volume identifier).
    volumeMounts: [{ name: "antigravity-config", mountPath: "/home/workspace/.gemini" }],
    dockerfilePath: "agent/dockerfiles/antigravity.Dockerfile",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    agentCommand: "codex --sandbox workspace-write --ask-for-approval on-request",
    volumeMounts: [{ name: "codex-config", mountPath: "/home/workspace/.codex" }],
    dockerfilePath: "agent/dockerfiles/codex.Dockerfile",
  },
  custom: {
    id: "custom",
    displayName: "Custom",
    agentCommand: "",
    volumeMounts: [],
    dockerfilePath: "agent/dockerfiles/claude-code.Dockerfile",
  },
};

export const PRESET_OPTIONS = Object.values(AGENT_PRESETS);
