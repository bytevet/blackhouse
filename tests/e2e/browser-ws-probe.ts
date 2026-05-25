/**
 * Browser-pane WS probe (#61).
 *
 * Replaces the legacy REST + SSE probes (`POST /browser/control`,
 * `POST /browser/eval`, `GET /browser/state`, `EventSource(/browser/console)`)
 * with the single binary-opcode protocol the FE now speaks against
 * `/api/browser-ws/:sessionId`. Reuses the FE's TS codec
 * (`src/lib/browser-input-codec.ts`) — be is the wire-format authority and
 * the FE codec mirrors it; the unit-test layer already pins both ends to the
 * same byte vectors.
 *
 * Surface:
 *   - `request(opcode, body)` — request/response for 0x11 eval / 0x12 state,
 *     resolves with the decoded JSON payload (typed via `T` at call site).
 *   - `send(opcode, body)` — fire-and-forget for 0x10 control (resize / nav).
 *     The implicit ack is the next 0x80 (resize) or 0x86 (nav-class) which
 *     can be observed via `on(...)`.
 *   - `on(opcode, handler)` — subscribe to server-push frames (0x80 config,
 *     0x81 video, 0x85 console, 0x86 navigate). Returns an unsubscribe fn.
 *   - `close()` — reject pending requests + close the socket.
 *
 * KNOWN PROJECTION GAP (BE-cut2 follow-up): the 0x84 stateSnapshot payload
 * only carries `{ok, url?, title?, loading?}`. Probes that need
 * `selectionText` / `scrollX|Y` / `docSize` / `lastContextMenu` (the strict
 * browser-interactivity suite) MUST keep the REST `/browser/state` call
 * until the projection grows. The lone REST hold-out is intentional — see
 * call-site comments in `session.spec.ts`.
 */

import { WebSocket as NodeWebSocket } from "ws";
import type { Page } from "@playwright/test";
import {
  REQUEST_OP,
  RESPONSE_OP,
  PUSH_OP,
  encodeRequest,
  decodeResponse,
  type ControlBody,
  type EvalBody,
  type StateBody,
} from "../../src/lib/browser-input-codec";
import { getBaseUrl } from "./helpers";

type PushOpcode = (typeof PUSH_OP)[keyof typeof PUSH_OP];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  expectedOpcode: (typeof RESPONSE_OP)[keyof typeof RESPONSE_OP];
}

export interface BrowserWsProbe {
  /**
   * Send a request frame and resolve with the decoded JSON payload. Caller
   * supplies the payload shape via `T`; the wire codec opaquely returns
   * `unknown` so the test author owns the narrowing.
   */
  request<T>(opcode: typeof REQUEST_OP.eval, body: EvalBody, timeoutMs?: number): Promise<T>;
  request<T>(opcode: typeof REQUEST_OP.state, body: StateBody, timeoutMs?: number): Promise<T>;

  /**
   * Fire-and-forget — used for 0x10 control. The implicit ack is the next
   * push frame on the corresponding channel (0x80 for resize, 0x86 for
   * nav-class). Observe those via `on(...)` if you need to wait.
   */
  send(opcode: typeof REQUEST_OP.control, body: ControlBody): void;

  /**
   * Subscribe to a server-pushed opcode. Handler receives the RAW frame
   * bytes — caller decodes via the matching `decodeConfig` / `decodeVideoFrame`
   * / `decodeConsoleEvent` / `decodeNavigateEvent` helper from
   * `browser-input-codec`. Raw because most probes only need *presence*,
   * not the parsed fields; the few that need fields decode locally.
   *
   * Returns an unsubscribe fn that the caller can defer.
   */
  on(opcode: PushOpcode, handler: (buf: Uint8Array) => void): () => void;

  /** Reject all pending requests and close the socket. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Open a WS to `/api/browser-ws/:sessionId`, authenticated via the
 * `better-auth.session_token` cookie carried by Playwright's context. Mirrors
 * the FE's connection logic in `src/components/browser-viewer.tsx`: token is
 * pulled from the cookie jar and passed as a `?token=...` query param (the
 * server's `validateSessionForContainer` only inspects that param — cookies
 * on the WS upgrade are ignored).
 *
 * Resolves after the WS reaches OPEN. Rejects if open fails or times out
 * (5s). Caller should `await openBrowserWs(...)` at the start of the test
 * and call `probe.close()` at the end (or in a `finally`).
 */
export async function openBrowserWs(
  page: Page,
  sessionId: string,
  opts: { openTimeoutMs?: number } = {},
): Promise<BrowserWsProbe> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "better-auth.session_token");
  // Better Auth's signed cookie is `<token>.<signature>` URL-encoded on the
  // wire — Playwright returns it URL-decoded. REST routes need the whole
  // signed value (BA verifies the signature each request); the WS auth path
  // (`validateSessionForContainer`) does `eq(session.token, token)` against
  // the DB's raw token column, which is the pre-`.` half. Mirror the split
  // documented in `scripts/smoke-browser-ws.ts`. No-token connects work for
  // owned `running` sessions (server gates by status alone when token is
  // absent) but never cross-user.
  const wsToken = session ? session.value.split(".")[0] : "";
  const tokenParam = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";

  const wsUrl = getBaseUrl().replace(/^http/i, "ws") + `/api/browser-ws/${sessionId}${tokenParam}`;

  const ws = new NodeWebSocket(wsUrl, { perMessageDeflate: false });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`openBrowserWs: WS open timed out (${wsUrl})`)),
      opts.openTimeoutMs ?? 5_000,
    );
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  // ── pending request map + push listener registry ─────────────────────────
  const pending = new Map<number, Pending>();
  const listeners = new Map<PushOpcode, Set<(buf: Uint8Array) => void>>();
  let nextReqId = 1;
  let disposed = false;

  function allocReqId(): number {
    const id = nextReqId;
    nextReqId = nextReqId === 0xffffffff ? 1 : nextReqId + 1;
    return id;
  }

  function rejectPending(reqId: number, err: Error): void {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    p.reject(err);
  }

  function resolvePending(reqId: number, value: unknown): void {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) return; // server-side text frames are diagnostic strings; ignore.
    // `Buffer` is a Uint8Array — pass through without copy.
    const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (view.byteLength < 1) return;
    const opcode = view[0];

    // 0x83 / 0x84 — request/response. Correlate by reqId.
    if (opcode === RESPONSE_OP.evalResult || opcode === RESPONSE_OP.stateSnapshot) {
      const decoded = decodeResponse(view);
      if (!decoded) return;
      const p = pending.get(decoded.reqId);
      if (!p) return; // late / unknown — silently drop
      if (decoded.opcode !== p.expectedOpcode) {
        rejectPending(
          decoded.reqId,
          new Error(
            `ws_rpc_opcode_mismatch expected=0x${p.expectedOpcode.toString(16)} ` +
              `got=0x${decoded.opcode.toString(16)}`,
          ),
        );
        return;
      }
      resolvePending(decoded.reqId, decoded.payload);
      return;
    }

    // Push opcodes (0x80/0x81/0x85/0x86) — fan out to subscribers verbatim.
    const subs = listeners.get(opcode as PushOpcode);
    if (subs) for (const fn of subs) fn(view);
  });

  ws.on("close", () => {
    if (disposed) return;
    disposed = true;
    for (const [reqId] of pending) rejectPending(reqId, new Error("ws_closed"));
    pending.clear();
    listeners.clear();
  });

  function request<T>(
    opcode: typeof REQUEST_OP.eval | typeof REQUEST_OP.state,
    body: EvalBody | StateBody,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (disposed) return Promise.reject(new Error("ws_probe_disposed"));
    if (ws.readyState !== NodeWebSocket.OPEN) {
      return Promise.reject(new Error(`ws_not_open (readyState=${ws.readyState})`));
    }
    const reqId = allocReqId();
    const expectedOpcode =
      opcode === REQUEST_OP.eval ? RESPONSE_OP.evalResult : RESPONSE_OP.stateSnapshot;

    return new Promise<T>((resolveCb, rejectCb) => {
      const timer = setTimeout(() => {
        rejectPending(reqId, new Error(`ws_rpc_timeout opcode=0x${opcode.toString(16)}`));
      }, timeoutMs);
      pending.set(reqId, {
        resolve: resolveCb as (value: unknown) => void,
        reject: rejectCb,
        timer,
        expectedOpcode,
      });
      const frame =
        opcode === REQUEST_OP.eval
          ? encodeRequest(opcode, reqId, body as EvalBody)
          : encodeRequest(opcode, reqId, body as StateBody);
      ws.send(Buffer.from(frame));
    });
  }

  function send(opcode: typeof REQUEST_OP.control, body: ControlBody): void {
    if (disposed) throw new Error("ws_probe_disposed");
    if (ws.readyState !== NodeWebSocket.OPEN) {
      throw new Error(`ws_not_open (readyState=${ws.readyState})`);
    }
    // Control is fire-and-forget — reqId=0.
    ws.send(Buffer.from(encodeRequest(opcode, 0, body)));
  }

  function on(opcode: PushOpcode, handler: (buf: Uint8Array) => void): () => void {
    let set = listeners.get(opcode);
    if (!set) {
      set = new Set();
      listeners.set(opcode, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) listeners.delete(opcode);
    };
  }

  function close(): void {
    if (disposed) return;
    disposed = true;
    for (const [reqId] of pending) rejectPending(reqId, new Error("ws_probe_closed"));
    pending.clear();
    listeners.clear();
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  return { request, send, on, close } as BrowserWsProbe;
}

/**
 * Convenience: open a probe, run `expression` via 0x11 eval, return the
 * `{ok, result?}` payload, close the probe. Use this for one-shot eval
 * probes; for tests that fire multiple evals in a row, open one probe and
 * reuse it via `request(REQUEST_OP.eval, ...)`.
 */
export async function evalOnce(
  page: Page,
  sessionId: string,
  expression: string,
): Promise<{ ok: boolean; result?: string; error?: { description?: string } }> {
  const probe = await openBrowserWs(page, sessionId);
  try {
    return await probe.request(REQUEST_OP.eval, { expression });
  } finally {
    probe.close();
  }
}
