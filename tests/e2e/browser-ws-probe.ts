/**
 * Browser-pane WS probe.
 *
 * Speaks the binary-opcode protocol the browser viewer uses against
 * `/api/browser-ws/:agentId`, reusing the FE's own codec
 * (`src/lib/browser-input-codec.ts`) — the server is the wire-format
 * authority and the FE codec mirrors it, with the unit layer pinning both
 * ends to the same byte vectors.
 *
 * Surface:
 *   - `request(opcode, body)` — request/response for 0x11 eval / 0x12 state,
 *     resolves with the decoded JSON payload (typed via `T` at call site).
 *   - `send(opcode, body)` — fire-and-forget for 0x10 control (resize / nav).
 *     The implicit ack is the next 0x80 (resize) or 0x86 (nav-class) push,
 *     which the FE's BrowserViewer observes on its own WS.
 *   - `close()` — reject pending requests + close the socket.
 *
 * NOTHING IN THE SUITE CALLS THIS YET. The browser pane needs a running
 * agent container with the browser service inside it, which means a
 * multi-GB image and provider credentials; those specs are on hold until
 * the `mock` blueprint from `tests/fixtures/` can stand one up. The file is
 * kept because the wire format is the expensive part to re-derive.
 *
 * AGENT-IMAGE STALENESS HAZARD (read before debugging a black canvas):
 * `agent/browser-service/service.mjs` ships INSIDE the per-blueprint Docker
 * image, baked at build time. Pulling new code does NOT update existing
 * containers — only a `POST /api/settings/blueprints/:id/build` rebuild
 * does. Symptoms of a stale agent image:
 *   - SPA console logs `[browser-viewer] unknown WS opcode 0x1` and the
 *     canvas stays black (in-container encoder emits the older bare
 *     `[type, pts, nalu]` video frame, with no 0x81 prefix).
 *   - `selectionText` / `scrollY` / `lastContextMenu` come back undefined
 *     even when the page clearly has that state (an older image masks the
 *     include-bits to 0).
 * Repro path: start an agent, observe the failure; rebuild the blueprint
 * image from Settings → Blueprints; create a NEW agent — existing
 * containers stay frozen at the pre-rebuild image.
 */

import { WebSocket as NodeWebSocket } from "ws";
import type { Page } from "@playwright/test";
import {
  REQUEST_OP,
  RESPONSE_OP,
  encodeRequest,
  decodeResponse,
  type ControlBody,
  type EvalBody,
  type StateBody,
} from "../../src/lib/browser-input-codec";
import { getBaseUrl } from "./helpers";

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
   * nav-class), observable from the FE's own WS.
   */
  send(opcode: typeof REQUEST_OP.control, body: ControlBody): void;

  /** Reject all pending requests and close the socket. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Open a WS to `/api/browser-ws/:agentId`, authenticated via the
 * `better-auth.session_token` cookie carried by Playwright's context. Mirrors
 * the FE's connection logic in `src/components/browser-viewer.tsx`: the token
 * is pulled from the cookie jar and passed as a `?token=...` query param (the
 * server's `validateAgentForContainer` only inspects that param — cookies on
 * the WS upgrade are ignored).
 *
 * Resolves after the WS reaches OPEN. Rejects if open fails or times out
 * (5s). Caller should `await openBrowserWs(...)` at the start of the test
 * and call `probe.close()` at the end (or in a `finally`).
 */
export async function openBrowserWs(
  page: Page,
  agentId: string,
  opts: { openTimeoutMs?: number } = {},
): Promise<BrowserWsProbe> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "better-auth.session_token");
  // Better Auth's signed cookie is `<token>.<signature>` URL-encoded on the
  // wire — Playwright returns it URL-decoded. REST routes need the whole
  // signed value (BA verifies the signature each request); the WS auth path
  // (`validateAgentForContainer`) does `eq(session.token, token)` against the
  // DB's raw token column, which is the pre-`.` half. No-token connects work
  // for `running` agents (the server gates by status alone when the token is
  // absent) but never across users.
  const wsToken = session ? session.value.split(".")[0] : "";
  const tokenParam = wsToken ? `?token=${encodeURIComponent(wsToken)}` : "";

  const wsUrl = getBaseUrl().replace(/^http/i, "ws") + `/api/browser-ws/${agentId}${tokenParam}`;

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

  // ── pending request map ──────────────────────────────────────────────────
  const pending = new Map<number, Pending>();
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

    // We only consume 0x83 / 0x84 (request/response). Push opcodes
    // (0x80/0x81/0x85/0x86) arrive on the FE's own WS — we silently drop
    // them here.
    if (opcode !== RESPONSE_OP.evalResult && opcode !== RESPONSE_OP.stateSnapshot) return;
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
  });

  ws.on("close", () => {
    if (disposed) return;
    disposed = true;
    for (const [reqId] of pending) rejectPending(reqId, new Error("ws_closed"));
    pending.clear();
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

  function close(): void {
    if (disposed) return;
    disposed = true;
    for (const [reqId] of pending) rejectPending(reqId, new Error("ws_probe_closed"));
    pending.clear();
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  return { request, send, close } as BrowserWsProbe;
}
