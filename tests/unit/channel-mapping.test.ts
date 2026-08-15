import { describe, it, expect } from "vitest";
import {
  DEFAULT_DISPATCH_TTL_MS,
  glyphTone,
  mapAgent,
  mapChannel,
  mapTranscript,
  memberCounts,
  sortMessages,
  toDate,
  toolCallFromMessage,
  unknownAgent,
  type DispatchRow,
  type MessageRow,
} from "@/components/channel/channel-mapping";
import type { AgentView, TranscriptEntry, UserView } from "@/components/channel/types";

/**
 * The mapping is where the Channel View can go wrong quietly.
 *
 * Two server columns — `messages.kind` and `messages.authorKind` — have to fan
 * out into five visually distinct transcript kinds, and hundreds of sidecar
 * `event` rows have to collapse into one summary row per turn. Neither failure
 * throws: they render the wrong *sort of thing*, or a turn that under-reports
 * how much work an agent actually did. So the fan-out and the grouping are
 * pinned here rather than trusted to a browser.
 */

const SCOUT: AgentView = {
  id: "agt-scout",
  handle: "scout",
  displayName: "Scout",
  status: "running",
  activity: "busy",
  statusLine: "reading src/db/schema.ts",
};

const REVIEWER: AgentView = {
  id: "agt-reviewer",
  handle: "reviewer",
  displayName: "Reviewer",
  status: "running",
  activity: "idle",
  statusLine: null,
};

const DANA: UserView = { id: "usr-dana", name: "Dana Okafor", role: "owner" };

let nextSeq = 1000;

function message(overrides: Partial<MessageRow> & Pick<MessageRow, "kind" | "authorKind">) {
  nextSeq += 1;
  return {
    id: `msg-${nextSeq}`,
    seq: nextSeq,
    body: null,
    createdAt: new Date("2026-08-15T10:00:00Z").toISOString(),
    ...overrides,
  } satisfies MessageRow;
}

function toolUse(
  runId: string | null,
  display: { glyph: string; verb: string; target: string; meta?: string },
  overrides: Partial<MessageRow> = {},
): MessageRow {
  return message({
    kind: "event",
    authorKind: "agent",
    authorAgentId: SCOUT.id,
    runId,
    metadata: { eventType: "tool_use", meta: "—", ...display },
    ...overrides,
  });
}

const base = { agents: [SCOUT, REVIEWER], currentUser: DANA };

describe("mapTranscript — the kind fan-out", () => {
  it("splits `text` on the author kind, which is the whole reason both columns exist", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        message({ kind: "text", authorKind: "user", authorUserId: DANA.id, body: "@scout go" }),
        message({ kind: "text", authorKind: "agent", authorAgentId: SCOUT.id, body: "on it" }),
      ],
    });

    expect(entries.map((e) => e.kind)).toEqual(["human", "agent-text"]);
    const [human, agent] = entries as [
      Extract<TranscriptEntry, { kind: "human" }>,
      Extract<TranscriptEntry, { kind: "agent-text" }>,
    ];
    expect(human.author).toEqual(DANA);
    expect(human.body).toBe("@scout go");
    expect(agent.agent).toEqual(SCOUT);
  });

  it("renders a system-authored row as the quiet line, whatever its kind says", () => {
    // There is no author to attribute it to, so the only honest rendering is
    // the one that does not claim an author.
    const entries = mapTranscript({
      ...base,
      messages: [
        message({ kind: "system", authorKind: "system", body: "auto-approve turned on" }),
        message({ kind: "text", authorKind: "system", body: "budget cap reached" }),
      ],
    });
    expect(entries.map((e) => e.kind)).toEqual(["system", "system"]);
  });

  it("maps an artifact row to a card, titled from the message body", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        message({
          kind: "artifact",
          authorKind: "agent",
          authorAgentId: SCOUT.id,
          body: "checkout-flow-map.html",
          metadata: { artifactId: "art-1" },
        }),
      ],
      artifacts: { "art-1": { id: "art-1", kind: "html", title: null, sizeBytes: 24_576 } },
    });

    const entry = entries[0] as Extract<TranscriptEntry, { kind: "artifact" }>;
    expect(entry.kind).toBe("artifact");
    expect(entry.artifact.id).toBe("art-1");
    expect(entry.artifact.sizeBytes).toBe(24_576);
    expect(entry.artifact.description).toBe("rendered HTML");
  });

  it("still renders an artifact card before the artifact row is fetched", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        message({
          kind: "artifact",
          authorKind: "agent",
          authorAgentId: SCOUT.id,
          body: "report.html",
          metadata: { artifactId: "art-missing" },
        }),
      ],
    });
    const entry = entries[0] as Extract<TranscriptEntry, { kind: "artifact" }>;
    expect(entry.artifact.title).toBe("report.html");
    expect(entry.artifact.sizeBytes).toBeNull();
  });

  it("attaches the queued chip to the message that triggered the run", () => {
    const trigger = message({
      kind: "text",
      authorKind: "user",
      authorUserId: DANA.id,
      body: "@scout ship it",
    });
    const entries = mapTranscript({
      ...base,
      messages: [trigger],
      queued: {
        [trigger.id]: {
          runId: "run-1",
          agentHandle: "scout",
          reason: "Agent is paused — daily budget cap reached",
          mode: "queue",
        },
      },
    });
    const entry = entries[0] as Extract<TranscriptEntry, { kind: "human" }>;
    // The server's reason travels verbatim: "paused" is not "busy".
    expect(entry.queued?.reason).toBe("Agent is paused — daily budget cap reached");
  });

  it("attributes an unknown author without dropping the message", () => {
    // A destroyed agent is gone from `GET /api/agents` but its messages are
    // still history, and history must not vanish with the container.
    const entries = mapTranscript({
      agents: [],
      messages: [
        message({
          kind: "text",
          authorKind: "agent",
          authorAgentId: "agt-gone-forever",
          body: "x",
        }),
        message({ kind: "text", authorKind: "user", authorUserId: "usr-other", body: "y" }),
      ],
    });
    const agentEntry = entries[0] as Extract<TranscriptEntry, { kind: "agent-text" }>;
    const humanEntry = entries[1] as Extract<TranscriptEntry, { kind: "human" }>;
    expect(agentEntry.agent.displayName).toBe("Removed agent");
    expect(agentEntry.agent.status).toBe("destroyed");
    expect(humanEntry.author.name).toBe("Unknown member");
  });

  it("orders by seq regardless of the order rows arrive in", () => {
    // The keyset endpoint returns newest-first; the transcript renders oldest
    // first, and pagination hands us pages out of order.
    const older = message({ kind: "text", authorKind: "user", body: "first", seq: 5 });
    const newer = message({ kind: "text", authorKind: "user", body: "second", seq: 9 });
    const entries = mapTranscript({ ...base, messages: [newer, older] });
    expect(entries.map((e) => e.seq)).toEqual([5, 9]);
  });
});

describe("mapTranscript — dispatch cards", () => {
  const card = message({
    kind: "dispatch_request",
    authorKind: "agent",
    authorAgentId: SCOUT.id,
    body: "Review the migration plan",
    metadata: { dispatchId: "dsp-1", autoApproved: false },
  });

  const row: DispatchRow = {
    id: "dsp-1",
    fromAgentId: SCOUT.id,
    toAgentId: REVIEWER.id,
    prompt: "Review the migration plan",
    approvedPrompt: null,
    status: "pending",
    decidedBy: null,
    expiresAt: new Date("2026-08-15T10:30:00Z").toISOString(),
    messageId: card.id,
    createdRunId: null,
  };

  it("joins both handles and the decider's name", () => {
    const entries = mapTranscript({
      ...base,
      messages: [card],
      users: { [DANA.id]: DANA },
      dispatches: {
        "dsp-1": { ...row, status: "approved", decidedBy: DANA.id, createdRunId: "run-9" },
      },
    });
    const entry = entries[0] as Extract<TranscriptEntry, { kind: "dispatch" }>;
    expect(entry.dispatch.fromHandle).toBe("scout");
    expect(entry.dispatch.toHandle).toBe("reviewer");
    expect(entry.dispatch.decidedByName).toBe("Dana Okafor");
    expect(entry.dispatch.runId).toBe("run-9");
    expect(entry.dispatch.autoApproved).toBe(false);
  });

  it("reads `approved` with no decider as the channel's auto-approve, not a person", () => {
    // Auto-approve removes the hold, not the record — and the record has to say
    // that no human allowed this.
    const entries = mapTranscript({
      ...base,
      messages: [card],
      dispatches: { "dsp-1": { ...row, status: "approved", decidedBy: null } },
    });
    const entry = entries[0] as Extract<TranscriptEntry, { kind: "dispatch" }>;
    expect(entry.dispatch.autoApproved).toBe(true);
    expect(entry.dispatch.decidedByName).toBeNull();
  });

  it("renders from the message alone when the dispatch row is not loaded", () => {
    // `GET /api/dispatches` returns the last 100; an older card must still show
    // its prompt rather than a blank row.
    const entries = mapTranscript({ ...base, messages: [card] });
    const entry = entries[0] as Extract<TranscriptEntry, { kind: "dispatch" }>;
    expect(entry.dispatch.prompt).toBe("Review the migration plan");
    expect(entry.dispatch.status).toBe("pending");
    expect(entry.dispatch.expiresAt.getTime()).toBe(
      toDate(card.createdAt).getTime() + DEFAULT_DISPATCH_TTL_MS,
    );
  });
});

describe("mapTranscript — turn grouping", () => {
  it("collapses consecutive event rows sharing a run into one turn", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts", meta: "118 ln" }),
        toolUse("run-1", { glyph: "⌕", verb: "Grep", target: '"stripe"' }),
        toolUse("run-1", { glyph: "▶", verb: "Ran", target: "npx tsc", meta: "6.2s" }),
      ],
    });

    expect(entries).toHaveLength(1);
    const turn = entries[0] as Extract<TranscriptEntry, { kind: "turn" }>;
    expect(turn.turn.runId).toBe("run-1");
    expect(turn.turn.toolCalls).toHaveLength(3);
    expect(turn.agent).toEqual(SCOUT);
  });

  it("closes the group when anything else comes between", () => {
    // Only *consecutive* rows group. Bucketing the whole page by runId would
    // teleport tool calls across the messages that separate them.
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" }),
        message({ kind: "text", authorKind: "user", authorUserId: DANA.id, body: "wait" }),
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "b.ts" }),
      ],
    });
    expect(entries.map((e) => e.kind)).toEqual(["turn", "human", "turn"]);
  });

  it("does not merge two agents' turns, even on the same run id", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" }),
        toolUse(
          "run-1",
          { glyph: "◇", verb: "Read", target: "b.ts" },
          {
            authorAgentId: REVIEWER.id,
          },
        ),
      ],
    });
    expect(entries).toHaveLength(2);
    expect((entries[1] as Extract<TranscriptEntry, { kind: "turn" }>).agent).toEqual(REVIEWER);
  });

  it("keeps run-less events apart rather than merging them into one fake turn", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse(null, { glyph: "◇", verb: "Read", target: "a.ts" }),
        toolUse(null, { glyph: "◇", verb: "Read", target: "b.ts" }),
      ],
    });
    expect(entries).toHaveLength(2);
  });

  it("prefers the run's tool-call count, so a truncated page says '5 more'", () => {
    // The page we hold is the tail of the turn. Counting the rows we happen to
    // have would claim the agent did three things when it did eight.
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" }),
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "b.ts" }),
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "c.ts" }),
      ],
      runs: {
        "run-1": {
          id: "run-1",
          status: "done",
          toolCallCount: 8,
          tokensIn: 7_000,
          tokensOut: 2_400,
        },
      },
    });
    const turn = (entries[0] as Extract<TranscriptEntry, { kind: "turn" }>).turn;
    expect(turn.toolCallCount).toBe(8);
    expect(turn.toolCalls).toHaveLength(3);
    expect(turn.tokens).toBe(9_400);
    expect(turn.status).toBe("done");
  });

  it("never under-reports when the run row lags behind the events we can see", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" }),
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "b.ts" }),
      ],
      runs: { "run-1": { id: "run-1", toolCallCount: 0 } },
    });
    expect((entries[0] as Extract<TranscriptEntry, { kind: "turn" }>).turn.toolCallCount).toBe(2);
  });

  it("derives a status from the events when no run row is known", () => {
    const running = mapTranscript({
      ...base,
      messages: [toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" })],
    });
    expect((running[0] as Extract<TranscriptEntry, { kind: "turn" }>).turn.status).toBe("running");

    const finished = mapTranscript({
      ...base,
      messages: [
        toolUse("run-1", { glyph: "◇", verb: "Read", target: "a.ts" }),
        message({
          kind: "event",
          authorKind: "agent",
          authorAgentId: SCOUT.id,
          runId: "run-1",
          metadata: { eventType: "turn_end" },
        }),
      ],
    });
    expect((finished[0] as Extract<TranscriptEntry, { kind: "turn" }>).turn.status).toBe("done");
  });

  it("measures the turn from its own rows when the run has no timestamps", () => {
    const entries = mapTranscript({
      ...base,
      messages: [
        toolUse(
          "run-1",
          { glyph: "◇", verb: "Read", target: "a.ts" },
          {
            createdAt: "2026-08-15T10:00:00Z",
          },
        ),
        toolUse(
          "run-1",
          { glyph: "▶", verb: "Ran", target: "tsc" },
          {
            createdAt: "2026-08-15T10:00:31Z",
          },
        ),
      ],
    });
    expect((entries[0] as Extract<TranscriptEntry, { kind: "turn" }>).turn.durationMs).toBe(31_000);
  });
});

describe("tool call rows", () => {
  it("takes the display fields verbatim — the server already derived them", () => {
    // Re-deriving client-side would mean re-parsing raw tool input, which can
    // be an entire file; that is exactly what the server stores a digest for.
    const call = toolCallFromMessage(
      toolUse("run-1", {
        glyph: "✎",
        verb: "Wrote",
        target: "checkout-flow-map.html",
        meta: "24 KB",
      }),
    );
    expect(call).toMatchObject({
      glyph: "✎",
      verb: "Wrote",
      target: "checkout-flow-map.html",
      meta: "24 KB",
      tone: "warning",
    });
  });

  it("skips the event rows that are not tool calls", () => {
    // turn_start / turn_end / tool_result belong to the summary, not the body;
    // rendering them would produce blank lines in the expanded turn.
    for (const eventType of ["turn_start", "turn_end", "tool_result", "status"]) {
      const row = message({
        kind: "event",
        authorKind: "agent",
        authorAgentId: SCOUT.id,
        runId: "run-1",
        metadata: { eventType },
      });
      expect(toolCallFromMessage(row)).toBeNull();
    }
  });

  it("falls back to a neutral row rather than rendering blanks", () => {
    const row = message({
      kind: "event",
      authorKind: "agent",
      authorAgentId: SCOUT.id,
      runId: "run-1",
      metadata: { eventType: "tool_use" },
    });
    expect(toolCallFromMessage(row)).toMatchObject({
      glyph: "◆",
      verb: "Tool",
      target: "",
      meta: "—",
      tone: "neutral",
    });
  });

  it("tones the glyph, not the row", () => {
    expect(glyphTone("◇")).toBe("info"); // read
    expect(glyphTone("▶")).toBe("success"); // ran
    expect(glyphTone("✎")).toBe("warning"); // changed something
    expect(glyphTone("~")).toBe("neutral"); // unknown
  });
});

describe("row helpers", () => {
  it("maps an agent row without inventing a status line", () => {
    expect(mapAgent({ ...SCOUT, statusLine: undefined })).toEqual({ ...SCOUT, statusLine: null });
  });

  it("names an agent it cannot resolve", () => {
    expect(unknownAgent("0123456789abcdef").handle).toBe("01234567");
    expect(unknownAgent(null).activity).toBe("unknown");
  });

  it("counts members by which column is set, never both", () => {
    expect(
      memberCounts([
        { id: "1", userId: "u1" },
        { id: "2", userId: "u2" },
        { id: "3", agentId: "a1" },
      ]),
    ).toEqual({ humanCount: 2, agentCount: 1 });
    expect(memberCounts(undefined)).toEqual({ humanCount: 0, agentCount: 0 });
  });

  it("never guesses an unread badge", () => {
    const view = mapChannel({
      id: "chn-1",
      slug: "backend",
      name: "backend",
      topic: null,
      autoApproveDispatch: true,
      isPrivate: false,
    });
    expect(view.unreadCount).toBe(0);
    expect(view.hasMention).toBe(false);
    expect(view.autoApproveDispatch).toBe(true);
    expect(view.gitRepoUrl).toBeNull();
  });

  it("turns an unusable date into the epoch rather than an Invalid Date", () => {
    // An Invalid Date propagates silently through every formatter downstream.
    expect(toDate("not a date").getTime()).toBe(0);
    expect(toDate(undefined).getTime()).toBe(0);
    expect(toDate("2026-08-15T10:00:00Z").toISOString()).toBe("2026-08-15T10:00:00.000Z");
  });

  it("sorts on seq first, then time, then id", () => {
    const rows = sortMessages([
      { id: "b", seq: 2, kind: "text", authorKind: "user", createdAt: "2026-08-15T10:00:00Z" },
      { id: "a", seq: 2, kind: "text", authorKind: "user", createdAt: "2026-08-15T09:00:00Z" },
      { id: "c", seq: "1", kind: "text", authorKind: "user", createdAt: "2026-08-15T11:00:00Z" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});
