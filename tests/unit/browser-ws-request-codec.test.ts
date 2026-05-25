import { describe, it, expect } from "vitest";
// Wire-format tests for the #61 binary WS opcodes (requests 0x10–0x12,
// responses 0x83–0x84, server pushes 0x80/0x85/0x86, video frame header
// 0x81). Control (0x10) is fire-and-forget — no response opcode.
// Byte-level fixtures so the TS client codec can interop without drift —
// change either side and these break.
// @ts-expect-error — plain ESM module with no type defs
import {
  decodeRequest,
  encodeResponse,
  encodeConfig,
  encodeConsoleEvent,
  encodeNavigateEvent,
  encodeVideoFrameHeader,
  OP,
} from "../../agent/browser-service/input-codec.mjs";

function bytesOf(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function buildRequest(opcode: number, reqId: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(5 + payload.length);
  out[0] = opcode;
  out[1] = (reqId >>> 24) & 0xff;
  out[2] = (reqId >>> 16) & 0xff;
  out[3] = (reqId >>> 8) & 0xff;
  out[4] = reqId & 0xff;
  out.set(payload, 5);
  return out.buffer;
}

function readU32BE(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] << 24) >>> 0) + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3]
  );
}

describe("decodeRequest — control opcode 0x10", () => {
  // Action byte enum (matches spec):
  //   0=back, 1=forward, 2=reload, 3=navigate, 4=resize
  it("decodes a navigate request", () => {
    const url = new TextEncoder().encode("https://x.y");
    const payload = new Uint8Array(1 + 2 + url.length + 2 + 2);
    payload[0] = 3; // navigate
    payload[1] = 0;
    payload[2] = url.length;
    payload.set(url, 3);
    // width/height left as 0
    const buf = buildRequest(OP.CONTROL, 42, payload);
    const r = decodeRequest(buf);
    expect(r.opcode).toBe(OP.CONTROL);
    expect(r.reqId).toBe(42);
    expect(r.body).toEqual({ action: "navigate", url: "https://x.y" });
  });

  it("decodes a back request (action=0)", () => {
    const payload = new Uint8Array(7); // 1 + 2 + 0 + 2 + 2
    payload[0] = 0; // back
    const buf = buildRequest(OP.CONTROL, 7, payload);
    expect(decodeRequest(buf).body).toEqual({ action: "back" });
  });

  it("decodes a forward request (action=1)", () => {
    const payload = new Uint8Array(7);
    payload[0] = 1; // forward
    expect(decodeRequest(buildRequest(OP.CONTROL, 1, payload)).body).toEqual({
      action: "forward",
    });
  });

  it("decodes a reload request (action=2)", () => {
    const payload = new Uint8Array(7);
    payload[0] = 2; // reload
    expect(decodeRequest(buildRequest(OP.CONTROL, 1, payload)).body).toEqual({
      action: "reload",
    });
  });

  it("decodes a resize request (action=4)", () => {
    const payload = new Uint8Array(7);
    payload[0] = 4; // resize
    // urlLen=0 → bytes 1..2 stay 0. width @ byte 3..4, height @ 5..6
    payload[3] = (1280 >> 8) & 0xff;
    payload[4] = 1280 & 0xff;
    payload[5] = (720 >> 8) & 0xff;
    payload[6] = 720 & 0xff;
    expect(decodeRequest(buildRequest(OP.CONTROL, 99, payload)).body).toEqual({
      action: "resize",
      width: 1280,
      height: 720,
    });
  });

  it("returns null for unknown action byte", () => {
    const payload = new Uint8Array(7);
    payload[0] = 99; // not in table
    expect(decodeRequest(buildRequest(OP.CONTROL, 1, payload))).toBeNull();
  });
});

describe("decodeRequest — eval opcode 0x11", () => {
  it("decodes an eval request", () => {
    const expr = new TextEncoder().encode("1 + 2");
    const payload = new Uint8Array(4 + expr.length);
    payload[3] = expr.length; // u32 BE exprLen
    payload.set(expr, 4);
    const r = decodeRequest(buildRequest(OP.EVAL, 13, payload));
    expect(r.body).toEqual({ expression: "1 + 2" });
  });

  it("decodes a large UTF-8 expression", () => {
    const expr = new TextEncoder().encode("日本語の評価式".repeat(50));
    const payload = new Uint8Array(4 + expr.length);
    const v = new DataView(payload.buffer);
    v.setUint32(0, expr.length, false);
    payload.set(expr, 4);
    const r = decodeRequest(buildRequest(OP.EVAL, 1, payload));
    expect(r.body.expression.length).toBeGreaterThan(0);
  });
});

describe("decodeRequest — state opcode 0x12", () => {
  // State flag bits: bit0=includeUrl, bit1=includeTitle, bit2=includeLoading
  it("decodes all-flags-set", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0b00000111]));
    expect(decodeRequest(buf).body).toEqual({
      includeUrl: true,
      includeTitle: true,
      includeLoading: true,
    });
  });
  it("decodes url-only", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0b00000001]));
    expect(decodeRequest(buf).body).toEqual({
      includeUrl: true,
      includeTitle: false,
      includeLoading: false,
    });
  });
  it("decodes title+loading", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0b00000110]));
    expect(decodeRequest(buf).body).toEqual({
      includeUrl: false,
      includeTitle: true,
      includeLoading: true,
    });
  });
  it("ignores unknown high bits", () => {
    const buf = buildRequest(OP.STATE, 1, new Uint8Array([0b11110000]));
    expect(decodeRequest(buf).body).toEqual({
      includeUrl: false,
      includeTitle: false,
      includeLoading: false,
    });
  });
});

describe("decodeRequest — framing errors", () => {
  it("returns null for truncated request", () => {
    expect(decodeRequest(new Uint8Array([OP.CONTROL, 0, 0]).buffer)).toBeNull();
  });
  it("returns null for unknown opcode", () => {
    expect(decodeRequest(buildRequest(0x99, 1, new Uint8Array([0])))).toBeNull();
  });
});

describe("encodeResponse — opcodes 0x83 and 0x84", () => {
  // Note: 0x82 controlAck was removed — control is fire-and-forget.
  // Implicit acks: resize → next 0x80 config; nav-class → next 0x86.
  it("encodes evalResult with ok=true", () => {
    const bytes = bytesOf(encodeResponse(OP.EVAL_RESULT, 42, true, '{"result":"hello"}'));
    expect(bytes[0]).toBe(OP.EVAL_RESULT);
    expect(readU32BE(bytes, 1)).toBe(42);
    expect(bytes[5]).toBe(1); // ok
    const payload = '{"result":"hello"}';
    expect(readU32BE(bytes, 6)).toBe(new TextEncoder().encode(payload).length);
    expect(new TextDecoder().decode(bytes.slice(10))).toBe(payload);
  });

  it("encodes evalResult with ok=false", () => {
    const bytes = bytesOf(encodeResponse(OP.EVAL_RESULT, 7, false, '{"error":"x"}'));
    expect(bytes[0]).toBe(OP.EVAL_RESULT);
    expect(bytes[5]).toBe(0);
  });

  it("encodes stateSnapshot WITHOUT ok byte (ok lives in JSON)", () => {
    const bytes = bytesOf(encodeResponse(OP.STATE_SNAPSHOT, 1, true, '{"ok":true,"url":"x"}'));
    expect(bytes[0]).toBe(OP.STATE_SNAPSHOT);
    expect(readU32BE(bytes, 1)).toBe(1);
    // No ok byte — payloadLen starts at byte 5
    const payload = '{"ok":true,"url":"x"}';
    expect(readU32BE(bytes, 5)).toBe(new TextEncoder().encode(payload).length);
    expect(new TextDecoder().decode(bytes.slice(9))).toBe(payload);
  });
});

describe("encodeConfig — opcode 0x80", () => {
  it("encodes config preamble", () => {
    const codec = "avc1.42E01E";
    const bytes = bytesOf(encodeConfig(1920, 1080, codec));
    expect(bytes[0]).toBe(OP.CONFIG);
    expect(readU32BE(bytes, 1)).toBe(0); // reqId
    expect((bytes[5] << 8) | bytes[6]).toBe(1920); // codedWidth
    expect((bytes[7] << 8) | bytes[8]).toBe(1080); // codedHeight
    expect(bytes[9]).toBe(codec.length); // codecLen
    expect(new TextDecoder().decode(bytes.slice(10))).toBe(codec);
  });

  it("throws on oversized codec string", () => {
    expect(() => encodeConfig(0, 0, "x".repeat(256))).toThrow();
  });
});

describe("encodeVideoFrameHeader — opcode 0x81", () => {
  it("encodes a keyframe header (type=0)", () => {
    const buf = encodeVideoFrameHeader(true, 33_333n);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBe(14);
    expect(buf[0]).toBe(OP.VIDEO_FRAME);
    expect(readU32BE(buf, 1)).toBe(0); // reqId
    expect(buf[5]).toBe(0); // type=key
    // pts u64 BE = 33_333 → bytes 6..13
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(v.getBigUint64(6, false)).toBe(33_333n);
  });

  it("encodes a delta frame header (type=1)", () => {
    const buf = encodeVideoFrameHeader(false, 66_666n);
    expect(buf[5]).toBe(1); // type=delta
  });

  it("accepts a regular number for pts", () => {
    const buf = encodeVideoFrameHeader(true, 100);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(v.getBigUint64(6, false)).toBe(100n);
  });
});

describe("encodeConsoleEvent — opcode 0x85", () => {
  it("encodes a typical log event", () => {
    const ts = 1700000000000;
    const bytes = bytesOf(
      encodeConsoleEvent({
        kind: "log",
        text: "hello world",
        url: "https://x.y/foo.js",
        line: 42,
        ts,
      }),
    );
    expect(bytes[0]).toBe(OP.CONSOLE_EVENT);
    expect(readU32BE(bytes, 1)).toBe(0); // reqId
    expect(bytes[5]).toBe(3); // kindLen = "log"
    expect(new TextDecoder().decode(bytes.slice(6, 9))).toBe("log");
    const textLenOff = 9;
    expect(readU32BE(bytes, textLenOff)).toBe(11); // "hello world".length
    expect(new TextDecoder().decode(bytes.slice(13, 24))).toBe("hello world");
    const urlLenOff = 24;
    const urlLen = (bytes[urlLenOff] << 8) | bytes[urlLenOff + 1];
    expect(urlLen).toBe(18);
    expect(new TextDecoder().decode(bytes.slice(26, 26 + 18))).toBe("https://x.y/foo.js");
    const lineOff = 26 + 18;
    expect(readU32BE(bytes, lineOff)).toBe(42);
    const tsOff = lineOff + 4;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(v.getFloat64(tsOff, false)).toBe(ts);
  });

  it("handles missing url/line/text gracefully", () => {
    const bytes = bytesOf(encodeConsoleEvent({ kind: "error", text: "x" }));
    expect(bytes[0]).toBe(OP.CONSOLE_EVENT);
    // url empty, line=0, ts defaults to Date.now() so just check shape size
    // ≥ minimum: 1 (op) + 4 (reqId) + 1 (kindLen) + 5 (kind "error") + 4
    // (textLen) + 1 (text "x") + 2 (urlLen=0) + 0 (url) + 4 (line=0) + 8 (ts)
    expect(bytes.length).toBe(1 + 4 + 1 + 5 + 4 + 1 + 2 + 0 + 4 + 8);
  });
});

describe("encodeNavigateEvent — opcode 0x86", () => {
  it("encodes a navigate event", () => {
    const ts = 1700000000123;
    const bytes = bytesOf(encodeNavigateEvent({ url: "https://x.y", ts }));
    expect(bytes[0]).toBe(OP.NAVIGATE_EVENT);
    expect(readU32BE(bytes, 1)).toBe(0); // reqId
    const urlLen = (bytes[5] << 8) | bytes[6];
    expect(urlLen).toBe(11);
    expect(new TextDecoder().decode(bytes.slice(7, 18))).toBe("https://x.y");
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(v.getFloat64(18, false)).toBe(ts);
  });

  it("handles empty url", () => {
    const bytes = bytesOf(encodeNavigateEvent({ url: "", ts: 0 }));
    expect((bytes[5] << 8) | bytes[6]).toBe(0); // urlLen
    expect(bytes.length).toBe(1 + 4 + 2 + 0 + 8);
  });
});
