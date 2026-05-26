/**
 * Request/response RPC over the live browser screencast WebSocket.
 *
 * Replaces the REST POST + JSON-response round trip for `eval` / `state`
 * (#61). Each request gets a u32 `reqId`; the server echoes it back in
 * its 0x83/0x84 response so we can correlate via a per-WS
 * `Map<reqId, Pending>`. WS close (unmount, reconnect) rejects all
 * outstanding requests with `ws_closed`.
 *
 * Control (0x10) is NOT exposed here — control is fire-and-forget, sent
 * directly via `ws.send(encodeRequest(REQUEST_OP.control, 0, body))` at
 * the call site. Saves a pending-map entry + timeout + decoder branch
 * per call; matters because resize fires constantly during window-drag.
 *
 * One factory per WebSocket instance — `pending` and `nextReqId` are
 * scoped to that instance so a reconnect doesn't inherit stale state.
 */

import {
  REQUEST_OP,
  RESPONSE_OP,
  decodeResponse,
  encodeRequest,
  type EvalBody,
  type StateBody,
} from "./browser-input-codec";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Expected opcode in the response. Used to reject if the server echoes
   * the wrong opcode for this reqId — shouldn't happen, but be paranoid.
   */
  expectedOpcode: (typeof RESPONSE_OP)[keyof typeof RESPONSE_OP];
}

export interface WsRpc {
  /**
   * Send a request frame over the WS and resolve with the decoded
   * response payload. Rejects on timeout (`timeoutMs`, default 5s), on
   * WS close before the response arrives, or on a wrong-opcode echo.
   *
   * Caller provides `T` as the expected JSON payload shape — be's
   * `run*` dispatchers define the contract.
   */
  request<T>(opcode: typeof REQUEST_OP.eval, body: EvalBody, timeoutMs?: number): Promise<T>;
  request<T>(opcode: typeof REQUEST_OP.state, body: StateBody, timeoutMs?: number): Promise<T>;

  /**
   * Hand off an incoming response frame (opcode 0x83 or 0x84). Decodes,
   * looks up the pending entry by reqId, and resolves/rejects. Caller
   * is responsible for opcode-dispatching from the WS `onmessage`
   * handler — this method assumes `buf` starts with a response opcode.
   */
  handleResponse(buf: ArrayBuffer): void;

  /**
   * Reject all outstanding requests with `ws_closed` and clear timers.
   * Call from the WS effect's cleanup function so unmount / reconnect
   * doesn't leak timers or leave promises hanging.
   */
  dispose(reason?: string): void;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createWsRpc(ws: WebSocket): WsRpc {
  const pending = new Map<number, Pending>();
  // Skip 0 so a `null`/uninitialized reqId can't accidentally match
  // (and to leave 0 reserved for fire-and-forget frames).
  let nextReqId = 1;
  let disposed = false;

  function allocReqId(): number {
    const id = nextReqId;
    nextReqId = nextReqId === 0xffffffff ? 1 : nextReqId + 1;
    return id;
  }

  function reject(reqId: number, err: Error): void {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    p.reject(err);
  }

  function resolve(reqId: number, value: unknown): void {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  function request<T>(
    opcode: typeof REQUEST_OP.eval | typeof REQUEST_OP.state,
    body: EvalBody | StateBody,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (disposed) return Promise.reject(new Error("ws_rpc_disposed"));
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("ws_not_open"));
    }
    const reqId = allocReqId();
    const expectedOpcode =
      opcode === REQUEST_OP.eval ? RESPONSE_OP.evalResult : RESPONSE_OP.stateSnapshot;

    return new Promise<T>((resolveCb, rejectCb) => {
      const timer = setTimeout(() => {
        reject(reqId, new Error(`ws_rpc_timeout opcode=0x${opcode.toString(16)}`));
      }, timeoutMs);
      pending.set(reqId, {
        resolve: resolveCb as (value: unknown) => void,
        reject: rejectCb,
        timer,
        expectedOpcode,
      });
      try {
        const frame =
          opcode === REQUEST_OP.eval
            ? encodeRequest(opcode, reqId, body as EvalBody)
            : encodeRequest(opcode, reqId, body as StateBody);
        ws.send(frame);
      } catch (err) {
        reject(reqId, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function handleResponse(buf: ArrayBuffer): void {
    const decoded = decodeResponse(buf);
    if (!decoded) return; // malformed framing — silent drop
    const p = pending.get(decoded.reqId);
    if (!p) return; // unknown / late reqId

    if (decoded.opcode !== p.expectedOpcode) {
      reject(
        decoded.reqId,
        new Error(
          `ws_rpc_opcode_mismatch expected=0x${p.expectedOpcode.toString(16)} ` +
            `got=0x${decoded.opcode.toString(16)}`,
        ),
      );
      return;
    }
    resolve(decoded.reqId, decoded.payload);
  }

  function dispose(reason: string = "ws_closed"): void {
    if (disposed) return;
    disposed = true;
    for (const [reqId] of pending) {
      reject(reqId, new Error(reason));
    }
    pending.clear();
  }

  return { request, handleResponse, dispose };
}
