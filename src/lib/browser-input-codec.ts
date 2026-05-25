/**
 * Binary wire codec for browser input events over the screencast WS (#60).
 *
 * The JSON-over-WS shape sent ~80–120 bytes per event (header, key names,
 * field names, quotes, separators). At trackpad rates that's thousands of
 * bytes per second of overhead for fire-and-forget input. The fixed-layout
 * binary encoding below collapses each event to 6–14 bytes plus a per-type
 * 1-byte op code.
 *
 * Wire format — all multi-byte numbers BIG-ENDIAN:
 *
 * | Op   | Event      | Layout                                             |
 * |------|------------|----------------------------------------------------|
 * | 0x01 | mouseMove  | x:u16, y:u16, buttons:u8                          |
 * | 0x02 | mouseDown  | x:u16, y:u16, button:u8, buttons:u8,              |
 * |      |            |   clickCount:u8, modifiers:u8                     |
 * | 0x03 | mouseUp    | (same as mouseDown)                               |
 * | 0x04 | wheel      | x:u16, y:u16, dx:f32, dy:f32, buttons:u8          |
 * | 0x05 | keyDown    | modifiers:u8, keyLen:u8, key (utf8),              |
 * |      |            |   codeLen:u8, code (utf8)                         |
 * | 0x06 | keyUp      | (same as keyDown)                                 |
 * | 0x07 | char       | textLen:u8, text (utf8)                           |
 *
 * `button` mapping (CDP `Input.dispatchMouseEvent` button names):
 *   "none" → 0, "left" → 1, "right" → 2, "middle" → 4.
 *
 * Returns `null` from `encodeInput` for any payload that doesn't fit (e.g.
 * out-of-u16 coord, string > 255 bytes). The caller's contract is to fall
 * back to JSON in that case, so behavior never silently degrades.
 */

export const INPUT_OP = {
  mouseMove: 0x01,
  mouseDown: 0x02,
  mouseUp: 0x03,
  wheel: 0x04,
  keyDown: 0x05,
  keyUp: 0x06,
  char: 0x07,
} as const;

export type InputType = keyof typeof INPUT_OP;

export interface InputPayload {
  type: InputType;
  x?: number;
  y?: number;
  button?: string;
  buttons?: number;
  clickCount?: number;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
}

const BUTTON_NAME_TO_CODE: Record<string, number> = {
  none: 0,
  left: 1,
  right: 2,
  middle: 4,
};

const BUTTON_CODE_TO_NAME: Record<number, "none" | "left" | "right" | "middle"> = {
  0: "none",
  1: "left",
  2: "right",
  4: "middle",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** True if `n` is an integer that fits in an unsigned 16-bit slot. */
function isU16(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xffff;
}

/** True if `n` is an integer that fits in an unsigned 8-bit slot. */
function isU8(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xff;
}

/**
 * Encode an input payload to the binary wire format. Returns `null` when the
 * payload doesn't fit (caller should fall back to JSON).
 */
export function encodeInput(p: InputPayload): ArrayBuffer | null {
  switch (p.type) {
    case "mouseMove": {
      if (!isU16(p.x) || !isU16(p.y)) return null;
      const buttons = isU8(p.buttons) ? p.buttons : 0;
      const buf = new ArrayBuffer(6);
      const dv = new DataView(buf);
      dv.setUint8(0, INPUT_OP.mouseMove);
      dv.setUint16(1, p.x, false);
      dv.setUint16(3, p.y, false);
      dv.setUint8(5, buttons);
      return buf;
    }
    case "mouseDown":
    case "mouseUp": {
      if (!isU16(p.x) || !isU16(p.y)) return null;
      const button = BUTTON_NAME_TO_CODE[p.button ?? "none"];
      if (button === undefined) return null;
      const buttons = isU8(p.buttons) ? p.buttons : 0;
      const clickCount = isU8(p.clickCount) ? p.clickCount : 0;
      const modifiers = isU8(p.modifiers) ? p.modifiers : 0;
      const buf = new ArrayBuffer(9);
      const dv = new DataView(buf);
      dv.setUint8(0, p.type === "mouseDown" ? INPUT_OP.mouseDown : INPUT_OP.mouseUp);
      dv.setUint16(1, p.x, false);
      dv.setUint16(3, p.y, false);
      dv.setUint8(5, button);
      dv.setUint8(6, buttons);
      dv.setUint8(7, clickCount);
      dv.setUint8(8, modifiers);
      return buf;
    }
    case "wheel": {
      if (!isU16(p.x) || !isU16(p.y)) return null;
      const buttons = isU8(p.buttons) ? p.buttons : 0;
      const dx = typeof p.deltaX === "number" ? p.deltaX : 0;
      const dy = typeof p.deltaY === "number" ? p.deltaY : 0;
      const buf = new ArrayBuffer(14);
      const dv = new DataView(buf);
      dv.setUint8(0, INPUT_OP.wheel);
      dv.setUint16(1, p.x, false);
      dv.setUint16(3, p.y, false);
      dv.setFloat32(5, dx, false);
      dv.setFloat32(9, dy, false);
      dv.setUint8(13, buttons);
      return buf;
    }
    case "keyDown":
    case "keyUp": {
      const modifiers = isU8(p.modifiers) ? p.modifiers : 0;
      const keyBytes = textEncoder.encode(p.key ?? "");
      const codeBytes = textEncoder.encode(p.code ?? "");
      if (keyBytes.length > 0xff || codeBytes.length > 0xff) return null;
      const buf = new ArrayBuffer(4 + keyBytes.length + codeBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, p.type === "keyDown" ? INPUT_OP.keyDown : INPUT_OP.keyUp);
      dv.setUint8(1, modifiers);
      dv.setUint8(2, keyBytes.length);
      u8.set(keyBytes, 3);
      dv.setUint8(3 + keyBytes.length, codeBytes.length);
      u8.set(codeBytes, 4 + keyBytes.length);
      return buf;
    }
    case "char": {
      const textBytes = textEncoder.encode(p.text ?? "");
      if (textBytes.length > 0xff) return null;
      const buf = new ArrayBuffer(2 + textBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, INPUT_OP.char);
      dv.setUint8(1, textBytes.length);
      u8.set(textBytes, 2);
      return buf;
    }
    default:
      return null;
  }
}

/**
 * Decode a wire frame back to its payload. Returns `null` on malformed input
 * (unknown op, truncated buffer, etc.). Provided as the symmetric counterpart
 * to `encodeInput` for unit testing; the server has its own decode path that
 * shares this byte layout.
 */
export function decodeInput(buf: ArrayBuffer | Uint8Array): InputPayload | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 1) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const op = view[0];

  switch (op) {
    case INPUT_OP.mouseMove: {
      if (view.length < 6) return null;
      return {
        type: "mouseMove",
        x: dv.getUint16(1, false),
        y: dv.getUint16(3, false),
        buttons: dv.getUint8(5),
      };
    }
    case INPUT_OP.mouseDown:
    case INPUT_OP.mouseUp: {
      if (view.length < 9) return null;
      return {
        type: op === INPUT_OP.mouseDown ? "mouseDown" : "mouseUp",
        x: dv.getUint16(1, false),
        y: dv.getUint16(3, false),
        button: BUTTON_CODE_TO_NAME[dv.getUint8(5)] ?? "none",
        buttons: dv.getUint8(6),
        clickCount: dv.getUint8(7),
        modifiers: dv.getUint8(8),
      };
    }
    case INPUT_OP.wheel: {
      if (view.length < 14) return null;
      return {
        type: "wheel",
        x: dv.getUint16(1, false),
        y: dv.getUint16(3, false),
        deltaX: dv.getFloat32(5, false),
        deltaY: dv.getFloat32(9, false),
        buttons: dv.getUint8(13),
      };
    }
    case INPUT_OP.keyDown:
    case INPUT_OP.keyUp: {
      if (view.length < 4) return null;
      const modifiers = dv.getUint8(1);
      const keyLen = dv.getUint8(2);
      if (view.length < 3 + keyLen + 1) return null;
      const key = textDecoder.decode(view.subarray(3, 3 + keyLen));
      const codeLen = dv.getUint8(3 + keyLen);
      if (view.length < 4 + keyLen + codeLen) return null;
      const code = textDecoder.decode(view.subarray(4 + keyLen, 4 + keyLen + codeLen));
      return {
        type: op === INPUT_OP.keyDown ? "keyDown" : "keyUp",
        modifiers,
        key,
        code,
      };
    }
    case INPUT_OP.char: {
      if (view.length < 2) return null;
      const textLen = dv.getUint8(1);
      if (view.length < 2 + textLen) return null;
      return {
        type: "char",
        text: textDecoder.decode(view.subarray(2, 2 + textLen)),
      };
    }
    default:
      return null;
  }
}
