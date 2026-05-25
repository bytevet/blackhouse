/**
 * Binary wire codec for browser input events over the screencast WS (#60).
 *
 * Fixed-layout frames keep each event at 6–14 bytes (plus a 1-byte op code)
 * vs ~80–120 bytes for the equivalent JSON. Per-event-type layouts:
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
 * All multi-byte numbers big-endian. `button` mapping: "none"→0, "left"→1,
 * "right"→2, "middle"→4.
 *
 * The input shape is a discriminated union (`InputMessage`) so the encoder's
 * switch is statically exhaustive — adding a new event type is a tsc error
 * until every site catches up.
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
export type ButtonName = "none" | "left" | "right" | "middle";

export interface MouseMoveInput {
  type: "mouseMove";
  x: number;
  y: number;
  buttons: number;
}
interface MouseButtonFields {
  x: number;
  y: number;
  button: ButtonName;
  buttons: number;
  clickCount: number;
  modifiers?: number;
}
export type MouseDownInput = MouseButtonFields & { type: "mouseDown" };
export type MouseUpInput = MouseButtonFields & { type: "mouseUp" };
export interface WheelInput {
  type: "wheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  buttons: number;
}
interface KeyboardFields {
  key: string;
  code: string;
  modifiers?: number;
}
export type KeyDownInput = KeyboardFields & { type: "keyDown" };
export type KeyUpInput = KeyboardFields & { type: "keyUp" };
export interface CharInput {
  type: "char";
  text: string;
}

export type InputMessage =
  | MouseMoveInput
  | MouseDownInput
  | MouseUpInput
  | WheelInput
  | KeyDownInput
  | KeyUpInput
  | CharInput;

const BUTTON_NAME_TO_CODE: Record<ButtonName, number> = {
  none: 0,
  left: 1,
  right: 2,
  middle: 4,
};

const BUTTON_CODE_TO_NAME: Record<number, ButtonName> = {
  0: "none",
  1: "left",
  2: "right",
  4: "middle",
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode an input event to its wire-format frame. Always returns an
 * ArrayBuffer — the input is statically typed so there's no shape-mismatch
 * branch to handle. Out-of-range numeric values silently wrap via the
 * standard DataView coercion (ToUint16 / ToUint8); in practice callers
 * always supply values within the screencast pixel space (≤1920×1080).
 */
export function encodeInput(input: InputMessage): ArrayBuffer {
  switch (input.type) {
    case "mouseMove": {
      const buf = new ArrayBuffer(6);
      const dv = new DataView(buf);
      dv.setUint8(0, INPUT_OP.mouseMove);
      dv.setUint16(1, input.x, false);
      dv.setUint16(3, input.y, false);
      dv.setUint8(5, input.buttons);
      return buf;
    }
    case "mouseDown":
    case "mouseUp": {
      const buf = new ArrayBuffer(9);
      const dv = new DataView(buf);
      dv.setUint8(0, input.type === "mouseDown" ? INPUT_OP.mouseDown : INPUT_OP.mouseUp);
      dv.setUint16(1, input.x, false);
      dv.setUint16(3, input.y, false);
      dv.setUint8(5, BUTTON_NAME_TO_CODE[input.button]);
      dv.setUint8(6, input.buttons);
      dv.setUint8(7, input.clickCount);
      dv.setUint8(8, input.modifiers ?? 0);
      return buf;
    }
    case "wheel": {
      const buf = new ArrayBuffer(14);
      const dv = new DataView(buf);
      dv.setUint8(0, INPUT_OP.wheel);
      dv.setUint16(1, input.x, false);
      dv.setUint16(3, input.y, false);
      dv.setFloat32(5, input.deltaX, false);
      dv.setFloat32(9, input.deltaY, false);
      dv.setUint8(13, input.buttons);
      return buf;
    }
    case "keyDown":
    case "keyUp": {
      const keyBytes = textEncoder.encode(input.key);
      const codeBytes = textEncoder.encode(input.code);
      const buf = new ArrayBuffer(4 + keyBytes.length + codeBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, input.type === "keyDown" ? INPUT_OP.keyDown : INPUT_OP.keyUp);
      dv.setUint8(1, input.modifiers ?? 0);
      dv.setUint8(2, keyBytes.length);
      u8.set(keyBytes, 3);
      dv.setUint8(3 + keyBytes.length, codeBytes.length);
      u8.set(codeBytes, 4 + keyBytes.length);
      return buf;
    }
    case "char": {
      const textBytes = textEncoder.encode(input.text);
      const buf = new ArrayBuffer(2 + textBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, INPUT_OP.char);
      dv.setUint8(1, textBytes.length);
      u8.set(textBytes, 2);
      return buf;
    }
    default: {
      // Exhaustiveness check — tsc errors here if a new variant is added
      // to `InputMessage` without a corresponding encoder branch.
      const _exhaustive: never = input;
      throw new Error(`encodeInput: unknown type ${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Decode a wire frame back to its message. Returns `null` on malformed input
 * (unknown op, truncated buffer, etc.) — the server-side decoder uses the
 * same byte layout but its own implementation; this lives mainly for the
 * round-trip unit test that locks the wire contract.
 */
export function decodeInput(buf: ArrayBuffer | Uint8Array): InputMessage | null {
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
