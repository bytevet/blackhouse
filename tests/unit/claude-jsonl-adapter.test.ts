import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The sidecar is plain .mjs with zero dependencies — it is fetched over the
// wire into containers and never gets an `npm install`, so it is imported here
// exactly as a container would load it.
import adapter, {
  digestToolInput,
  fallbackSourceRef,
  mapEntry,
  mapLine,
  preview,
  PREVIEW_LIMIT,
} from "../../agent/sidecar/adapters/claude-code.mjs";
import { createTailer } from "../../agent/sidecar/lib/tail.mjs";
import { createActivityTracker } from "../../agent/sidecar/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "claude-code-session.jsonl");

interface SidecarEvent {
  sourceRef: string;
  seq: number;
  type: string;
  occurredAt?: string;
  externalRunId?: string;
  payload: Record<string, any>;
}

/** Map a whole file the way the sidecar's tick loop does: line by line, carrying seq. */
function mapAll(lines: Array<{ line: string; path: string; offset: number }>): SidecarEvent[] {
  let seq = 0;
  const out: SidecarEvent[] = [];
  for (const item of lines) {
    const result = mapLine({ ...item, seq });
    seq = result.nextSeq;
    out.push(...(result.events as SidecarEvent[]));
  }
  return out;
}

function linesOf(text: string, filePath = "/log.jsonl") {
  const out: Array<{ line: string; path: string; offset: number }> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) out.push({ line, path: filePath, offset });
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return out;
}

describe("claude-code JSONL adapter — fixture to events", () => {
  let events: SidecarEvent[];

  beforeAll(async () => {
    const text = await fs.readFile(FIXTURE, "utf8");
    events = mapAll(linesOf(text, FIXTURE));
  });

  it("produces the expected event sequence for a real-shaped session", () => {
    expect(events.map((e) => e.type)).toEqual([
      // user prompt
      "turn_start",
      // assistant: prose, a tool call, then its usage — stop_reason was
      // "tool_use", so deliberately NO turn_end here.
      "assistant_text",
      "tool_use",
      "usage",
      // the tool's result comes back as a user entry
      "tool_result",
      // a system note
      "status",
      // assistant closes the turn
      "assistant_text",
      "usage",
      "turn_end",
      // summary
      "status",
      // a record type from the future
      "raw",
    ]);
  });

  it("assigns a monotonic seq and never reuses a sourceRef", () => {
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.sourceRef)).size).toBe(events.length);
  });

  it("derives sourceRef from the entry's own uuid, suffixed per event", () => {
    // Three events came off the one assistant line; they share its uuid.
    const fromAssistant = events.filter((e) =>
      e.sourceRef.startsWith("22222222-2222-4222-8222-222222222222"),
    );
    expect(fromAssistant.map((e) => e.sourceRef)).toEqual([
      "22222222-2222-4222-8222-222222222222:0",
      "22222222-2222-4222-8222-222222222222:1",
      "22222222-2222-4222-8222-222222222222:2",
    ]);
  });

  it("carries occurredAt and externalRunId through", () => {
    expect(events[0].occurredAt).toBe("2026-08-15T10:00:00.000Z");
    expect(events[0].externalRunId).toBe("sess-abc");
  });

  it("emits usage the server's budget accounting can read", () => {
    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(2);
    expect(usage[0].payload).toMatchObject({
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 48,
      cacheReadTokens: 8000,
      costUsd: 0.0125,
    });
  });

  it("does not end the turn on a stop_reason of tool_use", () => {
    // Marking the agent idle mid-tool-call would release a queued prompt into
    // the middle of its work. Only the end_turn line closes the turn.
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].payload.stopReason).toBe("end_turn");
  });

  it("renders a tool_use row the server can display without the raw input", () => {
    const toolUse = events.find((e) => e.type === "tool_use")!;
    expect(toolUse.payload.toolName).toBe("Read");
    expect(toolUse.payload.toolUseId).toBe("toolu_01");
    expect(toolUse.payload.input).toEqual({ file_path: "server/index.ts", limit: 340 });
    expect(toolUse.payload.meta).toBe("340 ln");
  });

  it("summarises tool results by size rather than storing them whole", () => {
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.payload.toolUseId).toBe("toolu_01");
    expect(result.payload.isError).toBe(false);
    expect(result.payload.resultBytes).toBeGreaterThan(0);
    expect(result.payload.lines).toBe(4);
  });
});

describe("defensive behaviour — degrade, never throw", () => {
  it("turns an unknown entry type into raw carrying the whole object", () => {
    const raw = mapAll(
      linesOf(
        JSON.stringify({
          type: "cassowary_v9_record",
          uuid: "aaaa",
          inventedField: { nested: [1, 2, 3] },
        }),
      ),
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].type).toBe("raw");
    expect(raw[0].payload.entryType).toBe("cassowary_v9_record");
    // The point of `raw` is that nothing is lost when the format moves.
    expect(raw[0].payload.entry).toMatchObject({ inventedField: { nested: [1, 2, 3] } });
  });

  it("turns a non-JSON line into raw rather than throwing", () => {
    const events = mapLine({
      line: "this is not json at all",
      path: "/log.jsonl",
      offset: 512,
      seq: 7,
    });
    expect(events.events[0].type).toBe("raw");
    expect(events.events[0].payload.parseError).toBe(true);
    expect(events.events[0].seq).toBe(7);
    expect(events.nextSeq).toBe(8);
  });

  it("falls back to sha1(path + offset) when the entry has no uuid", () => {
    const { events } = mapLine({
      line: JSON.stringify({ type: "user", message: { content: "hi" } }),
      path: "/log.jsonl",
      offset: 900,
      seq: 0,
    });
    expect(events[0].sourceRef).toBe(`${fallbackSourceRef("/log.jsonl", 900)}:0`);
  });

  it("never returns zero events for a line, so no watermark is silently skipped", () => {
    // An assistant turn with nothing renderable in it.
    const { events } = mapLine({
      line: JSON.stringify({ type: "assistant", uuid: "e1", message: { content: [] } }),
      path: "/log.jsonl",
      offset: 0,
      seq: 0,
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("raw");
  });

  it("survives a JSON literal that is not an object", () => {
    for (const line of ["null", "42", '"a string"', "[1,2,3]"]) {
      const { events } = mapLine({ line, path: "/log.jsonl", offset: 0, seq: 0 });
      expect(events[0].type).toBe("raw");
    }
  });

  it("does not throw on a deeply malformed entry", () => {
    expect(() =>
      mapEntry({ type: "assistant", message: 5 }, { path: "/x", offset: 0, seq: 0 }),
    ).not.toThrow();
  });
});

describe("tool input is digested, never shipped whole", () => {
  const HUGE = "x".repeat(10_000);

  it("clamps the preview to the 2KB limit with a marker", () => {
    const digest = digestToolInput("Write", {
      file_path: "/workspace/big.txt",
      content: HUGE,
    });
    expect(digest.inputPreview.length).toBeLessThanOrEqual(PREVIEW_LIMIT + 40);
    expect(digest.inputPreview).toContain("more chars)");
    expect(digest.inputBytes).toBeGreaterThan(10_000);
  });

  it("keeps only identifying fields, so the payload cannot carry a file", () => {
    const digest = digestToolInput("Write", {
      file_path: "/workspace/big.txt",
      content: HUGE,
    });
    expect(digest.input).toEqual({ file_path: "/workspace/big.txt" });
    expect(JSON.stringify(digest.input)).not.toContain("xxxxx");
    // The digest still answers "what was actually sent".
    expect(digest.inputKeys).toEqual(["file_path", "content"]);
    expect(digest.meta).toBe("9.8 KB");
  });

  it("clamps individual identifying fields too", () => {
    const digest = digestToolInput("Bash", { command: HUGE });
    expect(digest.input.command.length).toBeLessThanOrEqual(512 + 40);
  });

  it("bounds the same way on the whole event path", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "big",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Write", input: { content: HUGE } }],
      },
    });
    const { events } = mapLine({ line, path: "/log.jsonl", offset: 0, seq: 0 });
    const encoded = JSON.stringify(events[0]);
    expect(encoded.length).toBeLessThan(4096);
  });

  it("preview() leaves short values untouched", () => {
    expect(preview("short")).toBe("short");
  });
});

describe("tailer — partial lines and offset rewind", () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bh-tail-"));
    file = path.join(dir, "session.jsonl");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("holds a partial trailing line until its newline arrives", async () => {
    const tailer = createTailer({ roots: [dir] });

    const first = JSON.stringify({ type: "user", uuid: "a", message: { content: "one" } });
    const second = JSON.stringify({ type: "user", uuid: "b", message: { content: "two" } });

    // Write the first line plus HALF of the second — exactly what a poll that
    // lands mid-append sees.
    const half = second.slice(0, 20);
    await fs.writeFile(file, `${first}\n${half}`, "utf8");

    const firstPoll = await tailer.poll();
    expect(firstPoll.map((l) => l.line)).toEqual([first]);
    // The watermark is line-aligned: it points at the start of the partial
    // line, never into the middle of one.
    expect(tailer.watermarks()[file]).toBe(Buffer.byteLength(first, "utf8") + 1);

    await fs.appendFile(file, `${second.slice(20)}\n`, "utf8");
    const secondPoll = await tailer.poll();
    expect(secondPoll.map((l) => l.line)).toEqual([second]);
    expect(secondPoll[0].offset).toBe(Buffer.byteLength(first, "utf8") + 1);
  });

  it("re-reads identically after an offset rewind, so replay dedups", async () => {
    const rewound = createTailer({ roots: [dir] });
    // Simulate a restart that lost its watermark file: back to zero.
    rewound.load({ [file]: 0 });

    const replayed = await rewound.poll();
    expect(replayed).toHaveLength(2);

    // The whole idempotency story rests on this: the same bytes at the same
    // offsets must produce byte-identical sourceRefs, because the server
    // dedups on (agentId, sourceRef) and skips the side effects too.
    const firstRun = mapAll(replayed);
    const secondRun = mapAll(replayed);
    expect(secondRun.map((e) => e.sourceRef)).toEqual(firstRun.map((e) => e.sourceRef));
    expect(firstRun.map((e) => e.sourceRef)).toEqual(["a:0", "b:0"]);
  });

  it("rewinds by itself when the file is truncated underneath it", async () => {
    const tailer = createTailer({ roots: [dir] });
    await tailer.poll();
    expect(tailer.watermarks()[file]).toBeGreaterThan(0);

    await fs.writeFile(file, `${JSON.stringify({ type: "user", uuid: "c" })}\n`, "utf8");
    const afterTruncate = await tailer.poll();
    expect(afterTruncate).toHaveLength(1);
    expect(JSON.parse(afterTruncate[0].line).uuid).toBe("c");
  });

  it("survives a root directory that does not exist yet", async () => {
    const tailer = createTailer({ roots: [path.join(dir, "not-created-until-first-run")] });
    await expect(tailer.poll()).resolves.toEqual([]);
  });
});

describe("activity tracking", () => {
  it("starts unknown, not idle", () => {
    const tracker = createActivityTracker({ now: () => 0 });
    expect(tracker.current()).toBe("unknown");
  });

  it("reports busy while a tool call is outstanding, however quiet the log is", () => {
    let clock = 0;
    const tracker = createActivityTracker({
      idleQuietMs: 1500,
      terminalTypes: adapter.TERMINAL_EVENT_TYPES,
      now: () => clock,
    });

    tracker.observe([{ type: "tool_use", payload: {} }] as never);
    clock = 60_000; // a long Bash call: log silent for a minute
    expect(tracker.current()).toBe("busy");
  });

  it("goes idle only once the log is quiet AND the turn actually ended", () => {
    let clock = 0;
    const tracker = createActivityTracker({
      idleQuietMs: 1500,
      terminalTypes: adapter.TERMINAL_EVENT_TYPES,
      now: () => clock,
    });

    tracker.observe([{ type: "turn_end", payload: {} }] as never);
    clock = 1000;
    expect(tracker.current()).toBe("busy"); // quiet window not elapsed
    clock = 2000;
    expect(tracker.current()).toBe("idle");
  });

  it("posts on transition and again as a heartbeat", () => {
    let clock = 0;
    const tracker = createActivityTracker({
      idleQuietMs: 1500,
      heartbeatMs: 10_000,
      terminalTypes: adapter.TERMINAL_EVENT_TYPES,
      now: () => clock,
    });

    expect(tracker.due()).toMatchObject({ activity: "unknown" }); // first report
    expect(tracker.due()).toBeNull(); // nothing changed, heartbeat not due

    tracker.observe([{ type: "assistant_text", payload: {} }] as never);
    expect(tracker.due()).toMatchObject({ activity: "busy" }); // transition

    clock = 10_001;
    const beat = tracker.due();
    expect(beat).toMatchObject({ activity: "idle" });
    expect(typeof beat!.at).toBe("string");
  });
});
