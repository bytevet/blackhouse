/**
 * Polling multi-file tailer.
 *
 * WHY POLLING AND NOT `fs.watch`: the agent's session log lives on an
 * overlayfs upper layer and/or inside a named volume mount. inotify — which
 * is what `fs.watch` is on Linux — silently misses events on both: overlayfs
 * only forwards events for the layer the watch was installed on, and a
 * bind/volume mount can be written by a different mount namespace entirely.
 * A missed event is indistinguishable from an idle agent, which is exactly
 * the failure we cannot tolerate here. ~500ms polling costs one `stat` per
 * file per tick and never lies.
 *
 * Watermarks are byte offsets, and the offset we persist is always
 * LINE-ALIGNED: it points at the first byte of the trailing *incomplete*
 * line, never into the middle of one. A restart therefore re-reads the
 * partial line and loses nothing. The in-memory `pending` buffer is purely
 * an optimisation so we don't re-read those bytes every tick.
 *
 * Partial-line handling is done on Buffers, not strings, so a multi-byte
 * UTF-8 sequence split across a read boundary can never be corrupted into
 * U+FFFD.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

export const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string[]} options.roots            directories scanned recursively
 * @param {(p: string) => boolean} [options.filter]
 * @param {number} [options.maxReadBytes]     cap on bytes pulled per file per tick
 * @param {number} [options.maxDepth]         recursion depth guard
 * @param {(msg: string, err?: unknown) => void} [options.onWarn]
 */
export function createTailer(options = {}) {
  const roots = options.roots ?? [];
  const filter = options.filter ?? ((p) => p.endsWith(".jsonl"));
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxDepth = options.maxDepth ?? 6;
  const onWarn = options.onWarn ?? (() => {});

  /** @type {Map<string, {consumed: number, pending: Buffer}>} */
  const files = new Map();

  function entryFor(filePath) {
    let entry = files.get(filePath);
    if (!entry) {
      entry = { consumed: 0, pending: EMPTY };
      files.set(filePath, entry);
    }
    return entry;
  }

  async function discover() {
    /** @type {string[]} */
    const found = [];
    for (const root of roots) {
      await walk(root, 0, found);
    }
    return found.sort();
  }

  async function walk(dir, depth, out) {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Root may not exist yet — the agent CLI creates it on first run.
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      try {
        if (dirent.isDirectory()) {
          await walk(full, depth + 1, out);
        } else if (dirent.isFile() && filter(full)) {
          out.push(full);
        }
      } catch (err) {
        onWarn(`walk failed for ${full}`, err);
      }
    }
  }

  /**
   * Read every complete line appended since the last poll.
   * @returns {Promise<Array<{path: string, offset: number, line: string}>>}
   */
  async function pollFile(filePath) {
    const entry = entryFor(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    let readPos = entry.consumed + entry.pending.length;

    // File shrank: truncated or replaced. Rewind and re-read from the top —
    // idempotency is handled by `sourceRef`, so replaying is free.
    if (stat.size < readPos) {
      entry.consumed = 0;
      entry.pending = EMPTY;
      readPos = 0;
    }
    if (stat.size === readPos) return [];

    const length = Math.min(stat.size - readPos, maxReadBytes);
    const buf = Buffer.allocUnsafe(length);
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      await handle.read(buf, 0, length, readPos);
    } catch (err) {
      onWarn(`read failed for ${filePath}`, err);
      return [];
    } finally {
      if (handle) await handle.close().catch(() => {});
    }

    const data = entry.pending.length ? Buffer.concat([entry.pending, buf]) : buf;
    const base = entry.consumed; // byte offset of data[0] within the file

    const out = [];
    let cursor = 0;
    let idx;
    while ((idx = data.indexOf(NEWLINE, cursor)) !== -1) {
      const lineBuf = data.subarray(cursor, idx);
      const text = lineBuf.toString("utf8").replace(/\r$/, "");
      if (text.trim().length > 0) {
        out.push({ path: filePath, offset: base + cursor, line: text });
      }
      cursor = idx + 1;
    }

    // Copy rather than `subarray` — subarray keeps the whole read buffer alive.
    entry.pending = cursor < data.length ? Buffer.from(data.subarray(cursor)) : EMPTY;
    entry.consumed = base + cursor;
    return out;
  }

  return {
    /** Discover, then drain, every tracked file. Never throws. */
    async poll() {
      /** @type {Array<{path: string, offset: number, line: string}>} */
      const lines = [];
      let paths;
      try {
        paths = await discover();
      } catch (err) {
        onWarn("discover failed", err);
        paths = [...files.keys()];
      }
      for (const filePath of paths) {
        try {
          const chunk = await pollFile(filePath);
          if (chunk.length) lines.push(...chunk);
        } catch (err) {
          // A single bad file must never stop the loop or drop a watermark.
          onWarn(`poll failed for ${filePath}`, err);
        }
      }
      return lines;
    },

    /** Line-aligned offsets, safe to persist and reload. */
    watermarks() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const [filePath, entry] of files) out[filePath] = entry.consumed;
      return out;
    },

    /** Restore persisted watermarks. Unknown/garbage values are ignored. */
    load(watermarks) {
      if (!watermarks || typeof watermarks !== "object") return;
      for (const [filePath, offset] of Object.entries(watermarks)) {
        if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) {
          files.set(filePath, { consumed: Math.floor(offset), pending: EMPTY });
        }
      }
    },

    /** Test/introspection hook. */
    tracked() {
      return [...files.keys()];
    },

    discover,
  };
}
