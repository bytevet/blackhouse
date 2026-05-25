import type { RawData } from "ws";

/**
 * Normalize the `ws` package's `RawData` union (Buffer | ArrayBuffer | Buffer[])
 * into a single ArrayBuffer suitable for `WSContext.send()`. Used by every
 * WS proxy in the project; lifting the dance here keeps the proxies focused
 * on their actual routing logic.
 */
export function rawDataToArrayBuffer(data: RawData): ArrayBuffer {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return bytes.buffer;
}
