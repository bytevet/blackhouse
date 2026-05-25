/**
 * Binary wire codec for the browser screencast WS (#60 + #61).
 *
 * Two opcode ranges share the same socket:
 *
 *   0x01–0x07: input events. Fire-and-forget, no reqId. Encoded by
 *              `encodeInput` / decoded by `decodeInput`.
 *
 *   0x10–0x12 (client→server) + 0x82–0x84 (server→client): request /
 *              response pairs with a 4-byte big-endian `reqId` for
 *              correlation. Encoded by `encodeRequest` / decoded by
 *              `decodeResponse`.
 *
 * Wire layouts (all multi-byte numbers BIG-ENDIAN):
 *
 * INPUT EVENTS
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
 * `button` mapping: "none"→0, "left"→1, "right"→2, "middle"→4. The input
 * shape is a discriminated union (`InputMessage`) so the encoder's switch
 * is statically exhaustive.
 *
 * REQUEST / RESPONSE
 * | Op   | Direction       | Layout                                       |
 * |------|-----------------|----------------------------------------------|
 * | 0x10 | client→ control | reqId:u32, action:u8, urlLen:u16, url:utf8,  |
 * |      |                 |   width:u16, height:u16                      |
 * | 0x11 | client→ eval    | reqId:u32, exprLen:u32, expression:utf8      |
 * | 0x12 | client→ state   | reqId:u32, flags:u8  (bit0 = resetContextMenu) |
 * | 0x82 | server→ ctrlAck | reqId:u32, ok:u8, payloadLen:u32, json:utf8  |
 * | 0x83 | server→ evalRes | reqId:u32, ok:u8, payloadLen:u32, json:utf8  |
 * | 0x84 | server→ stateSn | reqId:u32, payloadLen:u32, json:utf8         |
 *
 * `action` byte for control: 1=navigate, 2=back, 3=forward, 4=reload,
 * 5=resize. The server-side authority (`agent/browser-service/input-codec.mjs`)
 * is the contract; this file mirrors it. Note 0x84 has NO `ok` byte — its
 * "ok" lives inside the JSON payload.
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

// ─── Request / response codec (0x10–0x12 + 0x82–0x84, #61) ───────────────────

export const REQUEST_OP = {
  control: 0x10,
  eval: 0x11,
  state: 0x12,
} as const;

export const RESPONSE_OP = {
  controlAck: 0x82,
  evalResult: 0x83,
  stateSnapshot: 0x84,
} as const;

/**
 * Control-action byte enum, matching `agent/browser-service/input-codec.mjs`
 * (`CONTROL_ACTION = ["", "navigate", "back", "forward", "reload", "resize"]`).
 * 0 is reserved (decodes as "unknown action" on the server).
 */
export const CONTROL_ACTION = {
  navigate: 1,
  back: 2,
  forward: 3,
  reload: 4,
  resize: 5,
} as const;

export type ControlActionName = keyof typeof CONTROL_ACTION;

export interface ControlBody {
  action: ControlActionName;
  /** Required for `action: "navigate"`, ignored otherwise (encoded as empty). */
  url?: string;
  /** Required for `action: "resize"`, ignored otherwise (encoded as 0). */
  width?: number;
  /** Required for `action: "resize"`, ignored otherwise (encoded as 0). */
  height?: number;
}

export interface EvalBody {
  expression: string;
}

export interface StateBody {
  resetContextMenu: boolean;
}

/**
 * Response triple decoded from a server frame. 0x82/0x83 carry an `ok`
 * byte before the payload; 0x84 omits it (the JSON payload carries its
 * own `ok` field) so this union exposes `ok` as optional/per-variant.
 */
export type WsResponse =
  | { opcode: typeof RESPONSE_OP.controlAck; reqId: number; ok: boolean; payload: unknown }
  | { opcode: typeof RESPONSE_OP.evalResult; reqId: number; ok: boolean; payload: unknown }
  | { opcode: typeof RESPONSE_OP.stateSnapshot; reqId: number; payload: unknown };

/**
 * Encode a request frame for opcodes 0x10/0x11/0x12. The three overloads
 * pin the body shape per opcode so a caller passing the wrong body for a
 * given opcode is a tsc error, not a runtime malformed frame.
 *
 * `reqId` is a u32 — caller is responsible for allocating it and tracking
 * the pending request map (`browser-ws-rpc.ts`).
 */
export function encodeRequest(
  opcode: typeof REQUEST_OP.control,
  reqId: number,
  body: ControlBody,
): ArrayBuffer;
export function encodeRequest(
  opcode: typeof REQUEST_OP.eval,
  reqId: number,
  body: EvalBody,
): ArrayBuffer;
export function encodeRequest(
  opcode: typeof REQUEST_OP.state,
  reqId: number,
  body: StateBody,
): ArrayBuffer;
export function encodeRequest(
  opcode: (typeof REQUEST_OP)[keyof typeof REQUEST_OP],
  reqId: number,
  body: ControlBody | EvalBody | StateBody,
): ArrayBuffer {
  switch (opcode) {
    case REQUEST_OP.control: {
      const b = body as ControlBody;
      const urlBytes = textEncoder.encode(b.url ?? "");
      const buf = new ArrayBuffer(12 + urlBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, REQUEST_OP.control);
      dv.setUint32(1, reqId, false);
      dv.setUint8(5, CONTROL_ACTION[b.action]);
      dv.setUint16(6, urlBytes.length, false);
      u8.set(urlBytes, 8);
      dv.setUint16(8 + urlBytes.length, b.width ?? 0, false);
      dv.setUint16(10 + urlBytes.length, b.height ?? 0, false);
      return buf;
    }
    case REQUEST_OP.eval: {
      const b = body as EvalBody;
      const exprBytes = textEncoder.encode(b.expression);
      const buf = new ArrayBuffer(9 + exprBytes.length);
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      dv.setUint8(0, REQUEST_OP.eval);
      dv.setUint32(1, reqId, false);
      dv.setUint32(5, exprBytes.length, false);
      u8.set(exprBytes, 9);
      return buf;
    }
    case REQUEST_OP.state: {
      const b = body as StateBody;
      const buf = new ArrayBuffer(6);
      const dv = new DataView(buf);
      dv.setUint8(0, REQUEST_OP.state);
      dv.setUint32(1, reqId, false);
      dv.setUint8(5, b.resetContextMenu ? 0b00000001 : 0);
      return buf;
    }
    default: {
      const _exhaustive: never = opcode;
      throw new Error(`encodeRequest: unknown opcode 0x${(_exhaustive as number).toString(16)}`);
    }
  }
}

/**
 * Decode a server response frame (0x82/0x83/0x84) into `{ opcode, reqId,
 * ok?, payload }`. Returns `null` on unknown opcode, truncated buffer, or
 * malformed JSON payload — caller treats null as a silent drop.
 *
 * `payload` is `JSON.parse`d for caller convenience; consumers narrow it
 * via the response-payload type they expect from be's `run*` dispatcher.
 */
export function decodeResponse(buf: ArrayBuffer | Uint8Array): WsResponse | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 5) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const opcode = dv.getUint8(0);
  const reqId = dv.getUint32(1, false);

  try {
    switch (opcode) {
      case RESPONSE_OP.controlAck:
      case RESPONSE_OP.evalResult: {
        // header = op(1) + reqId(4) + ok(1) + payloadLen(4) = 10 bytes
        if (view.length < 10) return null;
        const ok = dv.getUint8(5) === 1;
        const payloadLen = dv.getUint32(6, false);
        if (view.length < 10 + payloadLen) return null;
        const payload = parseJsonPayload(view.subarray(10, 10 + payloadLen));
        if (payload === SENTINEL_BAD_JSON) return null;
        return opcode === RESPONSE_OP.controlAck
          ? { opcode: RESPONSE_OP.controlAck, reqId, ok, payload }
          : { opcode: RESPONSE_OP.evalResult, reqId, ok, payload };
      }
      case RESPONSE_OP.stateSnapshot: {
        // header = op(1) + reqId(4) + payloadLen(4) = 9 bytes  (no ok byte)
        if (view.length < 9) return null;
        const payloadLen = dv.getUint32(5, false);
        if (view.length < 9 + payloadLen) return null;
        const payload = parseJsonPayload(view.subarray(9, 9 + payloadLen));
        if (payload === SENTINEL_BAD_JSON) return null;
        return { opcode: RESPONSE_OP.stateSnapshot, reqId, payload };
      }
      default:
        return null;
    }
  } catch {
    // Out-of-bounds / alignment — treat as malformed.
    return null;
  }
}

// Sentinel for `parseJsonPayload` failure so callers can distinguish a
// legitimate `null` payload from a parse error.
const SENTINEL_BAD_JSON = Symbol("bad-json");
function parseJsonPayload(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    return SENTINEL_BAD_JSON;
  }
}
