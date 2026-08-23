/**
 * Prompt injection encoder.
 *
 * PURE. No Docker, no I/O, no timers — it turns a prompt into the exact byte
 * chunks (and the gaps between them) that get written to an agent's PTY
 * stdin. The hub owns the writing and the mutex; this owns the bytes.
 *
 * Wire shape for a bracketed-paste injection in `interrupt` mode:
 *
 *   <interruptBytes>            wait postInterruptMs
 *   ESC [ 2 0 0 ~               (paste start)
 *   <body chunk 1>              wait chunkDelayMs
 *   <body chunk 2>              wait chunkDelayMs
 *   ...
 *   <body chunk n>
 *   ESC [ 2 0 1 ~               (paste end)   wait preSubmitMs
 *   <submitBytes>
 *
 * `queue` mode is identical minus the leading interrupt step. (Whether a
 * queued run is released now or parked until the agent reports idle is the
 * dispatcher's decision, not the encoder's.)
 */

import type { AdapterProfile } from "./adapters/profiles.js";
import { joinPreamble } from "./prompt-preamble.js";

export type InjectionMode = "queue" | "interrupt";

export const PASTE_START = Buffer.from("\x1b[200~", "ascii");
export const PASTE_END = Buffer.from("\x1b[201~", "ascii");

export interface InjectionOptions {
  /** `interrupt` prefixes the profile's interrupt key. Default `queue`. */
  mode?: InjectionMode;
  /** Send the submit key after the paste. Default true. */
  submit?: boolean;
  /**
   * Text prepended to the body inside the same paste.
   *
   * An opaque string on purpose. This module is the byte encoder and knows
   * nothing about channels; `agents/prompt-preamble.ts` decides what the line
   * says and how it joins. Passing a domain concept in here instead would put
   * workspace knowledge inside the one file whose contract is "pure bytes".
   *
   * It goes *inside* the paste rather than in a preceding write for two
   * reasons: outside a paste the bytes are keystrokes, and a leading `/`, `#`,
   * `!` or `@` triggers slash-command, memory, bash or file-mention modes on
   * one TUI or another; and a second write is a second mutex acquisition, so a
   * peer keystroke could land between the preamble and the prompt.
   */
  preamble?: string;
}

/** One stdin write plus the pause that must follow it. */
export interface InjectionStep {
  bytes: Buffer;
  /** Milliseconds to wait after this write before the next one. */
  delayAfterMs: number;
  /** Debug/telemetry label. Not written to the PTY. */
  kind: "interrupt" | "paste-start" | "body" | "paste-end" | "submit";
}

/**
 * Normalize prompt text for a PTY composer.
 *
 * - CRLF and lone CR collapse to LF. A stray CR inside a paste reads as a
 *   submit in several TUIs, which would fire the prompt one line at a time.
 * - ESC and the other C0 controls are stripped (TAB and LF survive). A body
 *   containing a literal `ESC[201~` would otherwise close paste mode early
 *   and the remainder of the prompt would be interpreted as keystrokes —
 *   i.e. untrusted prompt text could drive the TUI's key bindings.
 * - Trailing newlines are trimmed: submission is explicit via `submitBytes`,
 *   and a trailing LF inside the paste double-submits on some apps.
 */
export function normalizePromptText(text: string): string {
  let out = "";
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0)!;
    if (code === 0x0a || code === 0x09) {
      out += ch;
      continue;
    }
    // C0 controls (incl. ESC 0x1b) and DEL.
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.replace(/\n+$/, "");
}

/**
 * Split a buffer into <= `size` byte pieces without ever cutting a UTF-8
 * sequence in half — a split multi-byte character can surface as a
 * replacement glyph in the composer, and the prompt is user-visible text.
 */
export function chunkUtf8(buf: Buffer, size: number): Buffer[] {
  const limit = Math.max(1, Math.floor(size));
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    let end = Math.min(offset + limit, buf.length);
    if (end < buf.length) {
      // Walk back off any continuation byte (0b10xxxxxx) so the cut lands on
      // a lead byte. Bounded by 3 steps — the max UTF-8 sequence tail.
      let back = 0;
      while (end > offset + 1 && back < 3 && (buf[end] & 0xc0) === 0x80) {
        end--;
        back++;
      }
    }
    chunks.push(buf.subarray(offset, end));
    offset = end;
  }

  return chunks;
}

/**
 * Build the full injection plan: bytes plus the gap that must follow each
 * write. Pure and deterministic — this is what the byte-sequence tests pin.
 */
export function planInjection(
  text: string,
  profile: AdapterProfile,
  opts: InjectionOptions = {},
): InjectionStep[] {
  const mode: InjectionMode = opts.mode ?? "queue";
  const submit = opts.submit ?? true;

  const steps: InjectionStep[] = [];
  // Joined before normalisation, so one pass covers both and a preamble cannot
  // smuggle in a control character the body would have had stripped.
  const body = normalizePromptText(
    joinPreamble(opts.preamble ?? "", normalizePromptText(text), profile.bracketedPaste),
  );

  if (mode === "interrupt" && profile.interruptBytes.length > 0) {
    steps.push({
      bytes: Buffer.from(profile.interruptBytes),
      delayAfterMs: profile.postInterruptMs,
      kind: "interrupt",
    });
  }

  // Nothing to type. An interrupt-only injection is still meaningful (stop
  // what you're doing); an empty queue-mode injection is a no-op, and we
  // must not submit an empty composer.
  if (body.length === 0) return steps;

  const chunks = chunkUtf8(Buffer.from(body, "utf-8"), profile.chunkBytes);

  if (profile.bracketedPaste) {
    steps.push({ bytes: PASTE_START, delayAfterMs: 0, kind: "paste-start" });
  }

  chunks.forEach((chunk, i) => {
    const isLast = i === chunks.length - 1;
    steps.push({
      bytes: chunk,
      // The gap before the paste-end marker is not a chunk gap; the settle
      // time before submitting is `preSubmitMs`, applied below.
      delayAfterMs: isLast ? 0 : profile.chunkDelayMs,
      kind: "body",
    });
  });

  if (profile.bracketedPaste) {
    steps.push({
      bytes: PASTE_END,
      delayAfterMs: submit ? profile.preSubmitMs : 0,
      kind: "paste-end",
    });
  } else if (submit) {
    steps[steps.length - 1] = {
      ...steps[steps.length - 1],
      delayAfterMs: profile.preSubmitMs,
    };
  }

  if (submit && profile.submitBytes.length > 0) {
    steps.push({
      bytes: Buffer.from(profile.submitBytes),
      delayAfterMs: 0,
      kind: "submit",
    });
  }

  return steps;
}

/**
 * The byte chunks of an injection, in order. Thin pure wrapper over
 * {@link planInjection} for callers that only care about what lands on the
 * wire (the hub uses `planInjection` because it also needs the gaps).
 */
export function encodeInjection(
  text: string,
  profile: AdapterProfile,
  opts: InjectionOptions = {},
): Buffer[] {
  return planInjection(text, profile, opts).map((s) => s.bytes);
}

/** Total wall-clock time an injection will take, ignoring write latency. */
export function injectionDurationMs(steps: InjectionStep[]): number {
  return steps.reduce((acc, s) => acc + s.delayAfterMs, 0);
}
