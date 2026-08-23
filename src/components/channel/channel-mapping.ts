/**
 * Server rows → view models.
 *
 * This is the only place where the shape of the database meets the shape of
 * the transcript, and it is deliberately **pure**: no fetching, no React, no
 * `Date.now()` in the hot path. Everything the mapping needs is passed in, so
 * the whole fan-out is unit-testable without a server — which matters, because
 * the fan-out is the risky part. Two server columns (`messages.kind` and
 * `messages.authorKind`) have to become five visually distinct transcript
 * kinds, and the failure mode of getting it wrong is a row that renders as the
 * wrong *sort of thing* rather than an obvious crash.
 *
 * The one rule that is easy to break and expensive to break: tool-call display
 * fields (`glyph`/`verb`/`target`/`meta`) are derived **server-side** and
 * arrive on `messages.metadata`. Never re-derive them here — raw tool input can
 * be an entire file, which is exactly why the server stores a digest instead.
 */

import type {
  ArtifactKind,
  DispatchStatus,
  MessageAuthorKind,
  MessageKind,
  RunStatus,
} from "@/db/schema";
import type { StatusTone } from "@/lib/agent-status";
import type {
  AgentView,
  ArtifactView,
  ChannelView,
  DispatchView,
  QueuedView,
  ToolCallView,
  TranscriptEntry,
  TurnView,
  UserView,
} from "./types";

// --------------------------------------------------------------------------
// Wire rows
//
// These mirror the Drizzle row types, except that anything that is a `Date` in
// Postgres arrives as an ISO string over JSON. They accept both so a caller can
// hand in either a parsed row or raw JSON.
// --------------------------------------------------------------------------

export type WireDate = string | Date;

/** A `messages` row as `GET /api/channels/:key/messages` returns it. */
export interface MessageRow {
  id: string;
  /** `bigserial`, so it can arrive as a JSON number or a string. */
  seq: number | string;
  authorKind: MessageAuthorKind;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  kind: MessageKind;
  body?: string | null;
  mentions?: string[];
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
  runId?: string | null;
  createdAt: WireDate;
}

/** An `agents` row as `GET /api/agents` returns it (never with `agentToken`). */
export interface AgentRow {
  id: string;
  handle: string;
  displayName: string;
  status: AgentView["status"];
  activity: AgentView["activity"];
  statusLine?: string | null;
}

/** A `channels` row. */
export interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  topic?: string | null;
  gitRepoUrl?: string | null;
  gitBranch?: string | null;
  autoApproveDispatch: boolean;
  isPrivate: boolean;
}

/** A `channel_members` row as `GET /api/channels/:key` returns it. */
export interface ChannelMemberRow {
  id: string;
  role?: string;
  userId?: string | null;
  agentId?: string | null;
}

/** A `dispatch_requests` row as `GET /api/dispatches` returns it. */
export interface DispatchRow {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  prompt: string;
  approvedPrompt?: string | null;
  status: DispatchStatus;
  decidedBy?: string | null;
  expiresAt: WireDate;
  messageId?: string | null;
  createdRunId?: string | null;
}

/**
 * An `artifacts` row as `GET /api/channels/:key/artifacts` returns it.
 *
 * Everything past `kind` is optional so a caller can hand in the narrower
 * shape an older endpoint returns — and so the mapping tests can write a row
 * literal without restating columns they are not asserting on.
 */
export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  title?: string | null;
  sizeBytes?: number | null;
  /** Agent-supplied. Displayed, never used to decide how a body is rendered. */
  contentType?: string | null;
  /** External location for `link`/`file`. Agent-supplied, so never an iframe src. */
  url?: string | null;
  channelId?: string;
  agentId?: string | null;
  createdAt?: WireDate;
}

/**
 * What we know about a `runs` row.
 *
 * Every field is optional because the client learns about runs piecemeal: a
 * `run.updated` frame carries only a status, a post response carries only an
 * id. The turn summary degrades field by field rather than all at once.
 */
export interface RunSummary {
  id: string;
  status?: RunStatus;
  /** Authoritative count from the server — see `turnFor` for why it wins. */
  toolCallCount?: number;
  tokensIn?: number;
  tokensOut?: number;
  startedAt?: WireDate | null;
  finishedAt?: WireDate | null;
}

// --------------------------------------------------------------------------
// Small pure helpers
// --------------------------------------------------------------------------

/** Wire value → `Date`. Invalid input becomes the epoch rather than `Invalid Date`,
 *  because an `Invalid Date` propagates silently into every formatter. */
export function toDate(value: WireDate | null | undefined): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function toSeq(value: number | string): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tone for a tool call's glyph.
 *
 * Keyed off the glyph the **server** chose, not off the tool name — which keeps
 * this a presentation decision (what colour is a write?) rather than a second,
 * drifting copy of the tool taxonomy in `server/agents/events.ts`.
 */
const GLYPH_TONE: Record<string, StatusTone> = {
  "◇": "info", // Read
  "⌕": "neutral", // Grep / Glob
  "▶": "success", // Bash
  "✎": "warning", // Write / Edit — the ones that changed something
  "◈": "info", // Task
  "☁": "info", // WebFetch / WebSearch
  "☰": "neutral", // TodoWrite
};

export function glyphTone(glyph: string): StatusTone {
  return GLYPH_TONE[glyph] ?? "neutral";
}

/** Human label under an artifact's title. */
export function artifactDescription(kind: ArtifactKind): string {
  switch (kind) {
    case "html":
      return "rendered HTML";
    case "file":
      return "file";
    case "link":
      return "link";
    case "text":
      return "text";
  }
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

// --------------------------------------------------------------------------
// Row → view
// --------------------------------------------------------------------------

export function mapAgent(row: AgentRow): AgentView {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    activity: row.activity,
    statusLine: row.statusLine ?? null,
  };
}

/**
 * An agent the roster does not have.
 *
 * `GET /api/agents` omits destroyed agents, but their messages stay in the
 * transcript forever — history must not disappear because the container did.
 * The synthesised row is honest about what it is rather than crashing the
 * renderer or silently dropping the message.
 */
export function unknownAgent(agentId: string | null | undefined): AgentView {
  const short = agentId ? agentId.slice(0, 8) : "unknown";
  return {
    id: agentId ?? `unknown:${short}`,
    handle: short,
    displayName: "Removed agent",
    status: "destroyed",
    activity: "unknown",
    statusLine: null,
  };
}

/** Counts for the header — `2 humans · 3 agents`. */
export function memberCounts(members: ChannelMemberRow[] | null | undefined): {
  humanCount: number;
  agentCount: number;
} {
  let humanCount = 0;
  let agentCount = 0;
  for (const member of members ?? []) {
    if (member.agentId) agentCount += 1;
    else if (member.userId) humanCount += 1;
  }
  return { humanCount, agentCount };
}

/**
 * A `channels` row → the sidebar/header view.
 *
 * `unreadCount` / `hasMention` are placeholders until the server derives them
 * from `channel_members.last_read_at`; they are passed in rather than invented
 * here so this function never *guesses* a badge.
 */
export function mapChannel(
  row: ChannelRow,
  extra: Partial<
    Pick<ChannelView, "unreadCount" | "hasMention" | "humanCount" | "agentCount">
  > = {},
): ChannelView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    topic: row.topic ?? null,
    gitRepoUrl: row.gitRepoUrl ?? null,
    gitBranch: row.gitBranch ?? null,
    autoApproveDispatch: row.autoApproveDispatch,
    isPrivate: row.isPrivate,
    unreadCount: extra.unreadCount ?? 0,
    hasMention: extra.hasMention ?? false,
    humanCount: extra.humanCount ?? 0,
    agentCount: extra.agentCount ?? 0,
  };
}

/**
 * One `kind='event'` row → one expanded tool-call line.
 *
 * Returns `null` for the event rows that are not tool calls (`turn_start`,
 * `turn_end`, `tool_result`): they belong to the turn's *summary*, not its
 * body, and rendering them as blank lines is worse than not rendering them.
 */
export function toolCallFromMessage(message: MessageRow): ToolCallView | null {
  const meta = message.metadata ?? {};
  if (meta.eventType !== "tool_use") return null;
  const glyph = str(meta.glyph, "◆");
  return {
    id: message.id,
    glyph,
    tone: glyphTone(glyph),
    verb: str(meta.verb, "Tool"),
    target: str(meta.target),
    meta: str(meta.meta, "—") || "—",
  };
}

/** Default dispatch TTL, mirroring `DISPATCH_TTL_MS` server-side. Used only when
 *  the dispatch row itself is missing, so the card still renders a countdown. */
export const DEFAULT_DISPATCH_TTL_MS = 30 * 60 * 1000;

// --------------------------------------------------------------------------
// The transcript
// --------------------------------------------------------------------------

export interface MapTranscriptInput {
  /** Any order; sorted here by `seq`. */
  messages: MessageRow[];
  agents: AgentView[];
  /** The signed-in human, so their own messages are attributed properly. */
  currentUser?: UserView | null;
  /** Other humans by id. Sparse: the users list is admin-only. */
  users?: Record<string, UserView>;
  /** `dispatch_requests` by id, from `GET /api/dispatches`. */
  dispatches?: Record<string, DispatchRow>;
  /** What we know about runs, by run id. */
  runs?: Record<string, RunSummary>;
  /** `artifacts` by id. */
  artifacts?: Record<string, ArtifactRow>;
  /** Queued-run chips by the id of the message that triggered them. */
  queued?: Record<string, QueuedView>;
}

/**
 * Sort a page oldest → newest.
 *
 * `seq` is the ordering key (a global sequence, monotonic within a channel);
 * `createdAt` and `id` only break ties, which happens for optimistic rows that
 * have no real `seq` yet.
 */
export function sortMessages(messages: MessageRow[]): MessageRow[] {
  return [...messages].sort((a, b) => {
    const bySeq = toSeq(a.seq) - toSeq(b.seq);
    if (bySeq !== 0) return bySeq;
    const byTime = toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Server rows → the transcript the components render.
 *
 * The fan-out, stated once:
 *
 * - `kind='system'` → `system`, whatever the author kind says.
 * - `kind='text'` splits on `authorKind`: `user` → `human`, `agent` → `agent-text`.
 * - `kind='event'` → **grouped** into `turn` (see below).
 * - `kind='artifact'` → `artifact`.
 * - `kind='dispatch_request'` → `dispatch`.
 *
 * Grouping is the part with teeth. The server stores one row per sidecar event,
 * and a single mention can produce hundreds; the design renders **one collapsed
 * summary row per turn**. So consecutive `event` rows that share a `runId` (and
 * an author) collapse into one entry, and anything else — a human message, an
 * artifact, a different run — closes the group. Grouping only *consecutive*
 * rows, rather than bucketing the whole page by `runId`, is deliberate: two
 * agents interleaving in a busy channel must not have their turns merged across
 * the messages that separate them.
 */
export function mapTranscript(input: MapTranscriptInput): TranscriptEntry[] {
  const {
    messages,
    agents,
    currentUser = null,
    users = {},
    dispatches = {},
    runs = {},
    artifacts = {},
    queued = {},
  } = input;

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const agentFor = (id: string | null | undefined): AgentView =>
    (id ? agentsById.get(id) : undefined) ?? unknownAgent(id);

  const userFor = (id: string | null | undefined): UserView => {
    if (id && users[id]) return users[id];
    if (id && currentUser && currentUser.id === id) return currentUser;
    return { id: id ?? "unknown", name: id ? "Unknown member" : "Unknown" };
  };

  const entries: TranscriptEntry[] = [];
  let group: MessageRow[] = [];

  const ordered = sortMessages(messages);

  /**
   * Runs that have ended, gathered before grouping.
   *
   * `turn_end` cannot be read off the group that needs it — see `turnFor`.
   */
  const endedRuns = new Set<string>();
  for (const message of ordered) {
    if (message.kind === "event" && (message.metadata ?? {}).eventType === "turn_end") {
      endedRuns.add(runKey(message));
    }
  }

  /**
   * A turn row summarises tool traffic, so a group with no tool traffic is not
   * a turn row.
   *
   * Event rows carry more than tool calls: `turn_start`, `turn_end`, `usage`
   * and `status` are all bookkeeping. A turn normally opens with `turn_start`,
   * then says something, then starts calling tools — and because grouping
   * breaks on the prose in the middle, `turn_start` was left alone in a group
   * of its own and rendered as its own summary row. The channel showed two
   * rows for one turn, the first reading "worked 0 tool calls · 0s · running",
   * which describes an agent doing nothing at the exact moment it was working.
   * A turn with no tools at all — "Hey, I'm here" — produced two such rows and
   * no real one.
   *
   * Dropping them loses nothing: prose renders as prose, and that a turn is in
   * flight is already carried by the agent's activity pill and status dot,
   * which is where CLAUDE.md puts the process signal.
   */
  const flush = () => {
    if (group.length === 0) return;
    const head = group[0];
    const turn = turnFor(group, runs, endedRuns);
    if (turn.toolCallCount === 0) {
      group = [];
      return;
    }
    entries.push({
      kind: "turn",
      id: head.id,
      seq: toSeq(head.seq),
      createdAt: toDate(head.createdAt),
      agent: agentFor(head.authorAgentId),
      turn,
    });
    group = [];
  };

  for (const message of ordered) {
    if (message.kind === "event") {
      const head = group[0];
      const sameRun = head && runKey(head) === runKey(message);
      const sameAuthor = head && head.authorAgentId === message.authorAgentId;
      if (head && !(sameRun && sameAuthor)) flush();
      group.push(message);
      continue;
    }

    flush();

    const base = {
      id: message.id,
      seq: toSeq(message.seq),
      createdAt: toDate(message.createdAt),
    };

    if (message.kind === "system") {
      entries.push({ ...base, kind: "system", body: message.body ?? "" });
      continue;
    }

    if (message.kind === "dispatch_request") {
      entries.push({
        ...base,
        kind: "dispatch",
        dispatch: dispatchFor(message, dispatches, agentsById, users),
      });
      continue;
    }

    if (message.kind === "artifact") {
      entries.push({
        ...base,
        kind: "artifact",
        agent: agentFor(message.authorAgentId),
        artifact: artifactFor(message, artifacts),
      });
      continue;
    }

    // kind === 'text'
    if (message.authorKind === "agent") {
      entries.push({
        ...base,
        kind: "agent-text",
        agent: agentFor(message.authorAgentId),
        body: message.body ?? "",
      });
    } else if (message.authorKind === "user") {
      entries.push({
        ...base,
        kind: "human",
        author: userFor(message.authorUserId),
        body: message.body ?? "",
        queued: queued[message.id],
      });
    } else {
      // `authorKind='system'` with `kind='text'` — the quiet line is the only
      // honest rendering: there is no author to attribute it to.
      entries.push({ ...base, kind: "system", body: message.body ?? "" });
    }
  }

  flush();
  return entries;
}

/** Group identity for consecutive event rows. A null `runId` groups with nothing. */
function runKey(message: MessageRow): string {
  return message.runId ?? `msg:${message.id}`;
}

/**
 * A group of consecutive event rows → the collapsed turn summary.
 *
 * `toolCallCount` prefers `runs.toolCallCount`, and that preference is the
 * whole reason `RunSummary` is threaded through here: the page we hold may be a
 * truncated tail of the turn, and the header must say "8 tool calls" with three
 * rows expanded and "5 more" underneath, not claim the turn was three calls
 * long. `Math.max` guards the other direction — a run row that has not caught
 * up with the events we can already see must not under-report either.
 */
function turnFor(
  group: MessageRow[],
  runs: Record<string, RunSummary>,
  endedRuns: Set<string>,
): TurnView {
  const head = group[0];
  const tail = group[group.length - 1];
  const runId = head.runId ?? `local:${head.id}`;
  const run = head.runId ? runs[head.runId] : undefined;

  const toolCalls = group
    .map(toolCallFromMessage)
    .filter((call): call is ToolCallView => call !== null);

  // Run-level, not group-level. `turn_end` is one row, and it lands in whatever
  // group happens to be open when it arrives — which, once prose has split a
  // turn in two, is routinely not the group holding the tool calls. Asking the
  // group left the visible half of a finished turn reading "running" forever.
  const sawTurnEnd = endedRuns.has(runKey(head));
  const started = run?.startedAt ? toDate(run.startedAt) : toDate(head.createdAt);
  const finished = run?.finishedAt ? toDate(run.finishedAt) : toDate(tail.createdAt);

  return {
    runId,
    status: run?.status ?? (sawTurnEnd ? "done" : "running"),
    toolCallCount: Math.max(run?.toolCallCount ?? 0, toolCalls.length),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    // Null unless the server actually sent usage. A `run.updated` frame carries
    // only `{id, status}`, so `run` existing proves nothing about tokens.
    tokens:
      run?.tokensIn === undefined && run?.tokensOut === undefined
        ? null
        : (run?.tokensIn ?? 0) + (run?.tokensOut ?? 0),
    toolCalls,
  };
}

/**
 * A `dispatch_request` message → the card.
 *
 * The card can render from the message alone (`metadata.dispatchId`, body as
 * the prompt) when `GET /api/dispatches` has not resolved or has aged the row
 * out of its 100-row window: a dispatch that renders as a blank row is worse
 * than one that renders with a conservative default.
 */
function dispatchFor(
  message: MessageRow,
  dispatches: Record<string, DispatchRow>,
  agentsById: Map<string, AgentView>,
  users: Record<string, UserView>,
): DispatchView {
  const meta = message.metadata ?? {};
  const dispatchId = str(meta.dispatchId) || message.id;
  const row = dispatches[dispatchId];

  const handle = (agentId: string | null | undefined): string =>
    (agentId ? agentsById.get(agentId)?.handle : undefined) ?? unknownAgent(agentId).handle;

  const status: DispatchStatus = row?.status ?? "pending";
  // `approved` with no decider is the channel's auto-approve, not a person —
  // the card says so, because "who allowed this" is the question you ask later.
  const autoApproved =
    meta.autoApproved === true || (status === "approved" && row != null && !row.decidedBy);

  return {
    id: dispatchId,
    fromHandle: handle(row?.fromAgentId ?? message.authorAgentId),
    toHandle: handle(row?.toAgentId),
    prompt: row?.prompt ?? message.body ?? "",
    approvedPrompt: row?.approvedPrompt ?? null,
    status,
    decidedByName: row?.decidedBy ? (users[row.decidedBy]?.name ?? "a member") : null,
    expiresAt: row
      ? toDate(row.expiresAt)
      : new Date(toDate(message.createdAt).getTime() + DEFAULT_DISPATCH_TTL_MS),
    autoApproved,
    runId: row?.createdRunId ?? null,
  };
}

/**
 * An `artifact` message → the inline card.
 *
 * `messages.body` holds the title at post time, so the card has a name even
 * before the artifact row itself is fetched.
 */
function artifactFor(message: MessageRow, artifacts: Record<string, ArtifactRow>): ArtifactView {
  const meta = message.metadata ?? {};
  const artifactId = str(meta.artifactId) || message.id;
  const row = artifacts[artifactId];
  const kind: ArtifactKind = row?.kind ?? "html";

  return {
    id: artifactId,
    kind,
    title: row?.title ?? message.body ?? null,
    sizeBytes: row?.sizeBytes ?? null,
    description: artifactDescription(kind),
    // `html` and `text` have a body on this origin; `link` and `file` do not,
    // and the server 404s their content route. Deciding that here rather than
    // in the card keeps the "what can be rendered" rule in one place, next to
    // the kind that determines it.
    contentUrl: hasBody(kind) ? artifactContentUrl(artifactId) : null,
    url: row?.url ?? null,
    contentType: row?.contentType ?? null,
  };
}

/** Kinds whose bytes live in `artifacts.body` rather than behind `artifacts.url`. */
export function hasBody(kind: ArtifactKind): boolean {
  return kind === "html" || kind === "text";
}

/**
 * Where a body is served from.
 *
 * A function, and exported, because the card renders this into an `iframe src`
 * and a test needs to assert the exact string. Encoded even though the id is a
 * uuid: it arrives from `messages.metadata`, which is written by an agent.
 */
export function artifactContentUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}
