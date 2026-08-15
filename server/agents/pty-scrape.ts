/**
 * The degraded transcript adapter, for CLIs with no structured session log.
 *
 * Claude Code writes JSONL we can tail from inside the container, so it gets a
 * rich transcript. Codex and Antigravity do not. For those, the only signal
 * available is the terminal output itself — and the server already has every
 * byte of it, because the PTY hub buffers the stream for scrollback replay.
 *
 * So this adapter runs **server-side**, subscribing to the hub, rather than
 * shipping a scraper into every image. Nothing needs to be installed in the
 * container for a BYO CLI to get a basic transcript.
 *
 * What it cannot do is worth stating plainly: it sees rendered output, not
 * structure. It cannot tell a tool call from prose, and it cannot see that the
 * TUI is sitting on a permission prompt rather than idle at its composer. That
 * second gap is the real fidelity cost — a queued prompt released against a
 * y/n dialog answers the dialog. The Claude Code adapter reads that state out
 * of the JSONL; this one is blind to it.
 */

/** Strip ANSI/VT control sequences, leaving human-readable text. */
export function stripAnsi(input: string): string {
  return (
    input
      // CSI sequences: colours, cursor moves, erase, SGR.
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // OSC sequences (window title, hyperlinks), terminated by BEL or ST.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Two-character escapes and charset selection.
      .replace(/\x1b[()#][0-9A-Za-z]/g, "")
      .replace(/\x1b[=><]/g, "")
      // Bracketed paste markers we ourselves emit during injection.
      .replace(/\x1b\[20[01]~/g, "")
      // Remaining C0 controls except tab and newline.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

/**
 * Collapse a terminal frame into plain lines.
 *
 * TUIs redraw constantly, so the same line arrives many times with different
 * spinner glyphs or progress counters. Trailing whitespace and carriage
 * returns are normalised so consecutive identical redraws can be deduped by
 * the caller rather than each becoming a transcript entry.
 */
export function toLines(chunk: string): string[] {
  return (
    stripAnsi(chunk)
      .replace(/\r\n/g, "\n")
      // A bare CR rewrites the current line; keep only what survived it.
      .split("\n")
      .map((line) => {
        const parts = line.split("\r");
        return parts[parts.length - 1].replace(/\s+$/, "");
      })
      .filter((line) => line.length > 0)
  );
}

/** Spinner frames and progress bars that carry no information once static. */
const NOISE_RE = /^[\s.·•▪▫◦‣⁃|/\\\-–—=*+~^<>[\]{}()]*$/u;

export function isNoise(line: string): boolean {
  if (line.length === 0) return true;
  if (NOISE_RE.test(line)) return true;
  // Braille spinner characters, used by most Node TUIs.
  if (/^[⠀-⣿\s]+$/u.test(line)) return true;
  return false;
}

export interface ScrapeState {
  /** Lines accumulated for the turn currently in progress. */
  buffer: string[];
  /** Timestamp of the last non-noise output. */
  lastOutputAt: number;
  /** Whether we believe a turn is underway. */
  busy: boolean;
  /** Deduplication of consecutive identical redraws. */
  lastLine: string | null;
}

export function initialScrapeState(now: number): ScrapeState {
  return { buffer: [], lastOutputAt: now, busy: false, lastLine: null };
}

export interface ScrapeConfig {
  /** Output must be quiet this long before a turn is considered finished. */
  quiescenceMs: number;
  /** Cap the buffer so a runaway process cannot exhaust memory. */
  maxBufferLines: number;
}

export const DEFAULT_SCRAPE_CONFIG: ScrapeConfig = {
  quiescenceMs: 2500,
  maxBufferLines: 500,
};

/**
 * Feed a terminal chunk into the state machine.
 *
 * Returns any events the chunk produced. `turn_start` fires on the first
 * meaningful output after a quiet period; `turn_end` is emitted by
 * `tickScrape` once output has been quiet long enough.
 */
export function feedScrape(
  state: ScrapeState,
  chunk: string,
  now: number,
  config: ScrapeConfig = DEFAULT_SCRAPE_CONFIG,
): Array<{ type: "turn_start"; at: number }> {
  const lines = toLines(chunk).filter((line) => !isNoise(line));
  if (lines.length === 0) return [];

  const events: Array<{ type: "turn_start"; at: number }> = [];
  if (!state.busy) {
    state.busy = true;
    events.push({ type: "turn_start", at: now });
  }

  for (const line of lines) {
    // Consecutive identical lines are redraws, not new output.
    if (line === state.lastLine) continue;
    state.lastLine = line;
    state.buffer.push(line);
  }

  // Keep the tail: the end of a turn is what a reader wants, and the head is
  // usually the echoed prompt they already saw in the channel.
  if (state.buffer.length > config.maxBufferLines) {
    state.buffer = state.buffer.slice(-config.maxBufferLines);
  }

  state.lastOutputAt = now;
  return events;
}

/**
 * Check whether the turn has gone quiet long enough to close.
 *
 * Returns the accumulated text and resets the buffer, or null if still busy.
 */
export function tickScrape(
  state: ScrapeState,
  now: number,
  config: ScrapeConfig = DEFAULT_SCRAPE_CONFIG,
): { text: string; at: number } | null {
  if (!state.busy) return null;
  if (now - state.lastOutputAt < config.quiescenceMs) return null;

  const text = state.buffer.join("\n").trim();
  state.buffer = [];
  state.busy = false;
  state.lastLine = null;

  return { text, at: now };
}

/** Is the agent idle by PTY quiescence alone? The only signal a scraped CLI has. */
export function isQuiescent(
  state: ScrapeState,
  now: number,
  config: ScrapeConfig = DEFAULT_SCRAPE_CONFIG,
): boolean {
  return !state.busy || now - state.lastOutputAt >= config.quiescenceMs;
}
