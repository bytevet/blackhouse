import { describe, it, expect } from "vitest";
import {
  agentEventSchema,
  ingestSchema,
  projectsToMessage,
  toolCallDisplay,
  preview,
  usageCents,
  usageTokens,
  TOOL_INPUT_PREVIEW_LIMIT,
} from "../../server/agents/events.js";

describe("projectsToMessage", () => {
  it("renders assistant prose as a text message", () => {
    expect(projectsToMessage("assistant_text")).toBe("text");
  });

  it("renders tool traffic as the quieter event kind", () => {
    // The design's whole hierarchy rests on mechanism being visually quieter
    // than conversation; promoting tool calls to `text` would flood the channel.
    expect(projectsToMessage("tool_use")).toBe("event");
    expect(projectsToMessage("tool_result")).toBe("event");
    expect(projectsToMessage("turn_start")).toBe("event");
    expect(projectsToMessage("turn_end")).toBe("event");
  });

  it("keeps bookkeeping out of the transcript entirely", () => {
    // Stored for provenance and budget accounting, never rendered.
    expect(projectsToMessage("usage")).toBeNull();
    expect(projectsToMessage("status")).toBeNull();
    expect(projectsToMessage("raw")).toBeNull();
  });
});

describe("toolCallDisplay", () => {
  it("renders a file read the way the design shows it", () => {
    const d = toolCallDisplay("Read", { file_path: "src/db/schema.ts" }, "340 ln");
    expect(d).toEqual({ glyph: "◇", verb: "Read", target: "src/db/schema.ts", meta: "340 ln" });
  });

  it("renders a bash call with its command as the target", () => {
    const d = toolCallDisplay("Bash", { command: "rg --files src/app" }, "0.4s");
    expect(d.glyph).toBe("▶");
    expect(d.verb).toBe("Ran");
    expect(d.target).toBe("rg --files src/app");
  });

  it("quotes a grep pattern", () => {
    expect(toolCallDisplay("Grep", { pattern: "stripe" }).target).toBe('"stripe"');
  });

  it("keeps an unknown tool's own name as the verb", () => {
    // MCP and custom tools are more useful identified than flattened into a
    // generic label.
    const d = toolCallDisplay("mcp__github__create_pr", { title: "x" });
    expect(d.verb).toBe("mcp__github__create_pr");
    expect(d.glyph).toBe("◆");
  });

  it("survives an empty input object", () => {
    expect(toolCallDisplay("Read", {}).target).toBe("");
  });

  it("truncates a long bash command rather than storing all of it", () => {
    const d = toolCallDisplay("Bash", { command: "x".repeat(500) });
    expect(d.target.length).toBeLessThan(200);
  });
});

describe("preview", () => {
  it("passes short values through untouched", () => {
    expect(preview("hello")).toBe("hello");
  });

  it("truncates and says how much was dropped", () => {
    // A single tool call can carry an entire file; storing it would bloat the
    // transcript and ship the file to every connected client.
    const out = preview("y".repeat(TOOL_INPUT_PREVIEW_LIMIT + 500));
    expect(out.length).toBeLessThan(TOOL_INPUT_PREVIEW_LIMIT + 60);
    expect(out).toContain("500 more chars");
  });

  it("serialises non-strings", () => {
    expect(preview({ a: 1 })).toBe('{"a":1}');
    expect(preview(null)).toBe('""');
  });
});

describe("usage accounting", () => {
  it("converts dollars to cents, rounding up so we never under-bill", () => {
    expect(usageCents({ costUsd: 0.094 })).toBe(10);
    expect(usageCents({ cost_usd: 1 })).toBe(100);
    expect(usageCents({ cost: "0.5" })).toBe(50);
  });

  it("treats missing or nonsense cost as zero", () => {
    expect(usageCents({})).toBe(0);
    expect(usageCents({ costUsd: -3 })).toBe(0);
    expect(usageCents({ costUsd: "abc" })).toBe(0);
  });

  it("reads token counts under either naming convention", () => {
    expect(usageTokens({ inputTokens: 10, outputTokens: 20 })).toEqual({ in: 10, out: 20 });
    expect(usageTokens({ input_tokens: 5, output_tokens: 6 })).toEqual({ in: 5, out: 6 });
    expect(usageTokens({})).toEqual({ in: 0, out: 0 });
  });
});

describe("event schema", () => {
  it("accepts a minimal well-formed event", () => {
    const parsed = agentEventSchema.safeParse({
      sourceRef: "uuid-1",
      seq: 0,
      type: "assistant_text",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payload).toEqual({});
  });

  it("preserves unknown payload fields", () => {
    // The Claude Code JSONL format is undocumented and version-coupled, so an
    // adapter that meets something new must not lose it.
    const parsed = agentEventSchema.parse({
      sourceRef: "uuid-2",
      seq: 1,
      type: "raw",
      payload: { somethingNew: { nested: true } },
    });
    expect(parsed.payload).toEqual({ somethingNew: { nested: true } });
  });

  it("rejects an unknown event type", () => {
    expect(agentEventSchema.safeParse({ sourceRef: "x", seq: 0, type: "invented" }).success).toBe(
      false,
    );
  });

  it("requires a source ref, since that is the idempotency key", () => {
    expect(agentEventSchema.safeParse({ sourceRef: "", seq: 0, type: "raw" }).success).toBe(false);
  });

  it("caps a batch so one POST cannot be unbounded", () => {
    const one = { sourceRef: "a", seq: 0, type: "raw" as const };
    expect(ingestSchema.safeParse({ events: [] }).success).toBe(false);
    expect(ingestSchema.safeParse({ events: Array(201).fill(one) }).success).toBe(false);
    expect(ingestSchema.safeParse({ events: Array(200).fill(one) }).success).toBe(true);
  });
});
