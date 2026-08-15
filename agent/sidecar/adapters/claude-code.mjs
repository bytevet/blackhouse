/**
 * Claude Code JSONL adapter.
 *
 * Claude Code appends one JSON object per line to
 * `$CLAUDE_CONFIG_DIR/projects/<slugified-cwd>/<session-uuid>.jsonl`.
 * Each line is one "entry": a user turn, an assistant turn (which may itself
 * contain several content blocks), a system note, or a summary.
 *
 * This file is the ONLY place that knows that format. Everything downstream —
 * the tailer, the poster, the server — speaks the event union in
 * `server/agents/events.ts` and never sees a Claude-shaped object again.
 *
 * THE FORMAT IS UNDOCUMENTED AND VERSION-COUPLED. Every function here is
 * written to survive a field that moved, a type that is new, or a line that is
 * not JSON at all. The rules, in priority order:
 *
 *   1. Never throw. A mapping failure returns a `raw` event, not an exception,
 *      because an exception would stop the tail loop and take the whole
 *      transcript down with it.
 *   2. An entry type we do not recognise becomes `raw` carrying the entry.
 *      Coarse but alive beats silent and dead.
 *   3. Never emit a full tool input. One `Write` call can carry an entire
 *      file; shipping that to the server on every keystroke-equivalent would
 *      be the single largest source of traffic in the system. We send a
 *      digest (byte count, key names, identifying fields) plus a bounded
 *      preview.
 */

import { createHash } from "node:crypto";

/** Mirrors TOOL_INPUT_PREVIEW_LIMIT in server/agents/events.ts. */
export const PREVIEW_LIMIT = 2048;

/**
 * Timing profile for this adapter. Per the plan these are per-adapter, not
 * global: a CLI that flushes its log lazily needs a longer quiet window than
 * one that flushes per block, and the only way to know is to measure.
 */
export const profile = {
  pollIntervalMs: 500,
  /** JSONL silence after which a finished-looking turn counts as idle. */
  idleQuietMs: 1500,
  /** Upper bound between `state` posts, transition or not. */
  heartbeatMs: 10_000,
};

/**
 * Tool input keys worth keeping verbatim (truncated). These are exactly the
 * keys `targetFor()` on the server reads to render the transcript row
 * `◇ Read src/db/schema.ts 340 ln`. Anything not on this list is represented
 * only by its name in `inputKeys` and by the bounded preview.
 */
const IDENTIFYING_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "url",
  "prompt",
  "pattern",
  "command",
  "glob",
  "query",
  "description",
  "subagent_type",
  "limit",
  "offset",
];

/** Truncate to a bounded preview, marked so a reader knows it is partial. */
export function preview(value, limit = PREVIEW_LIMIT) {
  const text = typeof value === "string" ? value : safeJson(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (${text.length - limit} more chars)`;
}

function safeJson(value) {
  try {
    const out = JSON.stringify(value ?? "");
    return typeof out === "string" ? out : String(value);
  } catch {
    // Circular or BigInt-bearing. Losing the detail is fine; throwing is not.
    return String(value);
  }
}

function byteLength(text) {
  return Buffer.byteLength(typeof text === "string" ? text : safeJson(text), "utf8");
}

/**
 * Deterministic fallback identity for a line with no `uuid`.
 *
 * Deterministic matters: the server dedups on `(agentId, sourceRef)`, so a
 * container restart that rewinds to an earlier offset must produce the same
 * ref for the same bytes, or the transcript grows duplicates every reboot.
 */
export function fallbackSourceRef(path, offset) {
  return createHash("sha1").update(`${path}:${offset}`).digest("hex");
}

/**
 * One line can produce several events (an assistant turn with two tool calls
 * plus usage is four). They share the entry's identity and are distinguished
 * by their index, which keeps every ref stable under replay.
 */
function refFor(base, index) {
  return `${base}:${index}`.slice(0, 200);
}

function isoOrUndefined(value) {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/** Content blocks arrive as an array, or as a bare string for plain text. */
function contentBlocks(message) {
  if (!message || typeof message !== "object") return [];
  const content = message.content;
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  return [];
}

/** Short, human-meaningful right-hand column for a tool row. */
function metaFor(name, input) {
  const lower = String(name).toLowerCase();
  if (lower === "write" || lower === "edit" || lower === "multiedit") {
    const body = input.content ?? input.new_string ?? "";
    const bytes = byteLength(body);
    return bytes ? formatBytes(bytes) : "";
  }
  if (lower === "read") {
    return typeof input.limit === "number" ? `${input.limit} ln` : "";
  }
  if (lower === "todowrite") {
    return Array.isArray(input.todos) ? `${input.todos.length} items` : "";
  }
  return "";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reduce a tool input to something safe to store forever.
 *
 * `input` keeps only identifying fields, each individually clamped, so the
 * server can derive glyph/verb/target/meta without ever seeing the payload.
 * `inputPreview` is the bounded look at the whole thing for a human debugging
 * a run. `inputBytes` and `inputKeys` are the digest — they answer "what was
 * actually sent" without storing it.
 */
export function digestToolInput(name, rawInput) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const identifying = {};
  for (const key of IDENTIFYING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      identifying[key] = preview(value, 512);
    } else if (typeof value === "number" || typeof value === "boolean") {
      identifying[key] = value;
    }
  }
  const serialised = safeJson(input);
  return {
    toolName: String(name ?? "tool"),
    input: identifying,
    inputKeys: Object.keys(input).slice(0, 40),
    inputBytes: byteLength(serialised),
    inputPreview: preview(serialised, PREVIEW_LIMIT),
    meta: metaFor(name, input),
  };
}

/** Flatten a tool_result's content, which may be text blocks or a bare string. */
function toolResultText(block) {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return safeJson(part);
      })
      .join("\n");
  }
  if (content == null) return "";
  return safeJson(content);
}

function usagePayload(message, entry) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cost = entry.costUSD ?? entry.costUsd ?? entry.cost_usd;
  const payload = {
    model: typeof message.model === "string" ? message.model : undefined,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
  };
  if (typeof cost === "number" && Number.isFinite(cost)) payload.costUsd = cost;
  if (typeof entry.durationMs === "number") payload.durationMs = entry.durationMs;
  // A turn with a cached-only response can report zero of everything; still
  // worth emitting, because its absence is indistinguishable from a gap.
  return payload;
}

/**
 * `stop_reason` tells us whether the model handed control back to the human or
 * is waiting on a tool it just called. Only the former ends a turn — treating
 * a `tool_use` stop as a turn end would mark the agent idle mid-task and
 * release a queued prompt into the middle of its work.
 */
function endsTurn(message) {
  const reason = message?.stop_reason ?? message?.stopReason;
  if (reason == null) return false;
  return reason !== "tool_use" && reason !== "max_tokens";
}

/**
 * Map one already-parsed entry to zero or more events.
 *
 * @param {object} entry     the parsed JSONL object
 * @param {object} ctx       `{ path, offset, seq }`
 * @returns {{events: Array<object>, nextSeq: number}}
 */
export function mapEntry(entry, ctx) {
  const seqStart = Number.isFinite(ctx?.seq) ? ctx.seq : 0;
  const base =
    typeof entry?.uuid === "string" && entry.uuid
      ? entry.uuid
      : fallbackSourceRef(ctx?.path ?? "", ctx?.offset ?? 0);
  const occurredAt = isoOrUndefined(entry?.timestamp);
  const externalRunId =
    typeof entry?.sessionId === "string" && entry.sessionId
      ? entry.sessionId.slice(0, 200)
      : undefined;

  const events = [];
  const push = (type, payload) => {
    const event = {
      sourceRef: refFor(base, events.length),
      seq: seqStart + events.length,
      type,
      payload: payload ?? {},
    };
    if (occurredAt) event.occurredAt = occurredAt;
    if (externalRunId) event.externalRunId = externalRunId;
    events.push(event);
  };

  try {
    build(entry, push);
  } catch {
    // Rule 1. A bug in the mapping above must not cost us the line.
    events.length = 0;
    push("raw", {
      entryType: typeof entry?.type === "string" ? entry.type : "unknown",
      ...rawOf(entry),
    });
  }

  if (events.length === 0) {
    // An entry we understood but that carried nothing renderable (an empty
    // assistant block, a meta line). Recorded as `raw` so provenance survives
    // and the watermark still advances past it.
    push("raw", {
      entryType: typeof entry?.type === "string" ? entry.type : "unknown",
      ...rawOf(entry),
    });
  }

  return { events, nextSeq: seqStart + events.length };
}

/**
 * `raw` carries the entry itself when that is affordable, and a bounded
 * preview when it is not — a single pasted file in an unknown entry type
 * should not push a 5MB body at the ingest endpoint.
 */
const RAW_INLINE_LIMIT = 16 * 1024;

function rawOf(entry) {
  const serialised = safeJson(entry);
  if (serialised.length <= RAW_INLINE_LIMIT && entry && typeof entry === "object") {
    return { entry };
  }
  return { entryPreview: preview(serialised, PREVIEW_LIMIT), entryBytes: byteLength(serialised) };
}

function build(entry, push) {
  const type = entry?.type;

  if (type === "user") {
    const blocks = contentBlocks(entry.message);
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      for (const block of results) {
        const text = toolResultText(block);
        push("tool_result", {
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
          isError: block.is_error === true,
          resultBytes: byteLength(text),
          lines: text ? text.split("\n").length : 0,
          preview: preview(text, PREVIEW_LIMIT),
        });
      }
      return;
    }

    // A real human (or injected) prompt. `isMeta` marks Claude Code's own
    // bookkeeping injections, which are not turns and must not open one.
    if (entry.isMeta === true) {
      push("status", { subtype: "meta", text: preview(textOf(blocks), 512) });
      return;
    }
    push("turn_start", {
      source: "user",
      text: preview(textOf(blocks), PREVIEW_LIMIT),
      isSidechain: entry.isSidechain === true,
    });
    return;
  }

  if (type === "assistant") {
    const message = entry.message ?? {};
    const model = typeof message.model === "string" ? message.model : undefined;
    for (const block of contentBlocks(message)) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        push("assistant_text", { text: block.text, model });
      } else if (block.type === "tool_use") {
        push("tool_use", {
          toolUseId: typeof block.id === "string" ? block.id : undefined,
          ...digestToolInput(block.name, block.input),
        });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        // Deliberately not transcribed. Extended thinking is long, and the
        // channel is a conversation, not a debugger.
        push("status", { subtype: "thinking", model });
      }
    }

    const usage = usagePayload(message, entry);
    if (usage) push("usage", usage);

    if (endsTurn(message)) {
      push("turn_end", {
        stopReason: message.stop_reason ?? message.stopReason,
        model,
        durationMs: typeof entry.durationMs === "number" ? entry.durationMs : undefined,
      });
    }
    return;
  }

  if (type === "summary") {
    push("status", {
      subtype: "summary",
      text: preview(entry.summary ?? "", PREVIEW_LIMIT),
    });
    return;
  }

  if (type === "system") {
    push("status", {
      subtype: typeof entry.subtype === "string" ? entry.subtype : "system",
      text: preview(entry.content ?? entry.text ?? "", PREVIEW_LIMIT),
      level: typeof entry.level === "string" ? entry.level : undefined,
    });
    return;
  }

  // Rule 2: unknown type, whole object, keep going.
  push("raw", { entryType: typeof type === "string" ? type : "unknown", ...rawOf(entry) });
}

function textOf(blocks) {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Map one raw JSONL line. A line that is not JSON is still an event — it is
 * evidence the format changed, which is exactly what we want to see in the
 * transcript rather than swallow.
 *
 * @param {{line: string, path: string, offset: number, seq: number}} input
 */
export function mapLine({ line, path, offset, seq }) {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text) return { events: [], nextSeq: seq };

  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return {
      events: [
        {
          sourceRef: refFor(fallbackSourceRef(path, offset), 0),
          seq,
          type: "raw",
          payload: { parseError: true, linePreview: preview(text, PREVIEW_LIMIT) },
        },
      ],
      nextSeq: seq + 1,
    };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      events: [
        {
          sourceRef: refFor(fallbackSourceRef(path, offset), 0),
          seq,
          type: "raw",
          payload: { entryType: "unknown", entryPreview: preview(text, PREVIEW_LIMIT) },
        },
      ],
      nextSeq: seq + 1,
    };
  }

  return mapEntry(entry, { path, offset, seq });
}

/** Directories this adapter tails. */
export function roots(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || `${env.HOME || "/home/workspace"}/.claude`;
  return [`${configDir}/projects`];
}

/** Only session logs, and never the temp files an editor might leave behind. */
export function fileFilter(filePath) {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  return name.endsWith(".jsonl") && !name.startsWith(".");
}

/**
 * Which event types mean "the agent has stopped and is waiting for a human".
 * The other half of the idle test is JSONL silence; see `profile.idleQuietMs`.
 */
export const TERMINAL_EVENT_TYPES = new Set(["assistant_text", "turn_end"]);

export default {
  name: "claude-code",
  profile,
  roots,
  fileFilter,
  mapLine,
  mapEntry,
  TERMINAL_EVENT_TYPES,
};
