// Binary wire format for the browser WS — sole client↔server protocol
// after #61. Replaces the legacy REST + SSE channels and the TEXT
// `config` preamble. All frames are binary; text frames are dropped.
//
// Universal layout: `opcode(u8) + reqId(u32 BE) + payload`. `reqId == 0`
// for fire-and-forget / broadcast frames; non-zero for request/response
// pairs (server echoes the reqId back so the client can correlate via a
// `Map<reqId, resolver>`).
//
// ── Input events (client→server, reqId=0) ───────────────────────────────
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
// NOTE: input opcodes (0x01–0x07) inherited their pre-#61 wireframe and
// do NOT carry a reqId byte (they're fire-and-forget). The universal
// layout above describes the 0x10+ request opcodes and the 0x80+
// server-pushed/response opcodes.
//
// ── Requests (client→server) ────────────────────────────────────────────
//   0x10 control   FIRE-AND-FORGET (reqId ignored — caller sends 0).
//                  action:u8 (0=back, 1=forward, 2=reload, 3=navigate,
//                  4=resize), urlLen:u16, url:utf8,
//                  width:u16, height:u16 (last two used by resize)
//                  Implicit acks: resize → next 0x80; nav-class → next 0x86.
//   0x11 eval      reqId != 0. exprLen:u32, expr:utf8
//   0x12 state     reqId != 0. flags:u8
//                    bit0 = includeUrl
//                    bit1 = includeTitle
//                    bit2 = includeLoading
//                    bit3 = includeSelection   (selectionText)
//                    bit4 = includeScroll      (scrollX, scrollY,
//                                               viewport, docSize)
//                    bit5 = includeContextMenu (lastContextMenu;
//                                               reads-and-clears the
//                                               server-side slot — same
//                                               semantics as the legacy
//                                               REST `?resetContextMenu=1`)
//
// ── Responses + pushes (server→client) ──────────────────────────────────
//   0x80 config        (reqId=0) codedWidth:u16, codedHeight:u16,
//                                codecLen:u8, codec:utf8
//   0x81 videoFrame    (reqId=0) type:u8 (0=key, 1=delta), pts:u64 BE,
//                                naluBytes (Annex-B H.264)
//   0x83 evalResult    (reqId echo) ok:u8, payloadLen:u32, payload:utf8
//   0x84 stateSnapshot (reqId echo) payloadLen:u32, payload:utf8
//                                   (JSON; `ok` lives inside the JSON)
//   0x85 consoleEvent  (reqId=0) kindLen:u8, kind:utf8, textLen:u32,
//                                text:utf8, urlLen:u16, url:utf8,
//                                line:u32, ts:f64
//   0x86 navigateEvent (reqId=0) urlLen:u16, url:utf8, ts:f64
//
// `button` byte enum (single button, not bitmask):
//   0 = none, 1 = left, 2 = right, 4 = middle
// `buttons` is a CDP-style bitmask of currently-held buttons (same
// convention, OR'd together).
//
// All multi-byte ints big-endian. Must stay in lockstep with the TS
// client codec at `src/lib/browser-input-codec.ts`.

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
  CONFIG: 0x80,
  VIDEO_FRAME: 0x81,
  EVAL_RESULT: 0x83,
  STATE_SNAPSHOT: 0x84,
  CONSOLE_EVENT: 0x85,
  NAVIGATE_EVENT: 0x86,
});

// Indexed by the wire `action` byte. Keep in lockstep with the FE codec.
const CONTROL_ACTION = ["back", "forward", "reload", "navigate", "resize"];

// State flag bits — keep in lockstep with the FE codec.
const STATE_FLAG_INCLUDE_URL = 1 << 0;
const STATE_FLAG_INCLUDE_TITLE = 1 << 1;
const STATE_FLAG_INCLUDE_LOADING = 1 << 2;
const STATE_FLAG_INCLUDE_SELECTION = 1 << 3;
const STATE_FLAG_INCLUDE_SCROLL = 1 << 4;
const STATE_FLAG_INCLUDE_CONTEXT_MENU = 1 << 5;

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
        return {
          opcode,
          reqId,
          body: {
            includeUrl: (flags & STATE_FLAG_INCLUDE_URL) !== 0,
            includeTitle: (flags & STATE_FLAG_INCLUDE_TITLE) !== 0,
            includeLoading: (flags & STATE_FLAG_INCLUDE_LOADING) !== 0,
            includeSelection: (flags & STATE_FLAG_INCLUDE_SELECTION) !== 0,
            includeScroll: (flags & STATE_FLAG_INCLUDE_SCROLL) !== 0,
            includeContextMenu: (flags & STATE_FLAG_INCLUDE_CONTEXT_MENU) !== 0,
          },
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Encode a request response (opcode 0x83 evalResult / 0x84 stateSnapshot).
 * Frame layout:
 *   [op:u8, reqId:u32 BE, ok:u8?, payloadLen:u32 BE, payload:utf8]
 *
 * stateSnapshot (0x84) elides the `ok` byte per spec — caller passes
 * `ok = true` and the JSON itself carries an `ok` field. evalResult (0x83)
 * keeps the ok byte. Callers serialize the JSON payload themselves; this
 * helper just frames bytes.
 *
 * (Control was previously 0x82 controlAck but is now fire-and-forget —
 * `resize` is implicitly acked by the next 0x80 config frame and nav-class
 * actions by the next 0x86 navigateEvent.)
 */
export function encodeResponse(opcode, reqId, ok, jsonPayload) {
  const payloadBytes = utf8(jsonPayload);
  const hasOkByte = opcode === OP.EVAL_RESULT;
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

/**
 * Encode the screencast `config` preamble (opcode 0x80). Sent once at WS
 * open and again after every viewport resize so the client's
 * `VideoDecoder.configure(...)` can re-create itself.
 *   [op=0x80, reqId=0, codedWidth:u16, codedHeight:u16, codecLen:u8, codec:utf8]
 */
export function encodeConfig(codedWidth, codedHeight, codecStr) {
  const codecBytes = utf8(codecStr || "");
  if (codecBytes.length > 255) {
    throw new Error(`codec string too long: ${codecBytes.length} > 255 bytes`);
  }
  const buf = new ArrayBuffer(1 + 4 + 2 + 2 + 1 + codecBytes.length);
  const v = new DataView(buf);
  const u = new Uint8Array(buf);
  v.setUint8(0, OP.CONFIG);
  v.setUint32(1, 0, false); // reqId
  v.setUint16(5, clampU16(codedWidth), false);
  v.setUint16(7, clampU16(codedHeight), false);
  v.setUint8(9, codecBytes.length);
  u.set(codecBytes, 10);
  return buf;
}

/**
 * Encode the 14-byte video frame *header* (opcode 0x81). The caller
 * concatenates this with the raw Annex-B AU bytes. Header layout:
 *   [op=0x81, reqId=0, type:u8 (0=key, 1=delta), pts:u64 BE]
 *
 * Returns a Uint8Array so it can be Buffer.concat'd straight away in
 * the encoder hot path without an extra copy. (BigUint64BE via DataView
 * accepts the `pts` BigInt directly.)
 */
export function encodeVideoFrameHeader(isKey, pts) {
  const buf = new ArrayBuffer(14);
  const v = new DataView(buf);
  v.setUint8(0, OP.VIDEO_FRAME);
  v.setUint32(1, 0, false); // reqId
  v.setUint8(5, isKey ? 0 : 1);
  v.setBigUint64(6, BigInt(pts), false);
  return new Uint8Array(buf);
}

/**
 * Encode a console event (opcode 0x85) for broadcast to every WS peer.
 *   [op=0x85, reqId=0, kindLen:u8, kind:utf8, textLen:u32, text:utf8,
 *    urlLen:u16, url:utf8, line:u32, ts:f64]
 *
 * Coerces missing/oversized fields rather than throwing — console event
 * push must never break the screencast.
 */
export function encodeConsoleEvent(evt) {
  const kindBytes = utf8(truncate(evt?.kind ?? "log", 255));
  const textBytes = utf8(String(evt?.text ?? ""));
  const urlBytes = utf8(truncate(evt?.url ?? "", 0xffff));
  const line = clampU32(evt?.line ?? 0);
  const ts = Number(evt?.ts ?? Date.now());
  const buf = new ArrayBuffer(
    1 + 4 + 1 + kindBytes.length + 4 + textBytes.length + 2 + urlBytes.length + 4 + 8,
  );
  const v = new DataView(buf);
  const u = new Uint8Array(buf);
  let off = 0;
  v.setUint8(off, OP.CONSOLE_EVENT);
  off += 1;
  v.setUint32(off, 0, false);
  off += 4; // reqId
  v.setUint8(off, kindBytes.length);
  off += 1;
  u.set(kindBytes, off);
  off += kindBytes.length;
  v.setUint32(off, textBytes.length, false);
  off += 4;
  u.set(textBytes, off);
  off += textBytes.length;
  v.setUint16(off, urlBytes.length, false);
  off += 2;
  u.set(urlBytes, off);
  off += urlBytes.length;
  v.setUint32(off, line, false);
  off += 4;
  v.setFloat64(off, ts, false);
  return buf;
}

/**
 * Encode a navigate event (opcode 0x86) for broadcast.
 *   [op=0x86, reqId=0, urlLen:u16, url:utf8, ts:f64]
 */
export function encodeNavigateEvent(evt) {
  const urlBytes = utf8(truncate(evt?.url ?? "", 0xffff));
  const ts = Number(evt?.ts ?? Date.now());
  const buf = new ArrayBuffer(1 + 4 + 2 + urlBytes.length + 8);
  const v = new DataView(buf);
  const u = new Uint8Array(buf);
  v.setUint8(0, OP.NAVIGATE_EVENT);
  v.setUint32(1, 0, false);
  v.setUint16(5, urlBytes.length, false);
  u.set(urlBytes, 7);
  v.setFloat64(7 + urlBytes.length, ts, false);
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
function clampU32(n) {
  const v = Math.max(0, Math.min(0xffffffff, Math.round(Number(n) || 0)));
  return v;
}
function truncate(str, maxBytes) {
  if (!str) return "";
  // Trim at codepoint boundary by re-encoding/decoding once we exceed
  // the byte budget. Cheap on the happy path (length check short-circuits).
  if (TEXT_ENC.encode(str).length <= maxBytes) return str;
  const bytes = TEXT_ENC.encode(str).subarray(0, maxBytes);
  return TEXT_DEC.decode(bytes, { stream: false }).replace(/�$/u, "");
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
