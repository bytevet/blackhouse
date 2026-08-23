export type PresetId = "claude-code" | "antigravity" | "codex" | "custom";

export interface AgentPreset {
  id: PresetId;
  displayName: string;
  /**
   * The process the entrypoint execs. It must be the CLI itself, never a
   * shell: container-exit has to mean agent-exit, and an injected prompt
   * landing on a `bash` prompt would be run as a shell command.
   */
  agentCommand: string;
  /**
   * Where this CLI keeps its state, and therefore where the agent's **own**
   * state volume is mounted. Per-agent and never shared — the Claude Code
   * sidecar tails `~/.claude/projects/**`, so one shared volume here would
   * hand every agent every other agent's transcript.
   */
  stateMountPath: string;
  /**
   * Extra mounts beyond the per-agent workspace and state volumes. Legitimate
   * only for credentials, which are workspace-wide by nature.
   */
  volumeMounts: { name: string; mountPath: string }[];
  dockerfilePath: string;
}

export const AGENT_PRESETS: Record<PresetId, AgentPreset> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    // `--append-system-prompt` carries the Blackhouse harness prompt (see
    // `server/agents/system-prompt.ts`). It is written into the preset rather
    // than left to the entrypoint alone so that it stays visible — and
    // editable — in the blueprint form. `agent/entrypoint.sh` appends the same
    // flag only when AGENT_COMMAND does not already mention
    // BLACKHOUSE_SYSTEM_PROMPT_FILE, which is what rescues the blueprints of
    // installs that were seeded before this existed.
    agentCommand:
      'claude --dangerously-skip-permissions --append-system-prompt "$(cat "$BLACKHOUSE_SYSTEM_PROMPT_FILE")"',
    stateMountPath: "/home/workspace/.claude",
    // `claude-auth` holds credentials only and is deliberately shared; the
    // entrypoint symlinks `~/.claude.json` out of it.
    volumeMounts: [{ name: "claude-auth", mountPath: "/home/workspace/.config/claude-auth" }],
    dockerfilePath: "agent/dockerfiles/claude-code.Dockerfile",
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    // No system-prompt flag exists on `agy`; the entrypoint delivers the
    // harness prompt as `~/.gemini/GEMINI.md` instead.
    agentCommand: "agy --dangerously-skip-permissions",
    // `agy` (Antigravity CLI) writes config + auth to `~/.gemini`, not
    // `~/.antigravity` — it inherits Gemini's config layout.
    stateMountPath: "/home/workspace/.gemini",
    volumeMounts: [],
    dockerfilePath: "agent/dockerfiles/antigravity.Dockerfile",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    // Likewise no flag; the entrypoint writes `~/.codex/AGENTS.md`.
    agentCommand: "codex --sandbox workspace-write --ask-for-approval on-request",
    stateMountPath: "/home/workspace/.codex",
    volumeMounts: [],
    dockerfilePath: "agent/dockerfiles/codex.Dockerfile",
  },
  custom: {
    id: "custom",
    displayName: "Custom",
    agentCommand: "",
    stateMountPath: "/home/workspace/.agent",
    volumeMounts: [],
    dockerfilePath: "agent/dockerfiles/claude-code.Dockerfile",
  },
};

export const PRESET_OPTIONS = Object.values(AGENT_PRESETS);
