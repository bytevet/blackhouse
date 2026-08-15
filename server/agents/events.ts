import { z } from "zod";
import type { AgentEventType } from "../db/schema.js";

/**
 * The sidecar event contract.
 *
 * Two very different producers write these: an in-container adapter tailing a
 * CLI's structured session log, and a server-side PTY scraper for CLIs that
 * have no such log. Both funnel through this one schema so the transcript
 * renderer never has to care which produced a given row.
 *
 * `.passthrough()` on the payload is deliberate — the Claude Code JSONL format
 * is undocumented and version-coupled, so unrecognised fields are preserved
 * rather than dropped. An adapter that meets something it doesn't understand
 * emits `raw` instead of throwing: degrading to "coarse but alive" beats
 * losing the transcript entirely.
 */

export const TOOL_INPUT_PREVIEW_LIMIT = 2048;

export const agentEventSchema = z.object({
  /**
   * Stable identity for this event from the producer's point of view — Claude
   * Code stamps a uuid per JSONL line; the PTY scraper hashes its offset.
   * Paired with agentId in a unique index, this is what makes ingest
   * idempotent across retries, container restarts and offset rewinds.
   */
  sourceRef: z.string().min(1).max(200),
  /** Monotonic ordering hint. Best-effort: ties are broken by arrival. */
  seq: z.number().int().nonnegative(),
  type: z.enum([
    "turn_start",
    "assistant_text",
    "tool_use",
    "tool_result",
    "turn_end",
    "status",
    "usage",
    "raw",
  ]),
  occurredAt: z.string().datetime().optional(),
  externalRunId: z.string().max(200).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type AgentEventInput = z.infer<typeof agentEventSchema>;

export const ingestSchema = z.object({
  events: z.array(agentEventSchema).min(1).max(200),
});

export const stateSchema = z.object({
  activity: z.enum(["idle", "busy", "unknown"]),
  externalRunId: z.string().max(200).optional(),
  at: z.string().datetime().optional(),
});

/**
 * A tool call as the transcript renders it: `◇ Read src/db/schema.ts 340 ln`.
 *
 * The design displays four fields, so the server derives all four once here
 * rather than making the client re-parse raw tool input on every render — and
 * raw input can be an entire file, which is exactly what we refuse to store.
 */
export interface ToolCallDisplay {
  glyph: string;
  verb: string;
  target: string;
  meta: string;
}

const TOOL_DISPLAY: Record<string, { glyph: string; verb: string }> = {
  read: { glyph: "◇", verb: "Read" },
  write: { glyph: "✎", verb: "Wrote" },
  edit: { glyph: "✎", verb: "Edited" },
  multiedit: { glyph: "✎", verb: "Edited" },
  grep: { glyph: "⌕", verb: "Grep" },
  glob: { glyph: "⌕", verb: "Glob" },
  bash: { glyph: "▶", verb: "Ran" },
  task: { glyph: "◈", verb: "Agent" },
  webfetch: { glyph: "☁", verb: "Fetched" },
  websearch: { glyph: "☁", verb: "Searched" },
  todowrite: { glyph: "☰", verb: "Todo" },
};

/** Truncate to a preview, marking it so a reader knows it is not the whole value. */
export function preview(value: unknown, limit = TOOL_INPUT_PREVIEW_LIMIT): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (${text.length - limit} more chars)`;
}

/** Best-effort single-line description of what a tool call acted on. */
function targetFor(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const v = input[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  if (name === "bash") return preview(pick("command") ?? "", 120);
  if (name === "grep" || name === "glob") {
    const pattern = pick("pattern") ?? "";
    return pattern ? `"${preview(pattern, 80)}"` : "";
  }
  return preview(pick("file_path", "path", "notebook_path", "url", "prompt") ?? "", 120);
}

export function toolCallDisplay(
  toolName: string,
  input: Record<string, unknown> = {},
  meta = "",
): ToolCallDisplay {
  const known = TOOL_DISPLAY[toolName.toLowerCase()];
  return {
    glyph: known?.glyph ?? "◆",
    // Unknown tools (MCP servers, custom tools) keep their own name rather
    // than being flattened into a generic verb — the tool's identity is the
    // most useful thing on the row.
    verb: known?.verb ?? toolName,
    target: targetFor(toolName, input),
    meta,
  };
}

/**
 * Does this event type belong in the channel transcript, and as what?
 *
 * `assistant_text` becomes prose the user reads. Tool traffic becomes a
 * collapsed activity turn. Bookkeeping types (`status`, `usage`, `raw`) are
 * stored for provenance and budget accounting but never rendered as messages —
 * the whole point of the design's hierarchy is that mechanism stays quieter
 * than conversation.
 */
export function projectsToMessage(type: AgentEventType): "text" | "event" | null {
  switch (type) {
    case "assistant_text":
      return "text";
    case "tool_use":
    case "tool_result":
    case "turn_start":
    case "turn_end":
      return "event";
    default:
      return null;
  }
}

/** Cost accounting from a `usage` event. Returns cents, rounded up. */
export function usageCents(payload: Record<string, unknown>): number {
  const raw = payload.costUsd ?? payload.cost_usd ?? payload.cost;
  const usd = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(usd * 100);
}

/** Token counts from a `usage` event, tolerant of both naming conventions. */
export function usageTokens(payload: Record<string, unknown>): { in: number; out: number } {
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const v = payload[key];
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  };
  return {
    in: num("inputTokens", "input_tokens", "tokensIn"),
    out: num("outputTokens", "output_tokens", "tokensOut"),
  };
}
