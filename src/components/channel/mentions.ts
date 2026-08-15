/**
 * Mention parsing for the composer and the transcript.
 *
 * There is exactly one definition of "what a handle looks like" in this file,
 * and the server (`server/lib/mentions.ts`) parses with the same rule. If the
 * two ever disagree the UI shows a chip for something that never gets a run,
 * or worse, silently dispatches an agent the author did not visibly mention.
 */

/**
 * The autocomplete trigger, **verbatim from the design prototype**.
 *
 * Anchored at the end because it runs against the text *before the caret*:
 * the listbox opens while the handle is still being typed, and closes as soon
 * as a space is committed. `(^|\s)` is what keeps `a@b.com` from opening it.
 */
export const MENTION_TRIGGER = /(^|\s)@[\w-]*$/;

/**
 * The body parser — the same handle rule, unanchored and global, with the
 * handle captured. `[\w-]+` (not `*`) because a bare `@` mentions nobody.
 *
 * Consequences worth stating, since they are the test cases:
 * - `a@b.com` does not match: the `@` is preceded by a word character.
 * - `@scout,` matches `scout`: `,` is not in `[\w-]`, so it stops the handle.
 * - `@Scout` matches `Scout`; resolution lowercases (handles are unique on
 *   `lower(handle)`).
 */
const MENTION_PATTERN = /(^|\s)@([\w-]+)/g;

/** A syntactic mention found in a message body. */
export interface ParsedMention {
  /** The handle as typed, without the `@`. */
  handle: string;
  /** Offset of the `@` in the original body. */
  index: number;
  /** Length of `@handle`, so `body.slice(index, index + length)` round-trips. */
  length: number;
}

/**
 * Blank out fenced (```…```) and inline (`…`) code spans, preserving offsets
 * by replacing each character with a space.
 *
 * Code is quoted text, not speech: `@scout` inside a snippet is a code sample
 * and must not dispatch an agent. Replacing rather than removing keeps every
 * index in the returned mentions valid against the *original* string.
 */
function maskCode(body: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, blank) // fenced, including an unclosed trailing fence
    .replace(/`[^`\n]*`/g, blank); // inline
}

/**
 * Every `@handle` in a body, in source order, with offsets.
 *
 * Duplicates are returned as written — one chip per occurrence. Deduping is
 * the caller's job (`message_mentions` is unique on `(message_id, agent_id)`,
 * so mentioning `@scout` twice is still one run).
 */
export function parseMentions(body: string): ParsedMention[] {
  const masked = maskCode(body);
  const out: ParsedMention[] = [];
  // The regex is module-level and stateful (`g`), so reset before each use.
  MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(masked)) !== null) {
    const lead = match[1].length; // 0 or 1 — the `(^|\s)` group
    const handle = match[2];
    out.push({ handle, index: match.index + lead, length: handle.length + 1 });
  }
  return out;
}

/** Handles only, lowercased and deduped — what you post to the server. */
export function mentionedHandles(body: string): string[] {
  const seen = new Set<string>();
  for (const m of parseMentions(body)) seen.add(m.handle.toLowerCase());
  return [...seen];
}

/** State of an in-progress mention at the caret, or `null` when there is none. */
export interface MentionQuery {
  /** Text typed after the `@`, possibly empty. Lowercased for matching. */
  query: string;
  /** Offset of the `@`, so a pick can splice the handle in. */
  start: number;
}

/**
 * Is the caret sitting in a mention right now? Drives the autocomplete.
 *
 * `caret` defaults to end-of-text; pass `selectionStart` to keep the listbox
 * correct when the author edits in the middle of a line.
 */
export function findMentionQuery(text: string, caret: number = text.length): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = MENTION_TRIGGER.exec(before);
  if (!match) return null;
  const start = match.index + match[1].length;
  return { query: before.slice(start + 1).toLowerCase(), start };
}

/** Replace the in-progress mention at `caret` with `@handle `. */
export function applyMention(text: string, caret: number, handle: string): string {
  const found = findMentionQuery(text, caret);
  if (!found) return text;
  return `${text.slice(0, found.start)}@${handle} ${text.slice(caret)}`;
}

/** A body split into plain runs and mention runs, ready to render. */
export type BodySegment =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; handle: string; known: boolean };

/**
 * Split a body for rendering. Handles not in `knownHandles` come back with
 * `known: false` so the UI can render them as plain text — a chip for an agent
 * that does not exist promises a dispatch that will never happen.
 */
export function segmentBody(body: string, knownHandles: Iterable<string>): BodySegment[] {
  const known = new Set([...knownHandles].map((h) => h.toLowerCase()));
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const mention of parseMentions(body)) {
    if (mention.index > cursor) {
      segments.push({ type: "text", text: body.slice(cursor, mention.index) });
    }
    segments.push({
      type: "mention",
      text: body.slice(mention.index, mention.index + mention.length),
      handle: mention.handle,
      known: known.has(mention.handle.toLowerCase()),
    });
    cursor = mention.index + mention.length;
  }
  if (cursor < body.length) segments.push({ type: "text", text: body.slice(cursor) });
  return segments;
}
