/**
 * View models for the Channel View.
 *
 * Every type here is a *projection* of a real table in `src/db/schema.ts` —
 * `Pick<>`ed from the inferred row type wherever the shape allows it, so a
 * column rename breaks this file rather than silently rendering `undefined`.
 * The components are pure and presentational: they take these shapes and
 * nothing else. Server rows are projected onto them by `channel-mapping.ts`,
 * which is where every `messages.kind` → entry-kind decision lives.
 */

import type {
  Agent,
  Artifact,
  Channel,
  DispatchStatus,
  InjectionMode,
  RunStatus,
  User,
} from "@/db/schema";
import type { StatusTone } from "@/lib/agent-status";

/**
 * An agent as the roster, the mention autocomplete and every transcript row
 * need it. `status` and `activity` both travel: they are two independent
 * signals and no component may derive one from the other.
 *
 * `handle` is stored *without* the `@` (mention parsing lowercases and strips
 * before resolving); the UI adds the sigil when it renders.
 */
export type AgentView = Pick<
  Agent,
  "id" | "handle" | "displayName" | "status" | "activity" | "statusLine"
>;

/** A human, as an author or the signed-in user. */
export type UserView = Pick<User, "id" | "name"> & { role?: string | null };

/** A channel as the sidebar and header need it. */
export interface ChannelView extends Pick<
  Channel,
  | "id"
  | "slug"
  | "name"
  | "topic"
  | "gitRepoUrl"
  | "gitBranch"
  | "autoApproveDispatch"
  | "isPrivate"
> {
  /** Drives the unread pill. Derived server-side from `channel_members.last_read_at`. */
  unreadCount: number;
  /** Drives the mention dot — `messages.mentions @> [me]` since `last_read_at`. */
  hasMention: boolean;
  humanCount: number;
  agentCount: number;
}

/**
 * One row of an expanded agent turn.
 *
 * The sidecar supplies `glyph`/`verb`/`target`/`meta` already derived — the
 * client never re-parses raw tool input, because a single tool call can carry
 * an entire file.
 */
export interface ToolCallView {
  id: string;
  /** `◇`, `⌕`, `▶` … a single character, monospace-aligned. */
  glyph: string;
  /** Tone for the glyph only. The row itself stays quiet. */
  tone: StatusTone;
  /** `Read`, `Grep`, `Ran`, `Edit` … */
  verb: string;
  /** What it acted on. */
  target: string;
  /** Trailing measure — `340 ln`, `0.4s`, `—`. */
  meta: string;
}

/** A `runs` row, summarised for the collapsed turn header. */
export interface TurnView {
  runId: string;
  status: RunStatus;
  toolCallCount: number;
  durationMs: number;
  /**
   * `tokens_in + tokens_out`, or null when the client has no usage data.
   *
   * Nullable because "we were not told" and "the turn cost nothing" are
   * different facts and only one of them is ever true here. Rendering the
   * first as `0 tokens` invented a measurement.
   */
  tokens: number | null;
  toolCalls: ToolCallView[];
}

/**
 * An `artifacts` row rendered as an inline card.
 *
 * The card used to carry `previewNodes` — a hand-built list of chips standing
 * in for a render that did not exist yet. Every real artifact arrived with that
 * array empty, so the card drew an empty 150px box under a correct title, which
 * is the worst of both: it looks like the feature works and shows nothing.
 *
 * These three fields replace it with the real thing. Which one is populated is
 * decided by `kind` and nothing else:
 *
 * - `contentUrl` — same-origin route serving the body, for `html` and `text`.
 *   `null` for `link`/`file`, which have no body.
 * - `url` — the agent-supplied external location, for `link` and `file`. Never
 *   navigated to without `rel="noopener noreferrer"`, and never used as an
 *   iframe source.
 * - `contentType` — also agent-supplied, and shown to the reader rather than
 *   trusted; the server decides what a body is actually served as.
 */
export interface ArtifactView extends Pick<Artifact, "id" | "kind" | "title" | "sizeBytes"> {
  /** Human label under the title — "rendered HTML", "patch", … */
  description: string;
  contentUrl: string | null;
  url: string | null;
  contentType: string | null;
}

/** A `dispatch_requests` row plus the joined handles the card displays. */
export interface DispatchView {
  id: string;
  fromHandle: string;
  toHandle: string;
  prompt: string;
  /** Set by "Edit & approve"; NULL means the original was approved verbatim. */
  approvedPrompt: string | null;
  status: DispatchStatus;
  decidedByName: string | null;
  expiresAt: Date;
  /**
   * `status='approved'` with no `decided_by` — the channel's auto-approve
   * resolved it, not a person. The card still exists: auto-approve removes
   * the *hold*, not the *record*.
   */
  autoApproved: boolean;
  runId: string | null;
}

/**
 * A queued `runs` row, shown in place under the message that triggered it.
 * Queued work lives in the transcript; there is no separate outbox.
 */
export interface QueuedView {
  runId: string;
  agentHandle: string;
  /** Why it waits — the target agent's `status_line`. */
  reason: string;
  mode: InjectionMode;
}

interface EntryBase {
  id: string;
  /** `messages.seq` — monotonic, the keyset cursor. */
  seq: number;
  createdAt: Date;
}

/**
 * The five visually distinct transcript kinds, plus the quiet `system` line
 * that records channel-level changes (an auto-approve flip writes one).
 *
 * This union is the transcript's whole contract. `messages.kind` maps onto it:
 * `text` splits into `human`/`agent-text` by `author_kind`, `event` becomes
 * `turn`, and `artifact` / `dispatch_request` / `system` map straight across.
 */
export type TranscriptEntry =
  | (EntryBase & { kind: "human"; author: UserView; body: string; queued?: QueuedView })
  | (EntryBase & { kind: "agent-text"; agent: AgentView; body: string; artifact?: ArtifactView })
  | (EntryBase & { kind: "turn"; agent: AgentView; turn: TurnView })
  | (EntryBase & { kind: "artifact"; agent: AgentView; artifact: ArtifactView })
  | (EntryBase & { kind: "dispatch"; dispatch: DispatchView })
  | (EntryBase & { kind: "system"; body: string });

/** Delivery mode for the composer — mirrors `runs.injection_mode`. */
export type DeliveryMode = InjectionMode;
