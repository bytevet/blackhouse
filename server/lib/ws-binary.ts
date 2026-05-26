import type { RawData } from "ws";

/**
 * Normalize any WS-shaped binary payload to a Node Buffer.
 *
 * Handles the union of the `ws` package's `RawData` (`Buffer | ArrayBuffer
 * | Buffer[]`) AND the hono ws `evt.data` shape (`string | Buffer |
 * ArrayBuffer | Uint8Array`) — both proxies (`browser.ts`, `terminal.ts`)
 * have the same 4-arm discriminator open-coded. Returns null for unknown
 * shapes so callers can early-return.
 *
 * Strings are utf-8 encoded; preserve the string-vs-binary distinction
 * in the caller if you need it (e.g. WS text-frame routing).
 */
export function dataToBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * Normalize a `RawData` payload to a single ArrayBuffer suitable for
 * `WSContext.send()`. Used downstream of the upstream→client video pipe
 * where hono's `ws.send` wants an ArrayBuffer (not Buffer) to preserve
 * binary framing.
 */
export function rawDataToArrayBuffer(data: RawData): ArrayBuffer {
  const buf = dataToBuffer(data) ?? Buffer.alloc(0);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return bytes.buffer;
}
