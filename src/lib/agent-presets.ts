export type PresetId = "claude-code" | "gemini" | "codex" | "custom";

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
  gemini: {
    id: "gemini",
    displayName: "Gemini",
    agentCommand: "gemini --yolo",
    volumeMounts: [{ name: "gemini-config", mountPath: "/home/workspace/.gemini" }],
    dockerfilePath: "agent/dockerfiles/gemini.Dockerfile",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    agentCommand: "codex --full-auto",
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
