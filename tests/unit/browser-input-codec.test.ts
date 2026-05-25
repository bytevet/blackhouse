import { describe, it, expect } from "vitest";
import { encodeInput, decodeInput, INPUT_OP, type InputPayload } from "@/lib/browser-input-codec";

/**
 * Wire-format tests for #60. These also serve as the shared fixture between
 * the client encoder and be's server-side decoder — if a byte assertion here
 * changes, the server must be updated in lockstep.
 */
describe("browser-input-codec", () => {
  describe("encode + decode round-trip", () => {
    const cases: InputPayload[] = [
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
        const buf = encodeInput(p);
        expect(buf).not.toBeNull();
        const decoded = decodeInput(buf!);
        // Wheel deltas are f32 so a tolerance check is needed for non-integer values;
        // round-trip the same way it'd land on the server.
        if (p.type === "wheel") {
          expect(decoded).toMatchObject({
            type: "wheel",
            x: p.x,
            y: p.y,
            buttons: p.buttons,
          });
          expect((decoded as Required<InputPayload>).deltaX).toBeCloseTo(p.deltaX ?? 0, 5);
          expect((decoded as Required<InputPayload>).deltaY).toBeCloseTo(p.deltaY ?? 0, 5);
        } else {
          expect(decoded).toEqual(p);
        }
      });
    }
  });

  describe("byte-level layout (cross-language fixture for be)", () => {
    it("encodes mouseMove as op=0x01 + u16BE x + u16BE y + u8 buttons (6 bytes)", () => {
      const buf = encodeInput({ type: "mouseMove", x: 0x1234, y: 0x5678, buttons: 0x07 });
      expect(buf).not.toBeNull();
      expect(new Uint8Array(buf!)).toEqual(new Uint8Array([0x01, 0x12, 0x34, 0x56, 0x78, 0x07]));
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
      expect(new Uint8Array(buf!)).toEqual(
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
      expect(new Uint8Array(buf!)).toEqual(
        new Uint8Array([
          0x04, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x80, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00,
        ]),
      );
    });

    it("encodes keyDown with utf8 key + code", () => {
      const buf = encodeInput({ type: "keyDown", key: "a", code: "KeyA", modifiers: 0 });
      // op=0x05, mods=0, keyLen=1, "a"=0x61, codeLen=4, "KeyA"=0x4B,0x65,0x79,0x41
      expect(new Uint8Array(buf!)).toEqual(
        new Uint8Array([0x05, 0x00, 0x01, 0x61, 0x04, 0x4b, 0x65, 0x79, 0x41]),
      );
    });

    it("encodes char with utf8 text", () => {
      const buf = encodeInput({ type: "char", text: "a" });
      expect(new Uint8Array(buf!)).toEqual(new Uint8Array([0x07, 0x01, 0x61]));
    });

    it("encodes multi-byte char (你 is 3 bytes in utf-8)", () => {
      const buf = encodeInput({ type: "char", text: "你" });
      expect(new Uint8Array(buf!)).toEqual(new Uint8Array([0x07, 0x03, 0xe4, 0xbd, 0xa0]));
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

  describe("encodeInput returns null for unencodable payloads", () => {
    it("rejects out-of-u16 coords", () => {
      expect(encodeInput({ type: "mouseMove", x: 70000, y: 0, buttons: 0 })).toBeNull();
      expect(encodeInput({ type: "mouseMove", x: -1, y: 0, buttons: 0 })).toBeNull();
    });

    it("rejects non-integer coords", () => {
      expect(encodeInput({ type: "mouseMove", x: 1.5, y: 0, buttons: 0 })).toBeNull();
    });

    it("rejects unknown button name", () => {
      expect(
        encodeInput({
          type: "mouseDown",
          x: 0,
          y: 0,
          button: "wheel",
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        }),
      ).toBeNull();
    });

    it("rejects strings longer than 255 bytes", () => {
      const longKey = "x".repeat(256);
      expect(encodeInput({ type: "keyDown", key: longKey, code: "", modifiers: 0 })).toBeNull();
    });

    it("rejects unknown event type", () => {
      // Cast bypasses the type system to simulate a runtime payload from an
      // older or buggy producer; encoder should refuse cleanly.
      expect(encodeInput({ type: "unknown" as never })).toBeNull();
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
});
