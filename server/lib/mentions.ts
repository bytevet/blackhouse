/**
 * Mention parsing.
 *
 * The client's autocomplete triggers on `/(^|\s)@[\w-]*$/`; this module has to
 * agree with it about what a handle looks like, or the UI will offer a
 * completion the server then refuses to route. Both sides therefore use the
 * same character class: `[a-z0-9_-]`.
 *
 * Deliberately kept pure and dependency-free so it can be exhaustively tested
 * without a database — mention routing is what turns a chat message into a
 * container writing bytes onto a PTY, so getting it wrong is expensive.
 */

/** A handle occurrence in a message body. */
export interface ParsedMention {
  /** Handle without the leading `@`, lowercased. */
  handle: string;
  /** Index of the `@` in the source string. */
  start: number;
  /** Index one past the last handle character. */
  end: number;
}

/**
 * A mention's `@` must not be preceded by a word character, `.`, `-` or `@`.
 * That rule is what stops `dana@example.com` and `foo@1.2.3` from mentioning
 * `@example` / `@1` — while still allowing the punctuation people actually
 * wrap handles in, like `(@reviewer)` or `"@scout"`.
 *
 * Note the deliberate asymmetry with the client: its autocomplete triggers on
 * `/(^|\s)@[\w-]*$/`, which is stricter, because that regex answers a
 * different question — "should I pop the completion list at the caret?" The
 * consequence is only that typing `(@` offers no suggestions; the mention
 * still routes once sent. Erring stricter on the trigger and looser on the
 * parser is the safe direction. The reverse would offer completions the
 * server then silently drops.
 */
const MENTION_RE = /(?<![\w.@-])@([a-z0-9][a-z0-9_-]*)/gi;

/** Spans of the body that are inside fenced or inline code. */
function codeSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  // Fenced blocks first — an inline-code scan would otherwise match backticks
  // that belong to a fence.
  const fence = /```[\s\S]*?(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(body))) spans.push([m.index, m.index + m[0].length]);

  const inline = /`[^`\n]*`/g;
  while ((m = inline.exec(body))) {
    const [s, e] = [m.index, m.index + m[0].length];
    if (!spans.some(([fs, fe]) => s >= fs && e <= fe)) spans.push([s, e]);
  }

  return spans;
}

function inSpans(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([s, e]) => index >= s && index < e);
}

/**
 * Extract every mention in `body`, skipping code.
 *
 * Agents are routinely asked about code containing `@` — decorators, npm
 * scopes, email addresses in fixtures — and dispatching a container run
 * because someone pasted `@types/node` in a snippet would be both surprising
 * and billable.
 */
export function parseMentions(body: string): ParsedMention[] {
  if (!body) return [];
  const skip = codeSpans(body);
  const out: ParsedMention[] = [];
  const seen = new Set<string>();

  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body))) {
    // The lookbehind is zero-width, so `m.index` is the `@` itself.
    const start = m.index;
    if (inSpans(start, skip)) continue;

    const handle = m[1].toLowerCase();
    // One run per agent per message, however many times it is named.
    if (seen.has(handle)) continue;
    seen.add(handle);

    out.push({ handle, start, end: start + 1 + m[1].length });
  }

  return out;
}

/** Just the distinct handles, in order of first appearance. */
export function mentionedHandles(body: string): string[] {
  return parseMentions(body).map((m) => m.handle);
}

/** Does this body mention the given handle? Case-insensitive. */
export function mentions(body: string, handle: string): boolean {
  const target = handle.replace(/^@/, "").toLowerCase();
  return mentionedHandles(body).includes(target);
}
