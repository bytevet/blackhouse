// Binary wire format for the browser WS — client↔server protocol that
// supersedes the REST + SSE channels (#61). Two opcode ranges:
//
// 0x01–0x07: input events. Fire-and-forget, no reqId.
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
// 0x10+: request/response opcodes. Format `[op:u8, reqId:u32 BE, …]`.
//   Server echoes the same reqId back in its 0x82/0x83/0x84 response
//   so the client can correlate via a `Map<reqId, resolver>`.
//   0x10 control   action:u8 (1=navigate, 2=back, 3=forward,
//                  4=reload, 5=resize), urlLen:u16, url:utf8,
//                  width:u16, height:u16 (last two used by resize)
//   0x11 eval      exprLen:u32, expr:utf8
//   0x12 state     flags:u8 (bit0 = resetContextMenu)
//
// 0x80+: server→client opcodes (encoded with `encodeResponse`).
//   0x82 controlAck   reqId echo, ok:u8, payloadLen:u32, payload:utf8
//   0x83 evalResult   reqId echo, ok:u8, payloadLen:u32, payload:utf8
//   0x84 stateSnapshot reqId echo, payloadLen:u32, payload:utf8
//   (0x80 config / 0x81 video / 0x85 console / 0x86 navigate land in
//    later migration steps — screencast preamble + push channels stay
//    on their current transports until fe finishes client-side cutover.)
//
// `button` byte enum (single button, not bitmask):
//   0 = none, 1 = left, 2 = right, 4 = middle
// `buttons` is a CDP-style bitmask of currently-held buttons (same
// convention, OR'd together).
//
// All multi-byte ints big-endian. Must stay in lockstep with
// `src/lib/browser-input-codec.ts` on the client side.

export const OP = Object.freeze({
  MOUSE_MOVE: 0x01,
  MOUSE_DOWN: 0x02,
  MOUSE_UP: 0x03,
  WHEEL: 0x04,
  KEY_DOWN: 0x05,
  KEY_UP: 0x06,
  CHAR: 0x07,
  CONTROL: 0x10,
  EVAL: 0x11,
  STATE: 0x12,
  CONTROL_ACK: 0x82,
  EVAL_RESULT: 0x83,
  STATE_SNAPSHOT: 0x84,
});

const CONTROL_ACTION = ["", "navigate", "back", "forward", "reload", "resize"];

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

/**
 * Decode a request frame (opcode 0x10/0x11/0x12) into a `{ opcode, reqId,
 * body }` triple where `body` is the same shape the existing in-process
 * dispatchers accept. Returns `null` on unknown opcode or truncation.
 *
 * Differs from {@link decode} (the input-event decoder) in that request
 * frames carry a u32 `reqId` immediately after the opcode byte for
 * response correlation.
 */
export function decodeRequest(input) {
  const view = toDataView(input);
  if (!view || view.byteLength < 5) return null;
  const opcode = view.getUint8(0);
  const reqId = view.getUint32(1, false);
  try {
    switch (opcode) {
      case OP.CONTROL: {
        // [op, reqId, action:u8, urlLen:u16, url:utf8, width:u16, height:u16]
        if (view.byteLength < 5 + 1 + 2) return null;
        const actionByte = view.getUint8(5);
        const action = CONTROL_ACTION[actionByte];
        if (!action) return null;
        const urlLen = view.getUint16(6, false);
        if (view.byteLength < 8 + urlLen + 4) return null;
        const url = urlLen > 0 ? readUtf8(view, 8, urlLen) : "";
        const width = view.getUint16(8 + urlLen, false);
        const height = view.getUint16(10 + urlLen, false);
        const body = { action };
        if (action === "navigate" && url) body.url = url;
        if (action === "resize") {
          body.width = width;
          body.height = height;
        }
        return { opcode, reqId, body };
      }
      case OP.EVAL: {
        if (view.byteLength < 5 + 4) return null;
        const exprLen = view.getUint32(5, false);
        if (view.byteLength < 9 + exprLen) return null;
        const expression = readUtf8(view, 9, exprLen);
        return { opcode, reqId, body: { expression } };
      }
      case OP.STATE: {
        if (view.byteLength < 5 + 1) return null;
        const flags = view.getUint8(5);
        return { opcode, reqId, body: { resetContextMenu: (flags & 1) === 1 } };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Encode a request response (opcode 0x82/0x83/0x84). Frame layout:
 *   [op:u8, reqId:u32 BE, ok:u8, payloadLen:u32 BE, payload:utf8]
 *
 * The `stateSnapshot` opcode (0x84) elides the `ok` byte per spec — caller
 * passes `ok = true`. Callers serialize the JSON payload themselves; this
 * helper just frames bytes.
 */
export function encodeResponse(opcode, reqId, ok, jsonPayload) {
  const payloadBytes = utf8(jsonPayload);
  // stateSnapshot has no ok byte; controlAck and evalResult do.
  const hasOkByte = opcode === OP.CONTROL_ACK || opcode === OP.EVAL_RESULT;
  const headerLen = 1 + 4 + (hasOkByte ? 1 : 0) + 4;
  const buf = new ArrayBuffer(headerLen + payloadBytes.length);
  const v = new DataView(buf);
  const u = new Uint8Array(buf);
  let off = 0;
  v.setUint8(off, opcode);
  off += 1;
  v.setUint32(off, reqId, false);
  off += 4;
  if (hasOkByte) {
    v.setUint8(off, ok ? 1 : 0);
    off += 1;
  }
  v.setUint32(off, payloadBytes.length, false);
  off += 4;
  u.set(payloadBytes, off);
  return buf;
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
