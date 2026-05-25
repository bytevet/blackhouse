// Binary input wire format for client→server input events over the
// browser WS. Reduces per-event payload from ~80–120 B of JSON to 6–14 B
// for the common (mouse/wheel) cases. The decoded object shape matches
// the REST `POST /browser/input` body so the shared `dispatchInput`
// helper handles both transports identically.
//
// Wire format (1-byte opcode + payload; all multi-byte ints big-endian):
//
//   Op   Event       Layout                                          Total
//   0x01 mouseMove   x:u16, y:u16, buttons:u8                         6 B
//   0x02 mouseDown   x:u16, y:u16, button:u8, buttons:u8,
//                    clickCount:u8, modifiers:u8                      9 B
//   0x03 mouseUp     (same as mouseDown)                              9 B
//   0x04 wheel       x:u16, y:u16, deltaX:f32, deltaY:f32, buttons:u8 14 B
//   0x05 keyDown     modifiers:u8, keyLen:u8, key:utf8,
//                    codeLen:u8, code:utf8                            4+N+M
//   0x06 keyUp       (same as keyDown)                                4+N+M
//   0x07 char        textLen:u8, text:utf8                            2+N
//
// `button` byte enum (single button, not bitmask):
//   0 = none, 1 = left, 2 = right, 4 = middle
// `buttons` is a CDP-style bitmask of currently-held buttons (same
// convention, OR'd together).
//
// Must stay in lockstep with `src/lib/browser-input-codec.ts` on the
// client side. Add new opcodes by appending; never reuse numbers.

export const OP = Object.freeze({
  MOUSE_MOVE: 0x01,
  MOUSE_DOWN: 0x02,
  MOUSE_UP: 0x03,
  WHEEL: 0x04,
  KEY_DOWN: 0x05,
  KEY_UP: 0x06,
  CHAR: 0x07,
});

const BUTTON_NAME = ["none", "left", "right", undefined, "middle"];

/**
 * Decode one binary input frame into the same object shape that
 * `POST /browser/input` accepts. Returns `null` for unknown opcodes
 * or truncated payloads — caller treats null as a silent drop.
 *
 * Accepts ArrayBuffer, Buffer, or Uint8Array (the `ws` package
 * normalizes binary frames to one of these depending on options).
 */
export function decode(input) {
  const view = toDataView(input);
  if (!view || view.byteLength < 1) return null;
  const op = view.getUint8(0);
  try {
    switch (op) {
      case OP.MOUSE_MOVE: {
        if (view.byteLength < 6) return null;
        return {
          type: "mouseMove",
          x: view.getUint16(1, false),
          y: view.getUint16(3, false),
          buttons: view.getUint8(5),
        };
      }
      case OP.MOUSE_DOWN:
      case OP.MOUSE_UP: {
        if (view.byteLength < 9) return null;
        return {
          type: op === OP.MOUSE_DOWN ? "mouseDown" : "mouseUp",
          x: view.getUint16(1, false),
          y: view.getUint16(3, false),
          button: BUTTON_NAME[view.getUint8(5)] ?? "none",
          buttons: view.getUint8(6),
          clickCount: view.getUint8(7),
          modifiers: view.getUint8(8),
        };
      }
      case OP.WHEEL: {
        if (view.byteLength < 14) return null;
        return {
          type: "wheel",
          x: view.getUint16(1, false),
          y: view.getUint16(3, false),
          deltaX: view.getFloat32(5, false),
          deltaY: view.getFloat32(9, false),
          buttons: view.getUint8(13),
        };
      }
      case OP.KEY_DOWN:
      case OP.KEY_UP: {
        if (view.byteLength < 4) return null;
        const modifiers = view.getUint8(1);
        const keyLen = view.getUint8(2);
        if (view.byteLength < 3 + keyLen + 1) return null;
        const key = readUtf8(view, 3, keyLen);
        const codeLenOffset = 3 + keyLen;
        const codeLen = view.getUint8(codeLenOffset);
        if (view.byteLength < codeLenOffset + 1 + codeLen) return null;
        const code = readUtf8(view, codeLenOffset + 1, codeLen);
        return {
          type: op === OP.KEY_DOWN ? "keyDown" : "keyUp",
          key,
          code,
          modifiers,
        };
      }
      case OP.CHAR: {
        if (view.byteLength < 2) return null;
        const textLen = view.getUint8(1);
        if (view.byteLength < 2 + textLen) return null;
        return { type: "char", text: readUtf8(view, 2, textLen) };
      }
      default:
        return null;
    }
  } catch {
    // Out-of-bounds reads or alignment issues — treat as malformed.
    return null;
  }
}

/**
 * Encode a payload (same shape `POST /browser/input` accepts) into a
 * binary frame. Exported primarily for tests + symmetry with the TS
 * client codec; the server doesn't normally encode input. Returns
 * null for unknown event types or out-of-range values.
 */
export function encode(payload) {
  if (!payload || typeof payload !== "object") return null;
  switch (payload.type) {
    case "mouseMove": {
      const buf = new ArrayBuffer(6);
      const v = new DataView(buf);
      v.setUint8(0, OP.MOUSE_MOVE);
      v.setUint16(1, clampU16(payload.x), false);
      v.setUint16(3, clampU16(payload.y), false);
      v.setUint8(5, clampU8(payload.buttons));
      return buf;
    }
    case "mouseDown":
    case "mouseUp": {
      const buf = new ArrayBuffer(9);
      const v = new DataView(buf);
      v.setUint8(0, payload.type === "mouseDown" ? OP.MOUSE_DOWN : OP.MOUSE_UP);
      v.setUint16(1, clampU16(payload.x), false);
      v.setUint16(3, clampU16(payload.y), false);
      v.setUint8(5, buttonNameToCode(payload.button));
      v.setUint8(6, clampU8(payload.buttons));
      v.setUint8(7, clampU8(payload.clickCount ?? 1));
      v.setUint8(8, clampU8(payload.modifiers));
      return buf;
    }
    case "wheel": {
      const buf = new ArrayBuffer(14);
      const v = new DataView(buf);
      v.setUint8(0, OP.WHEEL);
      v.setUint16(1, clampU16(payload.x), false);
      v.setUint16(3, clampU16(payload.y), false);
      v.setFloat32(5, payload.deltaX ?? 0, false);
      v.setFloat32(9, payload.deltaY ?? 0, false);
      v.setUint8(13, clampU8(payload.buttons));
      return buf;
    }
    case "keyDown":
    case "keyUp": {
      const keyBytes = utf8(payload.key ?? "");
      const codeBytes = utf8(payload.code ?? "");
      if (keyBytes.length > 255 || codeBytes.length > 255) return null;
      const buf = new ArrayBuffer(4 + keyBytes.length + codeBytes.length);
      const v = new DataView(buf);
      const u = new Uint8Array(buf);
      v.setUint8(0, payload.type === "keyDown" ? OP.KEY_DOWN : OP.KEY_UP);
      v.setUint8(1, clampU8(payload.modifiers));
      v.setUint8(2, keyBytes.length);
      u.set(keyBytes, 3);
      v.setUint8(3 + keyBytes.length, codeBytes.length);
      u.set(codeBytes, 4 + keyBytes.length);
      return buf;
    }
    case "char": {
      const textBytes = utf8(payload.text ?? "");
      if (textBytes.length > 255) return null;
      const buf = new ArrayBuffer(2 + textBytes.length);
      const v = new DataView(buf);
      const u = new Uint8Array(buf);
      v.setUint8(0, OP.CHAR);
      v.setUint8(1, textBytes.length);
      u.set(textBytes, 2);
      return buf;
    }
    default:
      return null;
  }
}

// --- helpers ----------------------------------------------------------------

function toDataView(input) {
  if (!input) return null;
  if (input instanceof DataView) return input;
  if (input instanceof ArrayBuffer) return new DataView(input);
  // Buffer (Node) and Uint8Array both have byteOffset/byteLength on the
  // underlying ArrayBuffer.
  if (ArrayBuffer.isView(input)) {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder("utf-8");
function utf8(str) {
  return TEXT_ENC.encode(str);
}
function readUtf8(view, offset, length) {
  const slice = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return TEXT_DEC.decode(slice);
}

function clampU16(n) {
  const v = Math.max(0, Math.min(0xffff, Math.round(Number(n) || 0)));
  return v;
}
function clampU8(n) {
  const v = Math.max(0, Math.min(0xff, Math.round(Number(n) || 0)));
  return v;
}
function buttonNameToCode(name) {
  switch (name) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
    default:
      return 0;
  }
}
