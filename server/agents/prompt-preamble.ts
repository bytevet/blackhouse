/**
 * The one line that tells an agent where it is.
 *
 * An agent is a process on a PTY, and until now the only thing written to that
 * PTY was the human's message body. Nothing said which channel the mention came
 * from — so `post.sh '#channel'` and `submit-result.sh '#channel'` asked the
 * agent for a fact it had never been given, and with membership in more than
 * one room the destination was a guess.
 *
 * The consequence was not a subtle one. Asked to build an HTML report, an agent
 * built it and published it to an external service, because that was the only
 * delivery path it could actually complete. The channel it was answering in
 * showed nothing.
 *
 * This is a hint, not an authority. The agent sees one flat stream of text, so
 * a human whose message opens with a line imitating this one is
 * indistinguishable from the harness. Where the write actually lands is decided
 * server-side in `api/agent-runtime.ts` (`resolveTargetChannel`), which is why
 * this can afford to be short and unguarded.
 */

/** Kept well under a terminal line: this lands in a TUI a human is watching. */
const MAX_SLUG = 64;

export interface PreambleInput {
  /** Channel slug, with or without a leading `#`. Null when there is no channel. */
  slug: string | null | undefined;
  /**
   * Whether the profile wraps the injection in bracketed paste.
   *
   * Load-bearing, not cosmetic. Without bracketed paste the bytes are typed as
   * *keystrokes*, and a newline is Enter on most TUIs — a two-line preamble
   * would submit itself and leave the real prompt behind in an empty composer.
   * So the paste-capable profiles get a readable two-line form and the others
   * get one line with no LF at all.
   */
  bracketedPaste: boolean;
}

/**
 * Render the preamble, or `""` when there is no channel to name.
 *
 * Returning `""` rather than throwing is deliberate: `runs.channelId` is
 * nullable and the raw inject endpoint has no channel by definition. An agent
 * without the line is where we started; an agent told `channel #undefined` is
 * worse.
 */
export function channelPreamble(input: PreambleInput): string {
  const slug = input.slug?.trim().replace(/^#/, "").slice(0, MAX_SLUG);
  if (!slug) return "";
  return `[blackhouse] channel #${slug} — reply here.`;
}

/**
 * Join the preamble to the body the way this profile can survive.
 *
 * The join happens *before* normalisation so one pass covers both, and so a
 * preamble can never smuggle in a control character that the body would have
 * had stripped.
 */
export function joinPreamble(preamble: string, body: string, bracketedPaste: boolean): string {
  if (!preamble) return body;
  if (!body) return body;
  return bracketedPaste ? `${preamble}\n\n${body}` : `${preamble} ${body}`;
}
