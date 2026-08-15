import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  PtyHub,
  stripAttachMetadata,
  stripDockerLogHeaders,
  type PtyDocker,
  type PtyPeer,
  type PtyStream,
} from "../../server/agents/pty-hub";
import { planInjection } from "../../server/agents/injector";
import { PROFILES } from "../../server/agents/adapters/profiles";

// ---------------------------------------------------------------------------
// Mocked dockerode — same shape as tests/unit/docker-client.test.ts, but the
// hub takes its client through an injected factory so no module mock is needed.
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;

  write(chunk: Buffer) {
    this.writes.push(Buffer.from(chunk));
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
  /** Everything written so far, concatenated. */
  get written() {
    return Buffer.concat(this.writes).toString("utf-8");
  }
}

class FakePeer implements PtyPeer {
  frames: Buffer[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: ArrayBuffer | string) {
    this.frames.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  /** Frames of a given type byte, payload only. */
  payloads(type: number) {
    return this.frames.filter((f) => f[0] === type).map((f) => f.subarray(1).toString("utf-8"));
  }
}

function makeHub(opts?: { logs?: Buffer }) {
  const stream = new FakeStream();
  const resize = vi.fn().mockResolvedValue(undefined);
  const attach = vi.fn().mockResolvedValue(stream);
  const docker: PtyDocker = {
    getContainer: () => ({
      attach,
      resize,
      logs: vi.fn().mockResolvedValue(opts?.logs ?? Buffer.alloc(0)),
    }),
  };
  const hub = new PtyHub({
    resolveContainer: async (id) => (id === "missing" ? null : { containerId: `c-${id}` }),
    getDocker: async () => docker,
    sweepIntervalMs: 0,
  });
  return { hub, stream: stream as unknown as PtyStream & FakeStream, attach, resize };
}

const DATA = 0x00;
const SYSTEM = 0x02;

describe("PtyHub — attach and peers", () => {
  it("attaches once for concurrent peers", async () => {
    const { hub, attach } = makeHub();
    await Promise.all([
      hub.ensureAttached("s1"),
      hub.ensureAttached("s1"),
      hub.ensureAttached("s1"),
    ]);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(hub.isAttached("s1")).toBe(true);
    hub.dispose();
  });

  it("throws when the target has no container", async () => {
    const { hub } = makeHub();
    await expect(hub.ensureAttached("missing")).rejects.toThrow(/not available/i);
    hub.dispose();
  });

  it("sets an initial 120x30 size on attach", async () => {
    const { hub, resize } = makeHub();
    await hub.ensureAttached("s1");
    expect(resize).toHaveBeenCalledWith({ h: 30, w: 120 });
    hub.dispose();
  });

  it("broadcasts output to every peer as 0x00 frames", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const a = new FakePeer();
    const b = new FakePeer();
    hub.addPeer("s1", a);
    hub.addPeer("s1", b);

    stream.emit("data", Buffer.from("hello"));

    expect(a.payloads(DATA)).toEqual(["hello"]);
    expect(b.payloads(DATA)).toEqual(["hello"]);
    hub.dispose();
  });

  it("replays scrollback to a peer that joins late, and stops after removePeer", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const early = new FakePeer();
    hub.addPeer("s1", early);
    stream.emit("data", Buffer.from("one"));
    stream.emit("data", Buffer.from("two"));

    const late = new FakePeer();
    hub.addPeer("s1", late);
    expect(late.payloads(DATA)).toEqual(["one", "two"]);

    hub.removePeer("s1", early);
    stream.emit("data", Buffer.from("three"));
    expect(early.payloads(DATA)).toEqual(["one", "two"]);
    expect(late.payloads(DATA)).toEqual(["one", "two", "three"]);
    hub.dispose();
  });

  it("caps the scrollback ring buffer", async () => {
    const stream = new FakeStream();
    const hub = new PtyHub({
      resolveContainer: async () => ({ containerId: "c" }),
      getDocker: async () => ({
        getContainer: () => ({
          attach: async () => stream,
          resize: async () => undefined,
          logs: async () => Buffer.alloc(0),
        }),
      }),
      sweepIntervalMs: 0,
      scrollbackLimit: 100,
    });
    await hub.ensureAttached("s1");
    for (let i = 0; i < 20; i++) stream.emit("data", Buffer.alloc(10, 0x61));

    const peer = new FakePeer();
    hub.addPeer("s1", peer);
    const replayed = peer.payloads(DATA).join("").length;
    expect(replayed).toBeLessThanOrEqual(100);
    expect(replayed).toBeGreaterThan(0);
    hub.dispose();
  });

  it("closes peers and reports detachment when the stream ends", async () => {
    const onDetached = vi.fn();
    const stream = new FakeStream();
    const hub = new PtyHub({
      resolveContainer: async () => ({ containerId: "c" }),
      getDocker: async () => ({
        getContainer: () => ({
          attach: async () => stream,
          resize: async () => undefined,
          logs: async () => Buffer.alloc(0),
        }),
      }),
      onDetached,
      sweepIntervalMs: 0,
    });
    await hub.ensureAttached("s1");
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    stream.emit("end");
    await vi.waitFor(() => expect(onDetached).toHaveBeenCalledWith("s1"));
    expect(peer.closed?.code).toBe(1000);
    expect(hub.isAttached("s1")).toBe(false);
    hub.dispose();
  });
});

describe("PtyHub — output taps and idle signal", () => {
  it("onData receives cleaned chunks and unsubscribes", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const seen: string[] = [];
    const off = hub.onData("s1", (c) => seen.push(c.toString()));

    stream.emit("data", Buffer.from("a"));
    off();
    stream.emit("data", Buffer.from("b"));

    expect(seen).toEqual(["a"]);
    hub.dispose();
  });

  it("a throwing listener cannot break the terminal", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    hub.onData("s1", () => {
      throw new Error("bad consumer");
    });
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    expect(() => stream.emit("data", Buffer.from("still here"))).not.toThrow();
    expect(peer.payloads(DATA)).toEqual(["still here"]);
    hub.dispose();
  });

  it("timestamps every chunk — lastOutputAt / quietForMs is the idle signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    stream.emit("data", Buffer.from("busy"));
    expect(hub.lastOutputAt("s1")).toBe(Date.parse("2026-01-01T00:00:05Z"));

    vi.setSystemTime(new Date("2026-01-01T00:00:06Z"));
    expect(hub.quietForMs("s1")).toBe(1000);
    expect(hub.quietForMs("nope")).toBe(Infinity);
    hub.dispose();
    vi.useRealTimers();
  });

  it("tail() returns the last N bytes for forensics", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    stream.emit("data", Buffer.from("0123456789"));
    stream.emit("data", Buffer.from("abcdef"));
    expect(hub.tail("s1", 8).toString()).toBe("89abcdef");
    hub.dispose();
  });
});

describe("PtyHub — write mutex and peer buffering (landmine 4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("buffers peer keystrokes during an injection and flushes them after", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    const steps = planInjection("hello world", PROFILES.mock, { mode: "interrupt" });
    const injecting = hub.inject("s1", steps);

    // Let the first write land, then type over the top of it.
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.isInjecting("s1")).toBe(true);
    void hub.write("s1", Buffer.from("XY"), { source: "peer" });
    void hub.write("s1", Buffer.from("Z"), { source: "peer" });
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.pendingPeerBytes("s1")).toBe(3);
    // Nothing from the human has reached stdin yet.
    expect(stream.written).not.toContain("XY");

    await vi.advanceTimersByTimeAsync(1000);
    await injecting;

    expect(hub.isInjecting("s1")).toBe(false);
    expect(hub.pendingPeerBytes("s1")).toBe(0);
    // Peer input is preserved, in order, entirely after the injection.
    expect(stream.written.endsWith("XYZ")).toBe(true);
    expect(stream.written).toBe("\x1b\x1b[200~hello wo" + "rld\x1b[201~\rXYZ");
  });

  it("notifies peers with 0x02 frames around the injection", async () => {
    const { hub } = makeHub();
    await hub.ensureAttached("s1");
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    const p = hub.inject("s1", planInjection("hi", PROFILES.mock));
    await vi.advanceTimersByTimeAsync(0);
    expect(peer.payloads(SYSTEM)).toEqual(['{"event":"inject_start"}']);

    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(peer.payloads(SYSTEM)).toEqual(['{"event":"inject_start"}', '{"event":"inject_end"}']);
    hub.dispose();
  });

  it("a peer joining mid-injection gets the banner too", async () => {
    const { hub } = makeHub();
    await hub.ensureAttached("s1");
    const p = hub.inject("s1", planInjection("hi", PROFILES.mock));
    await vi.advanceTimersByTimeAsync(1);

    const latecomer = new FakePeer();
    hub.addPeer("s1", latecomer);
    expect(latecomer.payloads(SYSTEM)).toEqual(['{"event":"inject_start"}']);

    await vi.advanceTimersByTimeAsync(1000);
    await p;
    hub.dispose();
  });

  it("serializes two concurrent injections instead of interleaving them", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");

    const a = hub.inject("s1", planInjection("aaaa", PROFILES.mock));
    const b = hub.inject("s1", planInjection("bbbb", PROFILES.mock));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b]);

    const written = stream.written;
    expect(written).toBe("\x1b[200~aaaa\x1b[201~\r\x1b[200~bbbb\x1b[201~\r");
    // Neither paste is torn open by the other.
    expect(written.indexOf("bbbb")).toBeGreaterThan(written.indexOf("aaaa"));
    hub.dispose();
  });

  it("peer writes outside an injection go straight through, in order", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    await hub.write("s1", Buffer.from("a"), { source: "peer" });
    await hub.write("s1", Buffer.from("b"), { source: "peer" });
    expect(stream.written).toBe("ab");
    hub.dispose();
  });

  it("write(source: 'inject') takes the mutex like a full injection", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    const p = hub.write("s1", Buffer.from("/status\r"), { source: "inject" });
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(stream.written).toBe("/status\r");
    expect(peer.payloads(SYSTEM)).toContain('{"event":"inject_start"}');
    hub.dispose();
  });

  it("drops nothing when a peer types a long burst during a long injection", async () => {
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const body = "z".repeat(200);
    const p = hub.inject("s1", planInjection(body, PROFILES.mock));

    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 50; i++) void hub.write("s1", Buffer.from("k"), { source: "peer" });
    await vi.advanceTimersByTimeAsync(2000);
    await p;

    expect(stream.written.endsWith("k".repeat(50))).toBe(true);
    expect(stream.written).toContain(body);
    hub.dispose();
  });

  it("ignores writes for unknown targets", async () => {
    const { hub } = makeHub();
    await expect(hub.write("nope", Buffer.from("x"))).resolves.toBeUndefined();
    await expect(
      hub.inject("nope", [{ bytes: Buffer.from("x"), delayAfterMs: 0 }]),
    ).rejects.toThrow(/not attached/i);
    hub.dispose();
  });
});

describe("PtyHub — resize", () => {
  it("forwards a changed size to the container once", async () => {
    const { hub, resize } = makeHub();
    await hub.ensureAttached("s1");
    resize.mockClear();

    await hub.resize("s1", 100, 40);
    await hub.resize("s1", 100, 40); // no-op, unchanged
    await hub.resize("s1", 0, 40); // invalid

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ h: 40, w: 100 });
    expect(hub.size("s1")).toEqual({ cols: 100, rows: 40 });
    hub.dispose();
  });
});

describe("carried-over stream cleaning", () => {
  it("strips dockerode attach metadata leaked as the first chunk", () => {
    const meta = '{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}';
    expect(stripAttachMetadata(Buffer.from(meta + "prompt$ ")).toString()).toBe("prompt$ ");
    // A JSON-looking payload that is not attach metadata survives untouched.
    expect(stripAttachMetadata(Buffer.from('{"foo":1}bar')).toString()).toBe('{"foo":1}bar');
    expect(stripAttachMetadata(Buffer.from("plain")).toString()).toBe("plain");
  });

  it("strips Docker log multiplexing headers", () => {
    const payload = Buffer.from("hello");
    const framed = Buffer.alloc(8 + payload.length);
    framed[0] = 1;
    framed.writeUInt32BE(payload.length, 4);
    payload.copy(framed, 8);
    expect(stripDockerLogHeaders(framed).toString()).toBe("hello");
    expect(stripDockerLogHeaders(Buffer.from("raw tty output")).toString()).toBe("raw tty output");
  });

  it("applies the attach-metadata strip only inside the 2s grace window", async () => {
    vi.useFakeTimers();
    const { hub, stream } = makeHub();
    await hub.ensureAttached("s1");
    const peer = new FakePeer();
    hub.addPeer("s1", peer);

    const meta = '{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}';
    stream.emit("data", Buffer.from(meta + "first"));
    expect(peer.payloads(DATA)).toEqual(["first"]);

    vi.setSystemTime(Date.now() + 3000);
    stream.emit("data", Buffer.from(meta + "later"));
    expect(peer.payloads(DATA)[1]).toBe(meta + "later");

    hub.dispose();
    vi.useRealTimers();
  });
});
