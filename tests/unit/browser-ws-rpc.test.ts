import { describe, it, expect, vi, afterEach } from "vitest";
import { createWsRpc } from "@/lib/browser-ws-rpc";
import { REQUEST_OP, RESPONSE_OP } from "@/lib/browser-input-codec";

/**
 * Behavioural tests for the per-WS RPC helper. We stub the WebSocket with
 * a tiny shim that captures the bytes `request()` sends, then feed
 * synthetic responses back through `handleResponse` to check correlation.
 *
 * `control` (0x10) is intentionally NOT exposed on the rpc helper —
 * control is fire-and-forget post-#61-cut2. Tests here exercise eval
 * (0x83 response) and state (0x84 response, no ok byte).
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

/** Build a synthetic 0x83 evalResult frame for a given reqId + JSON. */
function buildEvalResult(reqId: number, ok: boolean, json: string): ArrayBuffer {
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(10 + payload.length);
  buf[0] = 0x83;
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

/** Build a synthetic 0x84 stateSnapshot frame — no ok byte, JSON carries it. */
function buildStateSnapshot(reqId: number, json: string): ArrayBuffer {
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(9 + payload.length);
  buf[0] = 0x84;
  buf[1] = (reqId >>> 24) & 0xff;
  buf[2] = (reqId >>> 16) & 0xff;
  buf[3] = (reqId >>> 8) & 0xff;
  buf[4] = reqId & 0xff;
  buf[5] = (payload.length >>> 24) & 0xff;
  buf[6] = (payload.length >>> 16) & 0xff;
  buf[7] = (payload.length >>> 8) & 0xff;
  buf[8] = payload.length & 0xff;
  buf.set(payload, 9);
  return buf.buffer;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createWsRpc", () => {
  it("resolves an eval request with the decoded payload", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const promise = rpc.request(REQUEST_OP.eval, { expression: "1 + 2" });

    // First request gets reqId=1 (rpc skips 0 to leave it for fire-and-forget).
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].bytes[0]).toBe(0x11);
    expect(Array.from(ws.sent[0].bytes.slice(1, 5))).toEqual([0, 0, 0, 1]);

    rpc.handleResponse(buildEvalResult(1, true, '{"ok":true,"result":"3"}'));

    await expect(promise).resolves.toEqual({ ok: true, result: "3" });
  });

  it("resolves a state request and the response carries no ok byte", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const promise = rpc.request(REQUEST_OP.state, { includeUrl: true });
    expect(ws.sent[0].bytes[0]).toBe(0x12);
    expect(ws.sent[0].bytes[5]).toBe(0b00000001); // includeUrl bit only

    rpc.handleResponse(buildStateSnapshot(1, '{"ok":true,"url":"https://x.y"}'));

    await expect(promise).resolves.toEqual({ ok: true, url: "https://x.y" });
  });

  it("correlates concurrent requests by reqId, not by order of arrival", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p1 = rpc.request(REQUEST_OP.eval, { expression: "a" });
    const p2 = rpc.request(REQUEST_OP.eval, { expression: "b" });

    // Respond to p2 first — its reqId is 2.
    rpc.handleResponse(buildEvalResult(2, true, '{"ok":true,"result":"B"}'));
    rpc.handleResponse(buildEvalResult(1, true, '{"ok":true,"result":"A"}'));

    await expect(p1).resolves.toMatchObject({ result: "A" });
    await expect(p2).resolves.toMatchObject({ result: "B" });
  });

  it("rejects pending requests when dispose() is called", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.state, { includeUrl: true });
    rpc.dispose("ws_unmount");

    await expect(p).rejects.toThrow("ws_unmount");
  });

  it("rejects on timeout when no response arrives", async () => {
    vi.useFakeTimers();
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.eval, { expression: "x" }, 1000);
    const expectation = expect(p).rejects.toThrow(/timeout/);
    vi.advanceTimersByTime(1001);
    await expectation;
  });

  it("rejects request when WS is not OPEN", async () => {
    const ws = makeFakeWs(CLOSED);
    const rpc = createWsRpc(ws as unknown as WebSocket);
    await expect(rpc.request(REQUEST_OP.eval, { expression: "x" })).rejects.toThrow("ws_not_open");
  });

  it("silently drops late/orphan reqIds nobody is waiting on", () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);
    // Should not throw — orphan response just no-ops.
    rpc.handleResponse(buildEvalResult(9999, true, "{}"));
    expect(ws.sent).toHaveLength(0);
  });

  it("rejects with opcode-mismatch when server echoes wrong response opcode", async () => {
    const ws = makeFakeWs();
    const rpc = createWsRpc(ws as unknown as WebSocket);

    const p = rpc.request(REQUEST_OP.state, { includeUrl: true });
    // We expected 0x84 (stateSnapshot); server sends 0x83 (evalResult).
    rpc.handleResponse(buildEvalResult(1, true, "{}"));

    await expect(p).rejects.toThrow(/opcode_mismatch/);
  });

  it("RESPONSE_OP constants are stable for cross-side parity", () => {
    expect(RESPONSE_OP.evalResult).toBe(0x83);
    expect(RESPONSE_OP.stateSnapshot).toBe(0x84);
    // 0x82 controlAck was dropped in #61 cut2 — assert absence.
    expect("controlAck" in RESPONSE_OP).toBe(false);
  });
});
