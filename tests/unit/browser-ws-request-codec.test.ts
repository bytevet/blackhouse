import { describe, it, expect } from "vitest";
// Tests for the new #61 request/response opcodes (0x10–0x12, 0x82–0x84)
// in the server-side codec. Round-trip-style coverage on each request
// type plus a byte-layout fixture so cross-language interop with the
// (forthcoming) fe codec is pinned.
// @ts-expect-error — plain ESM module with no type defs
import { decodeRequest, encodeResponse, OP } from "../../agent/browser-service/input-codec.mjs";

function bytesOf(buf: ArrayBuffer): Uint8Array {
  return new Uint8Array(buf);
}

function buildRequest(opcode: number, reqId: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(5 + payload.length);
  out[0] = opcode;
  // u32 BE
  out[1] = (reqId >>> 24) & 0xff;
  out[2] = (reqId >>> 16) & 0xff;
  out[3] = (reqId >>> 8) & 0xff;
  out[4] = reqId & 0xff;
  out.set(payload, 5);
  return out.buffer;
}

describe("browser-ws request codec — decodeRequest", () => {
  it("decodes a navigate control request", () => {
    // action=1 (navigate), urlLen=11, url=https://x.y, width=0, height=0
    const url = new TextEncoder().encode("https://x.y");
    const payload = new Uint8Array(1 + 2 + url.length + 2 + 2);
    payload[0] = 1; // action: navigate
    payload[1] = 0;
    payload[2] = url.length;
    payload.set(url, 3);
    // width/height left as 0
    const buf = buildRequest(OP.CONTROL, 42, payload);
    const r = decodeRequest(buf);
    expect(r).not.toBeNull();
    expect(r.opcode).toBe(OP.CONTROL);
    expect(r.reqId).toBe(42);
    expect(r.body).toEqual({ action: "navigate", url: "https://x.y" });
  });

  it("decodes a back control request (no payload-specific fields)", () => {
    const payload = new Uint8Array(1 + 2 + 0 + 2 + 2);
    payload[0] = 2; // back
    const buf = buildRequest(OP.CONTROL, 7, payload);
    const r = decodeRequest(buf);
    expect(r.body).toEqual({ action: "back" });
    expect(r.reqId).toBe(7);
  });

  it("decodes a resize control request", () => {
    const payload = new Uint8Array(1 + 2 + 0 + 2 + 2);
    payload[0] = 5; // resize
    payload[1] = 0;
    payload[2] = 0; // urlLen = 0
    // width = 1280, height = 720
    payload[3] = (1280 >> 8) & 0xff;
    payload[4] = 1280 & 0xff;
    payload[5] = (720 >> 8) & 0xff;
    payload[6] = 720 & 0xff;
    const buf = buildRequest(OP.CONTROL, 99, payload);
    const r = decodeRequest(buf);
    expect(r.body).toEqual({ action: "resize", width: 1280, height: 720 });
  });

  it("decodes an eval request", () => {
    const expr = new TextEncoder().encode("1 + 2");
    const payload = new Uint8Array(4 + expr.length);
    // u32 BE exprLen
    payload[0] = 0;
    payload[1] = 0;
    payload[2] = 0;
    payload[3] = expr.length;
    payload.set(expr, 4);
    const buf = buildRequest(OP.EVAL, 13, payload);
    const r = decodeRequest(buf);
    expect(r.opcode).toBe(OP.EVAL);
    expect(r.reqId).toBe(13);
    expect(r.body).toEqual({ expression: "1 + 2" });
  });

  it("decodes a state request with resetContextMenu flag", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0b00000001]));
    const r = decodeRequest(buf);
    expect(r.body).toEqual({ resetContextMenu: true });
  });

  it("decodes a state request without flags", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0]));
    expect(decodeRequest(buf).body).toEqual({ resetContextMenu: false });
  });

  it("returns null for truncated request", () => {
    const buf = new Uint8Array([OP.CONTROL, 0, 0]).buffer;
    expect(decodeRequest(buf)).toBeNull();
  });

  it("returns null for unknown opcode", () => {
    const buf = buildRequest(0x99, 1, new Uint8Array([0]));
    expect(decodeRequest(buf)).toBeNull();
  });
});

describe("browser-ws request codec — encodeResponse", () => {
  it("encodes a controlAck with ok=true", () => {
    const buf = encodeResponse(OP.CONTROL_ACK, 42, true, '{"url":"https://x.y"}');
    const bytes = bytesOf(buf);
    expect(bytes[0]).toBe(OP.CONTROL_ACK);
    // reqId = 42 in u32 BE
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0);
    expect(bytes[3]).toBe(0);
    expect(bytes[4]).toBe(42);
    // ok = 1
    expect(bytes[5]).toBe(1);
    // payloadLen u32 BE = 22 ('{"url":"https://x.y"}' is 21 chars; let's compute)
    const payload = '{"url":"https://x.y"}';
    const payloadLen = new TextEncoder().encode(payload).length;
    const got = (bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
    expect(got).toBe(payloadLen);
    const payloadBytes = bytes.slice(10);
    expect(new TextDecoder().decode(payloadBytes)).toBe(payload);
  });

  it("encodes an evalResult with ok=false", () => {
    const buf = encodeResponse(OP.EVAL_RESULT, 7, false, '{"error":"x"}');
    const bytes = bytesOf(buf);
    expect(bytes[0]).toBe(OP.EVAL_RESULT);
    expect(bytes[5]).toBe(0); // ok = false
  });

  it("encodes a stateSnapshot WITHOUT the ok byte (4-byte header after reqId)", () => {
    const buf = encodeResponse(OP.STATE_SNAPSHOT, 1, true, '{"scrollY":42}');
    const bytes = bytesOf(buf);
    expect(bytes[0]).toBe(OP.STATE_SNAPSHOT);
    // reqId 1 → bytes 1..4 = 0,0,0,1
    expect(bytes[1]).toBe(0);
    expect(bytes[4]).toBe(1);
    // No ok byte — payloadLen starts at byte 5
    const payload = '{"scrollY":42}';
    const payloadLen = new TextEncoder().encode(payload).length;
    const got = (bytes[5] << 24) | (bytes[6] << 16) | (bytes[7] << 8) | bytes[8];
    expect(got).toBe(payloadLen);
    expect(new TextDecoder().decode(bytes.slice(9))).toBe(payload);
  });

  it("encodes large UTF-8 payloads correctly", () => {
    const big = "日本語".repeat(100);
    const buf = encodeResponse(OP.EVAL_RESULT, 1, true, JSON.stringify({ result: big }));
    const bytes = bytesOf(buf);
    // Header: 1 (op) + 4 (reqId) + 1 (ok) + 4 (payloadLen) = 10
    const payloadLen = (bytes[6] << 24) | (bytes[7] << 16) | (bytes[8] << 8) | bytes[9];
    expect(payloadLen).toBe(bytes.length - 10);
  });
});
