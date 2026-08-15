/**
 * Per-adapter injection + idle profiles.
 *
 * Every timing constant and control byte used when typing into a live TUI
 * lives here, keyed by CLI adapter. They are deliberately NOT global
 * constants: the interrupt key is Claude Code's binding, Codex and
 * Antigravity differ, and the paste-coalescing timers each Ink app uses are
 * empirically different. Tuning one CLI must not silently retune the others.
 *
 * Values marked "unverified" below still need to be checked against a real
 * container on a real host — see the plan's open risk #1 (injecting into a
 * TUI is the riskiest thing in the refactor).
 */

/** Adapter keys mirror `agent_blueprints.cli`. */
export type AdapterKey = "claude-code" | "codex" | "antigravity" | "custom" | "mock";

export interface AdapterProfile {
  /** Adapter key this profile belongs to. */
  id: AdapterKey;
  /** Human label, for UI/debug output. */
  label: string;

  // --- injection ------------------------------------------------------------

  /**
   * Bytes that stop the agent's current turn in `interrupt` mode.
   * Default is ESC (0x1b) — Claude Code's binding.
   */
  interruptBytes: Buffer;
  /** Bytes that submit the composer. Default CR (0x0d). */
  submitBytes: Buffer;
  /** Wrap the body in bracketed paste (`ESC[200~` … `ESC[201~`). */
  bracketedPaste: boolean;
  /** Pause after the interrupt key before pasting, so the TUI can settle. */
  postInterruptMs: number;
  /** Pause after the paste-end marker before submitting. Guards against
   *  racing the app's paste-coalescing timer. */
  preSubmitMs: number;
  /**
   * Max bytes per stdin write. Chunking is NOT optional: a PTY line
   * discipline silently drops a single multi-KB write.
   */
  chunkBytes: number;
  /** Gap between body chunks. */
  chunkDelayMs: number;

  // --- idle detection -------------------------------------------------------

  /**
   * How long the PTY must be quiet before this adapter is considered idle by
   * the server-side signal alone. The sidecar's in-container signal is ANDed
   * with this one (see Phase 4); PTY-scrape adapters only have this clause.
   */
  ptyQuietMs: number;
}

const ESC = Buffer.from([0x1b]);
const CTRL_C = Buffer.from([0x03]);
const CR = Buffer.from([0x0d]);

const BASE = {
  interruptBytes: ESC,
  submitBytes: CR,
  bracketedPaste: true,
  postInterruptMs: 300,
  preSubmitMs: 200,
  chunkBytes: 2048,
  chunkDelayMs: 20,
  ptyQuietMs: 750,
} satisfies Omit<AdapterProfile, "id" | "label">;

export const PROFILES: Record<AdapterKey, AdapterProfile> = {
  // Ink app, bracketed paste enabled, ESC cancels the in-flight turn.
  "claude-code": { ...BASE, id: "claude-code", label: "Claude Code" },

  // Also Ink-based. ESC interrupts, but the composer repaints more slowly
  // after a cancel, so it gets a longer post-interrupt settle. (unverified)
  codex: { ...BASE, id: "codex", label: "Codex", postInterruptMs: 450 },

  // Interrupts on Ctrl-C rather than ESC, and coalesces pastes more
  // aggressively — smaller chunks, wider gaps. (unverified)
  antigravity: {
    ...BASE,
    id: "antigravity",
    label: "Antigravity",
    interruptBytes: CTRL_C,
    postInterruptMs: 400,
    preSubmitMs: 300,
    chunkBytes: 1024,
    chunkDelayMs: 30,
  },

  // BYO CLIs: assume the least about the target. No bracketed paste (an app
  // that does not enable paste mode would otherwise receive the literal
  // `ESC[200~` markers as text), conservative chunking.
  custom: {
    ...BASE,
    id: "custom",
    label: "Custom",
    bracketedPaste: false,
    chunkBytes: 512,
    chunkDelayMs: 30,
    ptyQuietMs: 1500,
  },

  // `tests/fixtures/mock-agent.sh` and the unit tests. Timings collapsed so
  // fake-timer tests stay readable; the byte sequence is identical.
  mock: {
    ...BASE,
    id: "mock",
    label: "Mock agent",
    postInterruptMs: 10,
    preSubmitMs: 5,
    chunkBytes: 16,
    chunkDelayMs: 1,
    ptyQuietMs: 50,
  },
};

export const DEFAULT_ADAPTER: AdapterKey = "claude-code";

/**
 * Look up a profile by adapter key, falling back to the `custom` (assume
 * nothing) profile for unknown keys rather than throwing — an unknown CLI
 * should degrade, not break dispatch.
 */
export function getProfile(cli: string | null | undefined): AdapterProfile {
  if (!cli) return PROFILES[DEFAULT_ADAPTER];
  return PROFILES[cli as AdapterKey] ?? PROFILES.custom;
}
