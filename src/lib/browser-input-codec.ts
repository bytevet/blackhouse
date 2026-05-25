/**
 * Binary wire codec for the browser screencast WS (#60 + #61).
 *
 * Single-transport protocol: all client↔server traffic rides one binary
 * WS. Three opcode ranges share the socket:
 *
 *   0x01–0x07  Input events (client→server, no reqId, fire-and-forget).
 *   0x10–0x12  Requests    (client→server, u32 reqId).
 *   0x80–0x86  Responses + server-pushed events (reqId echoed for
 *              responses, 0 for broadcasts).
 *
 * Universal layout for 0x10+: `opcode(u8) + reqId(u32 BE) + payload`.
 * Input opcodes (0x01–0x07) inherited their pre-#61 wireframe and do NOT
 * carry a reqId. Control (0x10) is also fire-and-forget — the FE sends
 * `reqId=0` and never awaits a response; the implicit ack is the next
 * 0x80 (after resize) or 0x86 (after nav/back/forward/reload).
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
 * REQUESTS (client→server, payload follows the universal 5-byte header)
 * | Op   | Request   | Payload                                            |
 * |------|-----------|----------------------------------------------------|
 * | 0x10 | control   | action:u8, urlLen:u16, url:utf8,                  |
 * |      |           |   width:u16, height:u16                            |
 * | 0x11 | eval      | exprLen:u32, expression:utf8                      |
 * | 0x12 | state     | flags:u8 (bit0=includeUrl, bit1=includeTitle,     |
 * |      |           |   bit2=includeLoading)                             |
 *
 * RESPONSES + PUSHES (server→client)
 * | Op   | Frame          | Payload                                       |
 * |------|----------------|-----------------------------------------------|
 * | 0x80 | config         | codedWidth:u16, codedHeight:u16, codecLen:u8, |
 * |      |                |   codec:utf8   (reqId=0)                       |
 * | 0x81 | videoFrame     | type:u8 (0=key, 1=delta), pts:u64,            |
 * |      |                |   naluBytes  (reqId=0)                         |
 * | 0x83 | evalResult     | ok:u8, payloadLen:u32, json:utf8              |
 * | 0x84 | stateSnapshot  | payloadLen:u32, json:utf8 (ok inside json)    |
 * | 0x85 | consoleEvent   | kindLen:u8, kind:utf8, textLen:u32, text:utf8,|
 * |      |                |   urlLen:u16, url:utf8, line:u32, ts:f64       |
 * | 0x86 | navigateEvent  | urlLen:u16, url:utf8, ts:f64                  |
 *
 * `button` mapping: "none"→0, "left"→1, "right"→2, "middle"→4.
 * `action` byte for control: 0=back, 1=forward, 2=reload, 3=navigate,
 * 4=resize (0-indexed — must match
 * `agent/browser-service/input-codec.mjs`'s `CONTROL_ACTION` array).
 *
 * The 0x82 controlAck opcode was dropped in #61 cut2 — control is
 * fire-and-forget. Server may still emit 0x82 briefly during the
 * BE-cut2 transition; the FE silently drops it.
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

// ─── Request / response codec (0x10–0x12 + 0x83/0x84, #61) ───────────────────

export const REQUEST_OP = {
  control: 0x10,
  eval: 0x11,
  state: 0x12,
} as const;

export const RESPONSE_OP = {
  evalResult: 0x83,
  stateSnapshot: 0x84,
} as const;

export const PUSH_OP = {
  config: 0x80,
  videoFrame: 0x81,
  consoleEvent: 0x85,
  navigateEvent: 0x86,
} as const;

/**
 * Control-action byte enum. Matches `agent/browser-service/input-codec.mjs`'s
 * `CONTROL_ACTION = ["back", "forward", "reload", "navigate", "resize"]`
 * — be is the wire-format authority. Indices are 0-based.
 */
export const CONTROL_ACTION = {
  back: 0,
  forward: 1,
  reload: 2,
  navigate: 3,
  resize: 4,
} as const;

export type ControlActionName = keyof typeof CONTROL_ACTION;

const STATE_FLAG_INCLUDE_URL = 1 << 0;
const STATE_FLAG_INCLUDE_TITLE = 1 << 1;
const STATE_FLAG_INCLUDE_LOADING = 1 << 2;

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

/**
 * Bit-flags for the 0x12 state request. The 0x84 response projects only
 * the fields whose include-bit was set, so callers can ask for just what
 * they need (cheaper CDP probe on the server side).
 */
export interface StateBody {
  includeUrl?: boolean;
  includeTitle?: boolean;
  includeLoading?: boolean;
}

/**
 * Response triple decoded from a request/response frame. 0x83 carries an
 * `ok` byte before the payload; 0x84 omits it (the JSON payload carries
 * its own `ok` field) so this union exposes `ok` as per-variant.
 */
export type WsResponse =
  | { opcode: typeof RESPONSE_OP.evalResult; reqId: number; ok: boolean; payload: unknown }
  | { opcode: typeof RESPONSE_OP.stateSnapshot; reqId: number; payload: unknown };

/** Decoded screencast config (opcode 0x80). */
export interface ConfigPush {
  codedWidth: number;
  codedHeight: number;
  codec: string;
}

/** Decoded video-frame header + raw Annex-B payload (opcode 0x81). */
export interface VideoFramePush {
  isKey: boolean;
  pts: bigint;
  /**
   * Annex-B-encoded NALU bytes. View into the original ArrayBuffer — do
   * NOT mutate; copy into an `EncodedVideoChunk` as `data`.
   */
  nalu: Uint8Array;
}

/** Decoded console-event push (opcode 0x85). */
export interface ConsoleEventPush {
  kind: string;
  text: string;
  url: string;
  line: number;
  ts: number;
}

/** Decoded navigate-event push (opcode 0x86). */
export interface NavigateEventPush {
  url: string;
  ts: number;
}

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
      let flags = 0;
      if (b.includeUrl) flags |= STATE_FLAG_INCLUDE_URL;
      if (b.includeTitle) flags |= STATE_FLAG_INCLUDE_TITLE;
      if (b.includeLoading) flags |= STATE_FLAG_INCLUDE_LOADING;
      const buf = new ArrayBuffer(6);
      const dv = new DataView(buf);
      dv.setUint8(0, REQUEST_OP.state);
      dv.setUint32(1, reqId, false);
      dv.setUint8(5, flags);
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
      case RESPONSE_OP.evalResult: {
        // header = op(1) + reqId(4) + ok(1) + payloadLen(4) = 10 bytes
        if (view.length < 10) return null;
        const ok = dv.getUint8(5) === 1;
        const payloadLen = dv.getUint32(6, false);
        if (view.length < 10 + payloadLen) return null;
        const payload = parseJsonPayload(view.subarray(10, 10 + payloadLen));
        if (payload === SENTINEL_BAD_JSON) return null;
        return { opcode: RESPONSE_OP.evalResult, reqId, ok, payload };
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

// ─── Server-pushed frame decoders (0x80/0x81/0x85/0x86, #61) ─────────────────

/**
 * Decode an opcode-0x80 `config` frame, sent once at WS open and after
 * every viewport resize. The FE re-creates its VideoDecoder with these
 * params. Returns `null` on truncation or unknown layout.
 */
export function decodeConfig(buf: ArrayBuffer | Uint8Array): ConfigPush | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 10) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint8(0) !== PUSH_OP.config) return null;
  try {
    const codedWidth = dv.getUint16(5, false);
    const codedHeight = dv.getUint16(7, false);
    const codecLen = dv.getUint8(9);
    if (view.length < 10 + codecLen) return null;
    const codec = textDecoder.decode(view.subarray(10, 10 + codecLen));
    return { codedWidth, codedHeight, codec };
  } catch {
    return null;
  }
}

/**
 * Decode an opcode-0x81 video-frame header. The 14-byte header carries
 * type/pts; the rest of the buffer is the Annex-B NALU payload that the
 * caller hands to `VideoDecoder.decode(...)`. Returns `null` on truncation.
 */
export function decodeVideoFrame(buf: ArrayBuffer | Uint8Array): VideoFramePush | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 14) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint8(0) !== PUSH_OP.videoFrame) return null;
  try {
    const typeByte = dv.getUint8(5);
    const pts = dv.getBigUint64(6, false);
    const nalu = view.subarray(14);
    return { isKey: typeByte === 0, pts, nalu };
  } catch {
    return null;
  }
}

/**
 * Decode an opcode-0x85 console-event push. Coerces missing tail fields
 * to safe defaults so a malformed trailer never crashes the consumer —
 * console-event push must never break the screencast.
 */
export function decodeConsoleEvent(buf: ArrayBuffer | Uint8Array): ConsoleEventPush | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 6) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint8(0) !== PUSH_OP.consoleEvent) return null;
  try {
    let off = 5;
    const kindLen = dv.getUint8(off);
    off += 1;
    if (view.length < off + kindLen + 4) return null;
    const kind = textDecoder.decode(view.subarray(off, off + kindLen));
    off += kindLen;
    const textLen = dv.getUint32(off, false);
    off += 4;
    if (view.length < off + textLen + 2) return null;
    const text = textDecoder.decode(view.subarray(off, off + textLen));
    off += textLen;
    const urlLen = dv.getUint16(off, false);
    off += 2;
    if (view.length < off + urlLen + 4 + 8) return null;
    const url = textDecoder.decode(view.subarray(off, off + urlLen));
    off += urlLen;
    const line = dv.getUint32(off, false);
    off += 4;
    const ts = dv.getFloat64(off, false);
    return { kind, text, url, line, ts };
  } catch {
    return null;
  }
}

/** Decode an opcode-0x86 navigate-event push. */
export function decodeNavigateEvent(buf: ArrayBuffer | Uint8Array): NavigateEventPush | null {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (view.length < 15) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint8(0) !== PUSH_OP.navigateEvent) return null;
  try {
    const urlLen = dv.getUint16(5, false);
    if (view.length < 7 + urlLen + 8) return null;
    const url = textDecoder.decode(view.subarray(7, 7 + urlLen));
    const ts = dv.getFloat64(7 + urlLen, false);
    return { url, ts };
  } catch {
    return null;
  }
}
