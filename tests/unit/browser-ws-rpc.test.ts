import { describe, it, expect, vi, afterEach } from "vitest";
import { createWsRpc } from "@/lib/browser-ws-rpc";
import { REQUEST_OP, RESPONSE_OP } from "@/lib/browser-input-codec";

/**
 * Behavioural tests for the per-WS RPC helper. We stub out the WebSocket
 * with a tiny shim that captures the bytes `request()` sends, then feed
 * synthetic responses back through `handleBinary` to check correlation.
 */

interface SentFrame {
  bytes: Uint8Array;
}

interface FakeWs {
  readyState: number;
  send(buf: ArrayBuffer): void;
  // Test handle: bytes the rpc sent through us
  sent: SentFrame[];
}

const OPEN = 1;
const CLOSED = 3;

function makeFakeWs(initialState = OPEN): FakeWs {
  const sent: SentFrame[] = [];
  return {
    readyState: initialState,
    sent,
    send(buf: ArrayBuffer) {
      sent.push({ bytes: new Uint8Array(buf) });
    },
  };
}

/** Build a synthetic 0x82 controlAck frame for a given reqId + JSON. */
function buildControlAck(reqId: number, ok: boolean, json: string): ArrayBuffer {
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(10 + payload.length);
  buf[0] = 0x82;
  buf[1] = (reqId >>> 24) & 0xff;
  buf[2] = (reqId >>> 16) & 0xff;
  buf[3] = (reqId >>> 8) & 0xff;
  buf[4] = reqId & 0xff;
  buf[5] = ok ? 1 : 0;
  buf[6] = (payload.length >>> 24) & 0xff;
  buf[7] = (payload.length >>> 16) & 0xff;
  buf[8] = (payload.length >>> 8) & 0xff;
  buf[9] = payload.length & 0xff;
  buf.set(payload, 10);
  return buf.buffer;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createWsRpc", () => {
  it("resolves with decoded payload when a matching response arrives", async () => {
    const ws = makeFakeWs();
    // The rpc tests typecheck the WebSocket shape it needs; cast for the stub.
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const promise = rpc.request(REQUEST_OP.control, { action: "navigate", url: "https://x.y" });

    // First request gets reqId=1 (rpc skips 0).
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].bytes[0]).toBe(0x10);
    // reqId 1 in u32 BE = [0,0,0,1]
    expect(Array.from(ws.sent[0].bytes.slice(1, 5))).toEqual([0, 0, 0, 1]);

    rpc.handleBinary(buildControlAck(1, true, '{"ok":true,"url":"https://x.y"}'));

    await expect(promise).resolves.toEqual({ ok: true, url: "https://x.y" });
  });

  it("correlates concurrent requests by reqId, not by order of arrival", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p1 = rpc.request(REQUEST_OP.control, { action: "back" });
    const p2 = rpc.request(REQUEST_OP.control, { action: "forward" });

    // Respond to p2 first — its reqId is 2, not the order it was sent.
    rpc.handleBinary(buildControlAck(2, true, '{"ok":true,"action":"forward"}'));
    rpc.handleBinary(buildControlAck(1, true, '{"ok":true,"action":"back"}'));

    await expect(p1).resolves.toMatchObject({ action: "back" });
    await expect(p2).resolves.toMatchObject({ action: "forward" });
  });

  it("rejects pending requests when dispose() is called", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.state, { resetContextMenu: false });
    rpc.dispose("ws_unmount");

    await expect(p).rejects.toThrow("ws_unmount");
  });

  it("rejects on timeout when no response arrives", async () => {
    vi.useFakeTimers();
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.state, { resetContextMenu: false }, 1000);
    const expectation = expect(p).rejects.toThrow(/timeout/);
    vi.advanceTimersByTime(1001);
    await expectation;
  });

  it("rejects request when WS is not OPEN", async () => {
    const ws = makeFakeWs(CLOSED);
    const rpc = createWsRpc(ws as unknown as WebSocket);
    await expect(rpc.request(REQUEST_OP.state, { resetContextMenu: false })).rejects.toThrow(
      "ws_not_open",
    );
  });

  it("returns false from handleBinary for non-response frames (lets video path proceed)", () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);
    // Video keyframe: first byte = 0
    const videoFrame = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0xde, 0xad]).buffer;
    expect(rpc.handleBinary(videoFrame)).toBe(false);
    // Input frame echoed back somehow (defensive — shouldn't happen on this socket)
    const inputFrame = new Uint8Array([0x01, 0, 0, 0, 0, 0]).buffer;
    expect(rpc.handleBinary(inputFrame)).toBe(false);
  });

  it("returns true from handleBinary for response opcodes even if reqId is unknown", () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);
    // Late-arriving response for a reqId nobody is waiting on — swallow,
    // but report `true` so caller doesn't accidentally feed bytes to the
    // video decoder.
    const orphan = buildControlAck(9999, true, "{}");
    expect(rpc.handleBinary(orphan)).toBe(true);
  });

  it("rejects with opcode-mismatch when server echoes wrong response opcode", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.state, { resetContextMenu: false });
    // We expected 0x84 (stateSnapshot); server sends 0x82 (controlAck).
    rpc.handleBinary(buildControlAck(1, true, "{}"));

    await expect(p).rejects.toThrow(/opcode_mismatch/);
  });

  it("RESPONSE_OP constants are stable for cross-side parity", () => {
    // Defensive: the rpc relies on these numeric values to fork on
    // expected/actual opcodes. Sanity-check.
    expect(RESPONSE_OP.controlAck).toBe(0x82);
    expect(RESPONSE_OP.evalResult).toBe(0x83);
    expect(RESPONSE_OP.stateSnapshot).toBe(0x84);
  });
});
