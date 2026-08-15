/**
 * Server-owned PTY hub.
 *
 * Ownership of a container's terminal session used to live in
 * `server/ws/terminal.ts`, where the first WebSocket peer attached lazily and
 * the last one to disconnect left the stream dangling. The hub owns the
 * attach for the container's lifetime instead; WS peers are subscribers, and
 * so is the injector.
 *
 * Deliberately schema-free: it never touches `coding_sessions` or `agents`.
 * The caller supplies `resolveContainer(targetId)`, so the same hub serves
 * today's sessions and tomorrow's agents.
 *
 * Carried over verbatim from terminal.ts (do not "clean up" — these encode
 * hard-won knowledge about dockerode's attach stream):
 *   - the 256KB scrollback ring buffer, replayed to every new peer
 *   - multi-peer broadcast
 *   - `stripAttachMetadata` with its 10-chunk / 2-second grace window
 *   - `stripDockerLogHeaders`
 */

export const SCROLLBACK_LIMIT = 256 * 1024; // 256KB of recent output

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;

/** Frame types on the terminal WebSocket. Mirrors `src/components/terminal.tsx`. */
export const FRAME_DATA = 0x00;
export const FRAME_RESIZE = 0x01;
export const FRAME_SYSTEM = 0x02;

/**
 * Cap on peer keystrokes buffered during an injection. Peer input is
 * buffered rather than dropped (landmine 4), but the buffer cannot be
 * unbounded — a stuck injection plus a held-down key would grow forever.
 * 64KB is ~20 minutes of frantic typing; past that we stop appending.
 */
const PEER_BUFFER_LIMIT = 64 * 1024;

// -----------------------------------------------------------------------------
// Minimal structural types — keeps the hub testable without a Docker daemon
// and without importing hono's WSContext or dockerode's class types.
// -----------------------------------------------------------------------------

export interface PtyStream {
  write(chunk: Buffer): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close" | "error", listener: (err?: unknown) => void): unknown;
  destroyed?: boolean;
  destroy?(): unknown;
  end?(): unknown;
}

export interface PtyContainer {
  attach(opts: {
    stream: boolean;
    stdin: boolean;
    stdout: boolean;
    stderr: boolean;
    hijack: boolean;
  }): Promise<unknown>;
  resize(opts: { h: number; w: number }): Promise<unknown>;
  logs(opts: { stdout: boolean; stderr: boolean; tail: number }): Promise<unknown>;
}

export interface PtyDocker {
  getContainer(id: string): PtyContainer;
}

/** A WebSocket peer. `WSContext` from hono/ws satisfies this structurally. */
export interface PtyPeer {
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
}

/** Resolves a target (session id today, agent id tomorrow) to a container. */
export type ResolveContainer = (targetId: string) => Promise<{ containerId: string } | null>;

export interface PtyHubOptions {
  resolveContainer: ResolveContainer;
  /** Docker client factory. Injected so tests can mock dockerode. */
  getDocker: () => Promise<PtyDocker>;
  /**
   * Called when the attach stream ends (container exited). The hub does not
   * know how to mark a session/agent stopped — the caller does.
   */
  onDetached?: (targetId: string) => void | Promise<void>;
  /** Sweep interval for dead sessions. 0 disables (tests). */
  sweepIntervalMs?: number;
  scrollbackLimit?: number;
}

export type DataListener = (chunk: Buffer) => void;

interface PtySession {
  targetId: string;
  containerId: string;
  stream: PtyStream;
  scrollback: Buffer[];
  scrollbackSize: number;
  errored: boolean;
  peers: Set<PtyPeer>;
  listeners: Set<DataListener>;
  cols: number;
  rows: number;
  /** Epoch ms of the last output chunk. The server-side idle signal. */
  lastOutputAt: number;
  /** True while an injection holds the write mutex. */
  injecting: boolean;
  /** Peer keystrokes captured during an injection, flushed after it. */
  pendingPeerInput: Buffer[];
  pendingPeerBytes: number;
}

// -----------------------------------------------------------------------------
// Chunk cleaning — moved verbatim from terminal.ts
// -----------------------------------------------------------------------------

export function tagFrame(type: number, chunk: Buffer): ArrayBuffer {
  const tagged = Buffer.allocUnsafe(1 + chunk.length);
  tagged[0] = type;
  chunk.copy(tagged, 1);
  return tagged.buffer.slice(tagged.byteOffset, tagged.byteOffset + tagged.byteLength);
}

function tagOutput(chunk: Buffer): ArrayBuffer {
  return tagFrame(FRAME_DATA, chunk);
}

const DOCKER_ATTACH_KEYS = new Set(["stream", "stdin", "stdout", "stderr", "hijack", "Tty"]);

/**
 * Strip the dockerode attach metadata that can leak as the first data chunk.
 */
export function stripAttachMetadata(buf: Buffer): Buffer {
  if (buf.length === 0 || buf[0] !== 0x7b /* '{' */) return buf;

  const scanLimit = Math.min(buf.length, 256);

  let depth = 0;
  let jsonEnd = -1;
  for (let i = 0; i < scanLimit; i++) {
    const b = buf[i];
    if (b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) return buf;
    if (b === 0x7b) depth++;
    else if (b === 0x7d) {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd === -1) return buf;

  try {
    const obj = JSON.parse(buf.subarray(0, jsonEnd).toString("utf-8"));
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return buf;

    const keys = Object.keys(obj);
    if (keys.length === 0) return buf;
    if (!keys.every((k) => DOCKER_ATTACH_KEYS.has(k))) return buf;

    const remaining = buf.subarray(jsonEnd);
    return remaining.length > 0 ? remaining : Buffer.alloc(0);
  } catch {
    return buf;
  }
}

/**
 * Strip Docker log multiplexing headers if present.
 */
export function stripDockerLogHeaders(buf: Buffer): Buffer {
  if (
    buf.length >= 8 &&
    (buf[0] === 1 || buf[0] === 2) &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0
  ) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size > buf.length) break;
      chunks.push(buf.subarray(offset + 8, offset + 8 + size));
      offset += 8 + size;
    }
    if (offset < buf.length) {
      chunks.push(buf.subarray(offset));
    }
    return Buffer.concat(chunks);
  }
  return buf;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// The hub
// -----------------------------------------------------------------------------

export class PtyHub {
  private sessions = new Map<string, PtySession>();
  private attaching = new Map<string, Promise<PtySession>>();
  /** Per-target write mutex — one stdin, many writers (landmine 4). */
  private locks = new Map<string, Promise<void>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: PtyHubOptions) {
    const every = opts.sweepIntervalMs ?? 5 * 60 * 1000;
    if (every > 0) {
      this.sweeper = setInterval(() => this.sweep(), every);
      // Never hold the process open for a janitor.
      (this.sweeper as unknown as { unref?: () => void }).unref?.();
    }
  }

  private get scrollbackLimit() {
    return this.opts.scrollbackLimit ?? SCROLLBACK_LIMIT;
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Attach to the target's container if not already attached. Concurrent
   * callers share one attach — two peers connecting at once must not open two
   * stdin streams.
   */
  async ensureAttached(targetId: string): Promise<void> {
    const existing = this.sessions.get(targetId);
    if (existing && !existing.stream.destroyed && !existing.errored) return;
    if (existing) this.sessions.delete(targetId);

    const inFlight = this.attaching.get(targetId);
    if (inFlight) {
      await inFlight;
      return;
    }

    const promise = this.attach(targetId).finally(() => {
      this.attaching.delete(targetId);
    });
    this.attaching.set(targetId, promise);
    await promise;
  }

  private async attach(targetId: string): Promise<PtySession> {
    const resolved = await this.opts.resolveContainer(targetId);
    if (!resolved) throw new Error("Container not available");

    const docker = await this.opts.getDocker();
    const container = docker.getContainer(resolved.containerId);

    // Fetch recent container logs
    let initialLogs: Buffer | null = null;
    try {
      const logStream = await container.logs({ stdout: true, stderr: true, tail: 200 });
      if (Buffer.isBuffer(logStream)) {
        initialLogs = logStream;
      } else if (typeof logStream === "string") {
        initialLogs = Buffer.from(logStream, "utf-8");
      }
    } catch {
      // ignore log fetch errors
    }

    // Attach to the container's main process
    let stream: PtyStream | null = null;
    let lastErr: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        stream = (await container.attach({
          stream: true,
          stdin: true,
          stdout: true,
          stderr: true,
          hijack: true,
        })) as PtyStream;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await sleep(2000);
        }
      }
    }
    if (lastErr || !stream) throw lastErr || new Error("Failed to attach to terminal");

    const session: PtySession = {
      targetId,
      containerId: resolved.containerId,
      stream,
      scrollback: [],
      scrollbackSize: 0,
      errored: false,
      peers: new Set(),
      listeners: new Set(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      lastOutputAt: Date.now(),
      injecting: false,
      pendingPeerInput: [],
      pendingPeerBytes: 0,
    };
    this.sessions.set(targetId, session);

    stream.on("error", () => {
      session.errored = true;
    });

    // Set initial terminal size (better default than Docker's 80x24)
    try {
      await container.resize({ h: DEFAULT_ROWS, w: DEFAULT_COLS });
    } catch {
      // ignore — container may not support resize yet
    }

    // Send initial logs to scrollback
    if (initialLogs && initialLogs.length > 0) {
      const cleaned = stripDockerLogHeaders(initialLogs);
      if (cleaned.length > 0) {
        session.scrollback.push(cleaned);
        session.scrollbackSize += cleaned.length;
      }
    }

    // Set up stream listeners ONCE (shared across all peers)
    // Dual guard for stripping Docker attach metadata:
    // - Counter: first 10 chunks
    // - Grace period: first 2 seconds after attach
    let stripCounter = 10;
    const stripDeadline = Date.now() + 2000;

    stream.on("data", (rawChunk: Buffer) => {
      let chunk: Buffer = Buffer.from(rawChunk) as Buffer;

      // Strip Docker log multiplexing headers (can appear intermittently)
      chunk = stripDockerLogHeaders(chunk);
      if (chunk.length === 0) return;

      // Strip attach metadata during grace window
      if (stripCounter > 0 && Date.now() < stripDeadline) {
        stripCounter--;
        chunk = stripAttachMetadata(chunk);
        if (chunk.length === 0) return;
      }

      // Every chunk timestamps the session — this is the idle signal that
      // queue-mode dispatch reads via lastOutputAt().
      session.lastOutputAt = Date.now();

      // Cache in scrollback ring buffer
      session.scrollback.push(chunk);
      session.scrollbackSize += chunk.length;
      while (session.scrollbackSize > this.scrollbackLimit && session.scrollback.length > 1) {
        const removed = session.scrollback.shift()!;
        session.scrollbackSize -= removed.length;
      }

      // Broadcast to ALL connected peers
      const data = tagOutput(chunk);
      for (const p of session.peers) {
        try {
          p.send(data);
        } catch {
          session.peers.delete(p);
        }
      }

      // Fan out to server-side consumers (PTY-scrape sidecar, idle watchers)
      for (const listener of session.listeners) {
        try {
          listener(chunk);
        } catch {
          // a bad listener must never break the terminal
        }
      }
    });

    stream.on("end", async () => {
      this.sessions.delete(targetId);

      try {
        await this.opts.onDetached?.(targetId);
      } catch {
        // ignore
      }

      for (const p of session.peers) {
        try {
          p.close(1000, "Stream ended");
        } catch {
          // already closed
        }
      }
      session.peers.clear();
      session.listeners.clear();
    });

    return session;
  }

  /** Drop the attach for a target (container stopped/destroyed). */
  detach(targetId: string): void {
    const session = this.sessions.get(targetId);
    if (!session) return;
    this.sessions.delete(targetId);
    this.locks.delete(targetId);
    session.listeners.clear();
    for (const p of session.peers) {
      try {
        p.close(1000, "Detached");
      } catch {
        // already closed
      }
    }
    session.peers.clear();
    try {
      session.stream.destroy?.();
    } catch {
      // ignore
    }
  }

  private sweep(): void {
    for (const [id, session] of this.sessions) {
      try {
        if (session.stream.destroyed || session.errored) {
          this.sessions.delete(id);
          this.locks.delete(id);
        }
      } catch {
        this.sessions.delete(id);
        this.locks.delete(id);
      }
    }
  }

  isAttached(targetId: string): boolean {
    const s = this.sessions.get(targetId);
    return !!s && !s.stream.destroyed && !s.errored;
  }

  // --- peers ----------------------------------------------------------------

  /** Subscribe a WS peer and replay the scrollback to it. */
  addPeer(targetId: string, peer: PtyPeer): void {
    const session = this.sessions.get(targetId);
    if (!session) throw new Error("Terminal not attached");

    for (const chunk of session.scrollback) {
      try {
        peer.send(tagOutput(chunk));
      } catch {
        break;
      }
    }
    session.peers.add(peer);

    // A peer joining mid-injection needs the banner too.
    if (session.injecting) {
      try {
        peer.send(systemFrame("inject_start"));
      } catch {
        // ignore
      }
    }
  }

  removePeer(targetId: string, peer: PtyPeer): void {
    this.sessions.get(targetId)?.peers.delete(peer);
  }

  peerCount(targetId: string): number {
    return this.sessions.get(targetId)?.peers.size ?? 0;
  }

  // --- output taps ----------------------------------------------------------

  /**
   * Subscribe to raw (header-stripped) PTY output. Returns an unsubscribe.
   * The Phase 4 PTY-scrape adapter consumes this.
   */
  onData(targetId: string, cb: DataListener): () => void {
    const session = this.sessions.get(targetId);
    if (!session) return () => {};
    session.listeners.add(cb);
    return () => {
      session.listeners.delete(cb);
    };
  }

  /** Epoch ms of the last PTY output, or undefined if not attached. */
  lastOutputAt(targetId: string): number | undefined {
    return this.sessions.get(targetId)?.lastOutputAt;
  }

  /** Milliseconds since the last PTY output. Infinity if not attached. */
  quietForMs(targetId: string, now = Date.now()): number {
    const last = this.lastOutputAt(targetId);
    return last === undefined ? Infinity : now - last;
  }

  /** Scrollback tail, for "what did the TUI actually do?" forensics. */
  tail(targetId: string, bytes = 4096): Buffer {
    const session = this.sessions.get(targetId);
    if (!session) return Buffer.alloc(0);
    const all = Buffer.concat(session.scrollback);
    return all.length <= bytes ? all : all.subarray(all.length - bytes);
  }

  // --- writing --------------------------------------------------------------

  /**
   * Per-target async mutex. There is exactly one stdin per attach and both
   * browser peers and the injector write to it; an injected multi-KB paste
   * interleaved with human keystrokes corrupts both.
   */
  async runExclusive<T>(targetId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const chain = prev.then(() => held);
    this.locks.set(targetId, chain);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      void chain.then(() => {
        if (this.locks.get(targetId) === chain) this.locks.delete(targetId);
      });
    }
  }

  private rawWrite(session: PtySession, buf: Buffer): void {
    if (buf.length === 0) return;
    session.stream.write(buf);
  }

  private broadcastSystem(session: PtySession, event: string): void {
    const frame = systemFrame(event);
    for (const p of session.peers) {
      try {
        p.send(frame);
      } catch {
        session.peers.delete(p);
      }
    }
  }

  /**
   * Write to the target's stdin.
   *
   * - `source: 'peer'` — human keystrokes. Buffered (never dropped) while an
   *   injection holds the mutex, and flushed in order once it finishes.
   * - `source: 'inject'` — a single-chunk injection. Multi-chunk injections
   *   must use {@link inject} so the mutex spans the whole paste.
   */
  async write(
    targetId: string,
    buf: Buffer,
    opts: { source: "peer" | "inject" } = { source: "peer" },
  ): Promise<void> {
    const session = this.sessions.get(targetId);
    if (!session || buf.length === 0) return;

    if (opts.source === "inject") {
      await this.inject(targetId, [{ bytes: buf, delayAfterMs: 0 }]);
      return;
    }

    if (session.injecting) {
      if (session.pendingPeerBytes + buf.length <= PEER_BUFFER_LIMIT) {
        session.pendingPeerInput.push(Buffer.from(buf));
        session.pendingPeerBytes += buf.length;
      }
      return;
    }

    // Not injecting: take the mutex so this write cannot interleave with an
    // injection that starts while we are queued. The mutex is FIFO, so peer
    // ordering is preserved.
    await this.runExclusive(targetId, () => {
      this.rawWrite(session, buf);
    });
  }

  /**
   * Run an injection: holds the write mutex across every chunk *and* every
   * inter-chunk gap, marks the session as injecting so peer keystrokes are
   * buffered, and emits `0x02` system frames so the UI can show an
   * "injecting…" banner.
   */
  async inject(
    targetId: string,
    steps: ReadonlyArray<{ bytes: Buffer; delayAfterMs: number }>,
  ): Promise<void> {
    const session = this.sessions.get(targetId);
    if (!session) throw new Error("Terminal not attached");
    if (steps.length === 0) return;

    await this.runExclusive(targetId, async () => {
      session.injecting = true;
      this.broadcastSystem(session, "inject_start");
      try {
        for (const step of steps) {
          this.rawWrite(session, step.bytes);
          if (step.delayAfterMs > 0) await sleep(step.delayAfterMs);
        }
      } finally {
        // Clear the flag *before* flushing so peer writes that arrive during
        // the flush queue behind this mutex holder instead of being buffered
        // into a batch nobody drains.
        session.injecting = false;
        if (session.pendingPeerInput.length > 0) {
          const pending = Buffer.concat(session.pendingPeerInput);
          session.pendingPeerInput = [];
          session.pendingPeerBytes = 0;
          this.rawWrite(session, pending);
        }
        this.broadcastSystem(session, "inject_end");
      }
    });
  }

  /** True while an injection holds the mutex. */
  isInjecting(targetId: string): boolean {
    return this.sessions.get(targetId)?.injecting ?? false;
  }

  /** Bytes currently buffered from peers during an injection. */
  pendingPeerBytes(targetId: string): number {
    return this.sessions.get(targetId)?.pendingPeerBytes ?? 0;
  }

  // --- resize ---------------------------------------------------------------

  async resize(targetId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(targetId);
    if (!session) return;
    if (!(cols > 0) || !(rows > 0)) return;
    if (cols === session.cols && rows === session.rows) return;

    session.cols = cols;
    session.rows = rows;
    try {
      const docker = await this.opts.getDocker();
      const container = docker.getContainer(session.containerId);
      await container.resize({ h: rows, w: cols });
    } catch {
      // ignore resize errors
    }
  }

  size(targetId: string): { cols: number; rows: number } | undefined {
    const s = this.sessions.get(targetId);
    return s ? { cols: s.cols, rows: s.rows } : undefined;
  }

  /** Test/teardown helper. */
  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.sessions.keys()]) this.detach(id);
    this.locks.clear();
  }
}

/**
 * `0x02` system frame. The binary protocol already reserves it and
 * `src/components/terminal.tsx` ignores unknown types today, so adding these
 * is forward-compatible.
 */
export function systemFrame(event: string, detail?: Record<string, unknown>): ArrayBuffer {
  const payload = Buffer.from(JSON.stringify({ event, ...detail }), "utf-8");
  return tagFrame(FRAME_SYSTEM, payload);
}

// -----------------------------------------------------------------------------
// Process-wide instance
// -----------------------------------------------------------------------------

let hub: PtyHub | null = null;

/** Install the process-wide hub. Idempotent per process. */
export function configurePtyHub(opts: PtyHubOptions): PtyHub {
  if (!hub) hub = new PtyHub(opts);
  return hub;
}

export function getPtyHub(): PtyHub {
  if (!hub) throw new Error("PtyHub not configured — call configurePtyHub() first");
  return hub;
}

/** Test helper. */
export function resetPtyHub(): void {
  hub?.dispose();
  hub = null;
}
