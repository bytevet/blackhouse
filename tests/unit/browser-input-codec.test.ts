import { describe, it, expect } from "vitest";
import {
  encodeInput,
  decodeInput,
  INPUT_OP,
  encodeRequest,
  decodeResponse,
  decodeConfig,
  decodeConsoleEvent,
  decodeNavigateEvent,
  decodeVideoFrame,
  REQUEST_OP,
  RESPONSE_OP,
  PUSH_OP,
  CONTROL_ACTION,
  type InputMessage,
} from "@/lib/browser-input-codec";

/**
 * Wire-format tests for #60 + #61. Doubles as the cross-language fixture for
 * be's server-side decoder — if a byte assertion here changes, the server
 * must be updated in lockstep. Mirror of
 * `agent/browser-service/input-codec.mjs` + `tests/unit/browser-ws-request-codec.test.ts`.
 */
describe("browser-input-codec", () => {
  describe("encode + decode round-trip", () => {
    const cases: InputMessage[] = [
      { type: "mouseMove", x: 100, y: 200, buttons: 1 },
      { type: "mouseMove", x: 0, y: 0, buttons: 0 },
      { type: "mouseMove", x: 65535, y: 65535, buttons: 7 },
      {
        type: "mouseDown",
        x: 300,
        y: 400,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
      {
        type: "mouseUp",
        x: 300,
        y: 400,
        button: "right",
        buttons: 0,
        clickCount: 1,
        modifiers: 4,
      },
      { type: "wheel", x: 500, y: 600, deltaX: 0, deltaY: -120, buttons: 0 },
      { type: "wheel", x: 500, y: 600, deltaX: 12.5, deltaY: -7.25, buttons: 1 },
      { type: "keyDown", key: "Enter", code: "Enter", modifiers: 0 },
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 },
      { type: "keyUp", key: "ArrowDown", code: "ArrowDown", modifiers: 0 },
      { type: "char", text: "a" },
      { type: "char", text: "你" }, // multi-byte UTF-8
      { type: "char", text: "Hello" },
    ];

    for (const p of cases) {
      it(`round-trips ${p.type} ${JSON.stringify(p)}`, () => {
        const decoded = decodeInput(encodeInput(p));
        if (p.type === "wheel") {
          // f32 round-trip needs a tolerance check for non-integer deltas.
          expect(decoded).toMatchObject({
            type: "wheel",
            x: p.x,
            y: p.y,
            buttons: p.buttons,
          });
          expect(decoded).not.toBeNull();
          const w = decoded as Extract<InputMessage, { type: "wheel" }>;
          expect(w.deltaX).toBeCloseTo(p.deltaX, 5);
          expect(w.deltaY).toBeCloseTo(p.deltaY, 5);
        } else {
          expect(decoded).toEqual(p);
        }
      });
    }
  });

  describe("byte-level layout (cross-language fixture for be)", () => {
    it("encodes mouseMove as op=0x01 + u16BE x + u16BE y + u8 buttons (6 bytes)", () => {
      const buf = encodeInput({ type: "mouseMove", x: 0x1234, y: 0x5678, buttons: 0x07 });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x01, 0x12, 0x34, 0x56, 0x78, 0x07]));
    });

    it("encodes mouseDown as op=0x02 + coords + button/buttons/clickCount/modifiers (9 bytes)", () => {
      const buf = encodeInput({
        type: "mouseDown",
        x: 0x0a0b,
        y: 0x0c0d,
        button: "right",
        buttons: 2,
        clickCount: 1,
        modifiers: 0,
      });
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0x02, 0x02, 0x01, 0x00]),
      );
    });

    it("encodes wheel as op=0x04 + coords + f32BE deltas + buttons (14 bytes)", () => {
      const buf = encodeInput({
        type: "wheel",
        x: 0,
        y: 0,
        deltaX: 1.0,
        deltaY: 2.0,
        buttons: 0,
      });
      // f32 BE of 1.0 = 0x3F800000, of 2.0 = 0x40000000
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([
          0x04, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x80, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00,
        ]),
      );
    });

    it("encodes keyDown with utf8 key + code", () => {
      const buf = encodeInput({ type: "keyDown", key: "a", code: "KeyA", modifiers: 0 });
      // op=0x05, mods=0, keyLen=1, "a"=0x61, codeLen=4, "KeyA"=0x4B,0x65,0x79,0x41
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([0x05, 0x00, 0x01, 0x61, 0x04, 0x4b, 0x65, 0x79, 0x41]),
      );
    });

    it("encodes char with utf8 text", () => {
      const buf = encodeInput({ type: "char", text: "a" });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x07, 0x01, 0x61]));
    });

    it("encodes multi-byte char (你 is 3 bytes in utf-8)", () => {
      const buf = encodeInput({ type: "char", text: "你" });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x07, 0x03, 0xe4, 0xbd, 0xa0]));
    });
  });

  describe("op constants exposed for be parity", () => {
    it("matches the documented op table", () => {
      expect(INPUT_OP).toEqual({
        mouseMove: 0x01,
        mouseDown: 0x02,
        mouseUp: 0x03,
        wheel: 0x04,
        keyDown: 0x05,
        keyUp: 0x06,
        char: 0x07,
      });
    });
  });

  describe("decodeInput returns null for malformed buffers", () => {
    it("rejects empty buffer", () => {
      expect(decodeInput(new Uint8Array(0))).toBeNull();
    });

    it("rejects unknown op", () => {
      expect(decodeInput(new Uint8Array([0xff]))).toBeNull();
    });

    it("rejects truncated mouseMove", () => {
      expect(decodeInput(new Uint8Array([0x01, 0x00]))).toBeNull();
    });

    it("rejects truncated keyDown (declared len exceeds buffer)", () => {
      expect(decodeInput(new Uint8Array([0x05, 0x00, 0x10, 0x61]))).toBeNull();
    });
  });

  // ─── #61 request/response codec ─────────────────────────────────────────

  describe("encodeRequest CONTROL (0x10) — fire-and-forget, reqId=0", () => {
    it("encodes navigate with url, width=0, height=0", () => {
      const buf = encodeRequest(REQUEST_OP.control, 0, {
        action: "navigate",
        url: "https://x.y",
      });
      // op=0x10, reqId=0, action=3 (navigate, 0-indexed), urlLen=11 (u16 BE),
      // url="https://x.y", width=0, height=0 → 23 bytes total.
      const url = new TextEncoder().encode("https://x.y");
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([
          0x10,
          0,
          0,
          0,
          0, // reqId=0 (fire-and-forget)
          3, // action: navigate (be's CONTROL_ACTION index)
          0,
          url.length, // urlLen=11
          ...url,
          0,
          0, // width=0
          0,
          0, // height=0
        ]),
      );
    });

    it("encodes resize with width/height, empty url", () => {
      const buf = encodeRequest(REQUEST_OP.control, 0, {
        action: "resize",
        width: 1280,
        height: 720,
      });
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([
          0x10,
          0,
          0,
          0,
          0, // reqId
          4, // action: resize
          0,
          0, // urlLen=0
          0x05,
          0x00, // width=1280 (0x0500)
          0x02,
          0xd0, // height=720 (0x02D0)
        ]),
      );
    });

    it("encodes back with no url and no dims (all zero filler)", () => {
      const buf = encodeRequest(REQUEST_OP.control, 0, { action: "back" });
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([
          0x10,
          0,
          0,
          0,
          0, // reqId
          0, // action: back (index 0)
          0,
          0, // urlLen=0
          0,
          0, // width=0
          0,
          0, // height=0
        ]),
      );
    });

    it("forward and reload encode to the documented indices", () => {
      expect(new Uint8Array(encodeRequest(REQUEST_OP.control, 0, { action: "forward" }))[5]).toBe(
        1,
      );
      expect(new Uint8Array(encodeRequest(REQUEST_OP.control, 0, { action: "reload" }))[5]).toBe(2);
    });
  });

  describe("encodeRequest EVAL (0x11)", () => {
    it("encodes a short expression with u32 BE length", () => {
      const buf = encodeRequest(REQUEST_OP.eval, 13, { expression: "1 + 2" });
      const expr = new TextEncoder().encode("1 + 2");
      expect(new Uint8Array(buf)).toEqual(
        new Uint8Array([
          0x11,
          0,
          0,
          0,
          13, // reqId
          0,
          0,
          0,
          expr.length, // exprLen u32 BE = 5
          ...expr,
        ]),
      );
    });

    it("encodes multi-byte UTF-8 expression preserving byte count", () => {
      const buf = encodeRequest(REQUEST_OP.eval, 1, { expression: "你好" });
      // "你好" = 6 utf-8 bytes (3 each)
      const bytes = new Uint8Array(buf);
      // exprLen at offset 5..9
      expect(bytes[5]).toBe(0);
      expect(bytes[6]).toBe(0);
      expect(bytes[7]).toBe(0);
      expect(bytes[8]).toBe(6);
      expect(bytes.slice(9)).toEqual(new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]));
    });
  });

  describe("encodeRequest STATE (0x12) — include-bit flags", () => {
    it("encodes all six include-bits set as flags=0b111111", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, {
        includeUrl: true,
        includeTitle: true,
        includeLoading: true,
        includeSelection: true,
        includeScroll: true,
        includeContextMenu: true,
      });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00111111]));
    });

    it("encodes includeUrl-only as flags=0b000001", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeUrl: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00000001]));
    });

    it("encodes includeTitle-only as flags=0b000010", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeTitle: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00000010]));
    });

    it("encodes includeLoading-only as flags=0b000100", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeLoading: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00000100]));
    });

    it("encodes includeSelection-only as flags=0b001000", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeSelection: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00001000]));
    });

    it("encodes includeScroll-only as flags=0b010000", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeScroll: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00010000]));
    });

    it("encodes includeContextMenu-only as flags=0b100000", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, { includeContextMenu: true });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00100000]));
    });

    it("encodes strict-probe combo (selection+scroll+contextMenu) as flags=0b111000", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, {
        includeSelection: true,
        includeScroll: true,
        includeContextMenu: true,
      });
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0b00111000]));
    });

    it("encodes empty body as flags=0", () => {
      const buf = encodeRequest(REQUEST_OP.state, 1, {});
      expect(new Uint8Array(buf)).toEqual(new Uint8Array([0x12, 0, 0, 0, 1, 0]));
    });
  });

  describe("CONTROL_ACTION constants exposed for be parity", () => {
    it("matches be's 0-indexed CONTROL_ACTION = ['back', 'forward', 'reload', 'navigate', 'resize']", () => {
      expect(CONTROL_ACTION).toEqual({
        back: 0,
        forward: 1,
        reload: 2,
        navigate: 3,
        resize: 4,
      });
    });
  });

  describe("decodeResponse 0x83 evalResult (with ok byte)", () => {
    it("decodes an evalResult with ok=false and error payload", () => {
      const json = '{"ok":false,"error":{"description":"boom"}}';
      const payload = new TextEncoder().encode(json);
      const buf = new Uint8Array(10 + payload.length);
      buf[0] = 0x83;
      buf[4] = 7;
      buf[5] = 0; // ok=false
      buf[9] = payload.length;
      buf.set(payload, 10);

      const decoded = decodeResponse(buf);
      expect(decoded).toMatchObject({
        opcode: RESPONSE_OP.evalResult,
        reqId: 7,
        ok: false,
      });
      expect(
        (decoded as { payload: { error: { description: string } } }).payload.error.description,
      ).toBe("boom");
    });

    it("reads u32 BE reqId across all four bytes", () => {
      const payload = new TextEncoder().encode("{}");
      const buf = new Uint8Array(10 + payload.length);
      buf[0] = 0x83;
      buf[1] = 0x01;
      buf[2] = 0x02;
      buf[3] = 0x03;
      buf[4] = 0x04;
      buf[5] = 1;
      buf[9] = payload.length;
      buf.set(payload, 10);
      expect(decodeResponse(buf)?.reqId).toBe(0x01020304);
    });

    it("returns null for the dropped 0x82 controlAck opcode", () => {
      // 0x82 is no longer a recognised response opcode (#61 cut2). The
      // server may still emit briefly during the BE-cut2 transition; the
      // decoder treats them as unknown → silent drop at the call site.
      const payload = new TextEncoder().encode('{"ok":true}');
      const buf = new Uint8Array(10 + payload.length);
      buf[0] = 0x82;
      buf[4] = 1;
      buf[5] = 1;
      buf[9] = payload.length;
      buf.set(payload, 10);
      expect(decodeResponse(buf)).toBeNull();
    });
  });

  describe("decodeResponse 0x84 (no ok byte)", () => {
    it("decodes a stateSnapshot — ok lives inside the JSON, not before payloadLen", () => {
      // [op=0x84, reqId u32 BE = 1, payloadLen u32 BE, payload]   (no ok byte)
      const json = '{"ok":true,"url":"https://x.y","title":"hi","loading":false}';
      const payload = new TextEncoder().encode(json);
      const buf = new Uint8Array(9 + payload.length);
      buf[0] = 0x84;
      buf[4] = 1; // reqId
      buf[8] = payload.length; // payloadLen
      buf.set(payload, 9);

      const decoded = decodeResponse(buf);
      expect(decoded).toEqual({
        opcode: RESPONSE_OP.stateSnapshot,
        reqId: 1,
        payload: { ok: true, url: "https://x.y", title: "hi", loading: false },
      });
      // Discriminated union: no `ok` field on the 0x84 variant.
      expect(decoded && "ok" in decoded).toBe(false);
    });

    it("handles large JSON payload (4-byte length field exercised)", () => {
      // Build a ~1KB payload to exercise the u32 length field beyond u16 range
      // would be wasteful; 1KB is enough to confirm the offset math works.
      const big = "x".repeat(1024);
      const json = JSON.stringify({ ok: true, blob: big });
      const payload = new TextEncoder().encode(json);
      const buf = new Uint8Array(9 + payload.length);
      buf[0] = 0x84;
      buf[4] = 2;
      // payloadLen u32 BE
      buf[5] = (payload.length >>> 24) & 0xff;
      buf[6] = (payload.length >>> 16) & 0xff;
      buf[7] = (payload.length >>> 8) & 0xff;
      buf[8] = payload.length & 0xff;
      buf.set(payload, 9);

      const decoded = decodeResponse(buf);
      expect((decoded as { payload: { blob: string } } | null)?.payload.blob).toBe(big);
    });
  });

  describe("decodeResponse returns null for malformed buffers", () => {
    it("rejects buffer shorter than 5 bytes (no reqId yet)", () => {
      expect(decodeResponse(new Uint8Array([0x83, 0, 0, 0]))).toBeNull();
    });

    it("rejects unknown opcode", () => {
      expect(decodeResponse(new Uint8Array([0x99, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    });

    it("rejects truncated 0x83 (header says payloadLen exceeds buffer)", () => {
      // op=0x83, reqId=1, ok=1, payloadLen=100 but no payload bytes
      const buf = new Uint8Array([0x83, 0, 0, 0, 1, 1, 0, 0, 0, 100]);
      expect(decodeResponse(buf)).toBeNull();
    });

    it("rejects malformed JSON payload", () => {
      // Valid header, invalid JSON body
      const bad = new TextEncoder().encode("{not json");
      const buf = new Uint8Array(10 + bad.length);
      buf[0] = 0x83;
      buf[5] = 1;
      buf[9] = bad.length;
      buf.set(bad, 10);
      expect(decodeResponse(buf)).toBeNull();
    });
  });

  describe("REQUEST_OP / RESPONSE_OP / PUSH_OP constants", () => {
    it("matches the documented op table", () => {
      expect(REQUEST_OP).toEqual({ control: 0x10, eval: 0x11, state: 0x12 });
      expect(RESPONSE_OP).toEqual({ evalResult: 0x83, stateSnapshot: 0x84 });
      expect(PUSH_OP).toEqual({
        config: 0x80,
        videoFrame: 0x81,
        consoleEvent: 0x85,
        navigateEvent: 0x86,
      });
    });
  });

  // ─── #61 push-frame decoders (0x80/0x81/0x85/0x86) ──────────────────────

  describe("decodeConfig (0x80)", () => {
    it("decodes the screencast config frame", () => {
      // [op=0x80, reqId=0 (u32), codedWidth=1280 (u16), codedHeight=720 (u16),
      //  codecLen=10 (u8), codec="avc1.42E01F"]
      const codec = new TextEncoder().encode("avc1.42E01F");
      const buf = new Uint8Array(10 + codec.length);
      buf[0] = 0x80;
      // reqId 0
      buf[5] = (1280 >>> 8) & 0xff;
      buf[6] = 1280 & 0xff;
      buf[7] = (720 >>> 8) & 0xff;
      buf[8] = 720 & 0xff;
      buf[9] = codec.length;
      buf.set(codec, 10);

      expect(decodeConfig(buf)).toEqual({
        codedWidth: 1280,
        codedHeight: 720,
        codec: "avc1.42E01F",
      });
    });

    it("returns null for unknown opcode", () => {
      expect(decodeConfig(new Uint8Array([0x99, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    });

    it("returns null when codecLen exceeds buffer", () => {
      const buf = new Uint8Array(10);
      buf[0] = 0x80;
      buf[9] = 99; // codecLen
      expect(decodeConfig(buf)).toBeNull();
    });
  });

  describe("decodeVideoFrame (0x81)", () => {
    it("decodes the 14-byte header + NALU bytes", () => {
      // [op=0x81, reqId=0, type=0 (key), pts=0x0102030405060708 (u64), nalu...]
      const nalu = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb]);
      const buf = new Uint8Array(14 + nalu.length);
      buf[0] = 0x81;
      // pts BE
      buf[6] = 0x01;
      buf[7] = 0x02;
      buf[8] = 0x03;
      buf[9] = 0x04;
      buf[10] = 0x05;
      buf[11] = 0x06;
      buf[12] = 0x07;
      buf[13] = 0x08;
      buf.set(nalu, 14);

      const decoded = decodeVideoFrame(buf);
      expect(decoded).not.toBeNull();
      expect(decoded?.isKey).toBe(true);
      expect(decoded?.pts).toBe(0x0102030405060708n);
      expect(Array.from(decoded?.nalu ?? [])).toEqual(Array.from(nalu));
    });

    it("decodes a delta frame", () => {
      const buf = new Uint8Array(14);
      buf[0] = 0x81;
      buf[5] = 1; // type=1 (delta)
      expect(decodeVideoFrame(buf)?.isKey).toBe(false);
    });

    it("returns null for truncated header", () => {
      expect(decodeVideoFrame(new Uint8Array([0x81, 0, 0, 0, 0, 0]))).toBeNull();
    });
  });

  describe("decodeConsoleEvent (0x85)", () => {
    it("decodes a console event with all fields populated", () => {
      const kind = new TextEncoder().encode("warn");
      const text = new TextEncoder().encode("uh oh");
      const url = new TextEncoder().encode("https://x.y");
      // header: op(1) + reqId(4) + kindLen(1) + kind + textLen(4) + text +
      //         urlLen(2) + url + line(4) + ts(8)
      const buf = new Uint8Array(
        1 + 4 + 1 + kind.length + 4 + text.length + 2 + url.length + 4 + 8,
      );
      const dv = new DataView(buf.buffer);
      let off = 0;
      dv.setUint8(off, 0x85);
      off += 1;
      dv.setUint32(off, 0, false);
      off += 4; // reqId
      dv.setUint8(off, kind.length);
      off += 1;
      buf.set(kind, off);
      off += kind.length;
      dv.setUint32(off, text.length, false);
      off += 4;
      buf.set(text, off);
      off += text.length;
      dv.setUint16(off, url.length, false);
      off += 2;
      buf.set(url, off);
      off += url.length;
      dv.setUint32(off, 42, false);
      off += 4; // line
      dv.setFloat64(off, 1_700_000_000_000, false); // ts

      expect(decodeConsoleEvent(buf)).toEqual({
        kind: "warn",
        text: "uh oh",
        url: "https://x.y",
        line: 42,
        ts: 1_700_000_000_000,
      });
    });

    it("returns null for truncated buffer", () => {
      expect(decodeConsoleEvent(new Uint8Array([0x85, 0, 0, 0, 0, 1]))).toBeNull();
    });
  });

  describe("decodeNavigateEvent (0x86)", () => {
    it("decodes a navigate event", () => {
      const url = new TextEncoder().encode("https://example.com/path");
      const buf = new Uint8Array(1 + 4 + 2 + url.length + 8);
      const dv = new DataView(buf.buffer);
      dv.setUint8(0, 0x86);
      dv.setUint32(1, 0, false); // reqId
      dv.setUint16(5, url.length, false);
      buf.set(url, 7);
      dv.setFloat64(7 + url.length, 1_700_000_000_000, false);

      expect(decodeNavigateEvent(buf)).toEqual({
        url: "https://example.com/path",
        ts: 1_700_000_000_000,
      });
    });

    it("returns null for unknown opcode", () => {
      expect(decodeNavigateEvent(new Uint8Array(15))).toBeNull();
    });

    it("returns null when urlLen exceeds buffer", () => {
      const buf = new Uint8Array(15);
      buf[0] = 0x86;
      buf[5] = 0x10; // urlLen high byte = 4096, way past buffer
      expect(decodeNavigateEvent(buf)).toBeNull();
    });
  });
});
