/**
 * Node-side wire-format smoke for the #61 browser WS protocol.
 *
 * Disambiguates "codec wire bug" from "viewer render/state bug" when qa
 * surfaces something. If this script passes, the codec + server agree on
 * the byte layout end-to-end — any qa-found regression is in the React
 * layer. If it fails, the wire spec is wrong somewhere.
 *
 * Default flow hires its own session and dismisses it after the run —
 * deliberately avoids reuse of long-lived sessions whose container image
 * may have been baked before the latest `agent/browser-service/*` source
 * (see #61's image-rebuild hazard). The container code is frozen at the
 * image's build time; the only way to test the current wire spec is via
 * a session whose image was rebuilt against current source.
 *
 *   1. Sign in as admin via Better Auth → grab session cookie.
 *   2. Hire a fresh session (preset configurable via E2E_SMOKE_PRESET);
 *      poll until `status === "running"`. Or use E2E_SESSION_ID to reuse
 *      an existing session (debug / iteration).
 *   3. Open ws://localhost:3000/api/browser-ws/:id?token=<sessionToken>.
 *   4. Send 0x10 control(navigate, "https://example.com").
 *   5. Within ~5s assert: ≥1 0x80 config, ≥1 0x81 video, ≥1 0x86
 *      navigate with the example.com URL.
 *   6. Send 0x12 state(includeUrl|includeTitle|includeLoading).
 *   7. Within ~2s assert one 0x84 echoes the reqId with url+title+loading
 *      in the JSON payload.
 *   8. Dismiss the session (DELETE /api/sessions/:id). Always runs even
 *      on failure — leaks zombies otherwise.
 *
 * On a TEXT frame the smoke fails fast with a "container image is stale"
 * hint: the pre-#61-cut-2 agent emits TEXT JSON config preambles, so a
 * TEXT frame means the operator forgot to rebuild the agent image
 * (`agent/browser-service/*` changes after the last image build).
 *
 * Usage:
 *   tsx scripts/smoke-browser-ws.ts
 *   E2E_SESSION_ID=<uuid> tsx scripts/smoke-browser-ws.ts
 *
 * Env:
 *   E2E_BASE_URL          (default http://localhost:3000)
 *   E2E_ADMIN_USERNAME    (default admin)
 *   E2E_ADMIN_PASSWORD    (default test1234)
 *   E2E_SESSION_ID        (optional; reuse instead of hiring fresh)
 *   E2E_SMOKE_PRESET      (default antigravity; agent preset for hires)
 */

import {
  encodeRequest,
  decodeConfig,
  decodeVideoFrame,
  decodeResponse,
  decodeNavigateEvent,
  REQUEST_OP,
  PUSH_OP,
  RESPONSE_OP,
} from "../src/lib/browser-input-codec.ts";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "test1234";
const SMOKE_PRESET = process.env.E2E_SMOKE_PRESET ?? "antigravity";
const HIRE_POLL_TIMEOUT_MS = 90_000;
const HIRE_POLL_INTERVAL_MS = 1_000;

function cookieHeader(auth: AuthBundle): string {
  // Re-encode for the Cookie header value (`%3D` etc.); the server's
  // cookie parser expects the wire-format.
  return `better-auth.session_token=${encodeURIComponent(auth.cookieValue)}`;
}

interface AuthBundle {
  /** Full signed cookie value (`<token>.<signature>` decoded). For REST. */
  cookieValue: string;
  /** Just the token-part (pre-`.`). For WS `?token=…` — that's what
   * `validateSessionForContainer` does an `eq` against. */
  wsToken: string;
}

async function signIn(): Promise<AuthBundle> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in ${res.status}: ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!m) throw new Error("no session token in set-cookie");
  // Set-Cookie values are URL-encoded on the wire; the cookie value itself
  // is `<token>.<signature>`. REST routes need the whole signed cookie
  // (Better Auth verifies the signature on every request); the WS auth
  // path looks up `session.token` directly so it needs the pre-`.` half.
  const cookieValue = decodeURIComponent(m[1]);
  return { cookieValue, wsToken: cookieValue.split(".")[0] };
}

async function hireSession(auth: AuthBundle): Promise<string> {
  const name = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(auth),
    },
    body: JSON.stringify({ name, preset: SMOKE_PRESET }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hire session ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { data: { id: string } } | { id: string };
  const id = "data" in body ? body.data.id : body.id;
  console.log(`[smoke] hired session ${id} (preset=${SMOKE_PRESET}) — waiting for running`);
  return id;
}

async function waitForRunning(auth: AuthBundle, sessionId: string): Promise<void> {
  const deadline = Date.now() + HIRE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: { cookie: cookieHeader(auth) },
    });
    if (res.ok) {
      const body = (await res.json()) as { status?: string };
      if (body.status === "running") return;
      if (body.status === "destroyed") throw new Error("session destroyed before reaching running");
    }
    await new Promise((r) => setTimeout(r, HIRE_POLL_INTERVAL_MS));
  }
  throw new Error(`session ${sessionId} not running after ${HIRE_POLL_TIMEOUT_MS}ms`);
}

async function dismissSession(auth: AuthBundle, sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { cookie: cookieHeader(auth) },
  });
  if (!res.ok) {
    console.warn(`[smoke] WARN dismiss ${sessionId} failed (${res.status}); manual cleanup needed`);
  } else {
    console.log(`[smoke] dismissed session ${sessionId}`);
  }
}

interface Counts {
  config: number;
  video: number;
  navigate: { url: string; ts: number } | null;
  state: { reqId: number; payload: unknown } | null;
}

async function smokeOnSession(sessionId: string, sessionToken: string): Promise<void> {
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/api/browser-ws/${sessionId}?token=${encodeURIComponent(sessionToken)}`;
  console.log(`[smoke] opening ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const counts: Counts = { config: 0, video: 0, navigate: null, state: null };
  const STATE_REQ_ID = 0xdead_beef;

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const deadline = setTimeout(() => {
      ws.close();
      reject(new Error(`overall smoke deadline (10s) — counts so far: ${JSON.stringify(counts)}`));
    }, 10_000);

    function check() {
      // Phase 2 success: state snapshot arrived
      if (counts.state) {
        clearTimeout(deadline);
        ws.close();
        resolve();
      }
    }

    ws.addEventListener("open", () => {
      console.log(`[smoke] open (${Date.now() - startedAt}ms)`);
      // Phase 1: fire navigate
      const navFrame = encodeRequest(REQUEST_OP.control, 0, {
        action: "navigate",
        url: "https://example.com",
      });
      ws.send(navFrame);
      console.log(`[smoke] sent 0x10 navigate(example.com) — ${navFrame.byteLength}B`);
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        // The post-#61-cut-2 protocol is binary-only. A TEXT frame means
        // the container's `agent/browser-service/*` was baked into the
        // image before commit 5677d6c. Bail loudly — staying open just
        // ties up the deadline waiting for frames that will never arrive.
        clearTimeout(deadline);
        ws.close();
        reject(
          new Error(
            `STALE CONTAINER: received TEXT preamble "${event.data.slice(0, 100)}". ` +
              `Agent image was built before #61 cut-2 (commit 5677d6c). ` +
              `Rebuild the agent image and hire a fresh session, then re-run.`,
          ),
        );
        return;
      }
      const buf = event.data as ArrayBuffer;
      if (buf.byteLength < 1) return;
      const op = new DataView(buf).getUint8(0);

      switch (op) {
        case PUSH_OP.config: {
          const cfg = decodeConfig(buf);
          if (!cfg) {
            console.error("[smoke] 0x80 frame did not decode");
            return;
          }
          counts.config++;
          console.log(
            `[smoke] 0x80 config #${counts.config}: ${cfg.codedWidth}x${cfg.codedHeight} codec=${cfg.codec}`,
          );
          return;
        }
        case PUSH_OP.videoFrame: {
          const vf = decodeVideoFrame(buf);
          if (!vf) return;
          counts.video++;
          if (counts.video <= 3 || counts.video % 30 === 0) {
            console.log(
              `[smoke] 0x81 video #${counts.video} (${vf.isKey ? "KEY" : "delta"}, ${vf.nalu.byteLength}B nalu)`,
            );
          }
          return;
        }
        case 0x82:
          console.warn(`[smoke] WARN unexpected 0x82 frame — server should not be sending these`);
          return;
        case RESPONSE_OP.evalResult:
        case RESPONSE_OP.stateSnapshot: {
          const decoded = decodeResponse(buf);
          if (!decoded) {
            console.error(`[smoke] 0x${op.toString(16)} frame did not decode`);
            return;
          }
          if (decoded.opcode === RESPONSE_OP.stateSnapshot && decoded.reqId === STATE_REQ_ID) {
            counts.state = { reqId: decoded.reqId, payload: decoded.payload };
            console.log(
              `[smoke] 0x84 stateSnapshot reqId=${decoded.reqId}: ${JSON.stringify(decoded.payload)}`,
            );
            check();
          }
          return;
        }
        case PUSH_OP.navigateEvent: {
          const ev = decodeNavigateEvent(buf);
          if (!ev) return;
          counts.navigate = ev;
          console.log(`[smoke] 0x86 navigate: url=${ev.url} ts=${ev.ts}`);
          // Phase 2: send state request once nav lands.
          if (ev.url.includes("example.com")) {
            const stateFrame = encodeRequest(REQUEST_OP.state, STATE_REQ_ID, {
              includeUrl: true,
              includeTitle: true,
              includeLoading: true,
            });
            ws.send(stateFrame);
            console.log(`[smoke] sent 0x12 state(flags=0x07) reqId=${STATE_REQ_ID}`);
          }
          return;
        }
        default:
          console.warn(`[smoke] WARN unknown opcode 0x${op.toString(16)}`);
      }
    });

    ws.addEventListener("error", (e) => {
      clearTimeout(deadline);
      reject(new Error(`ws error: ${String(e)}`));
    });

    ws.addEventListener("close", (e) => {
      clearTimeout(deadline);
      if (!counts.state) {
        reject(
          new Error(
            `ws closed before state arrived (code=${e.code}); counts=${JSON.stringify(counts)}`,
          ),
        );
      }
    });
  });

  // ─── Assertions ────────────────────────────────────────────────────────
  const failures: string[] = [];
  if (counts.config === 0) failures.push("no 0x80 config frame arrived");
  if (counts.video === 0) failures.push("no 0x81 video frame arrived");
  if (!counts.navigate) {
    failures.push("no 0x86 navigate event arrived");
  } else if (!counts.navigate.url.includes("example.com")) {
    failures.push(`0x86 navigate URL=${counts.navigate.url} doesn't include example.com`);
  }
  if (!counts.state) {
    failures.push("no 0x84 stateSnapshot arrived");
  } else {
    const p = counts.state.payload as Record<string, unknown> | null;
    if (!p || typeof p !== "object") {
      failures.push(`0x84 payload not an object: ${JSON.stringify(p)}`);
    } else {
      if (typeof p.url !== "string") failures.push("0x84 payload missing url");
      if (typeof p.title !== "string") failures.push("0x84 payload missing title");
      if (typeof p.loading !== "boolean") failures.push("0x84 payload missing loading");
    }
  }

  if (failures.length) {
    console.error("\n[smoke] ❌ FAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\n[smoke] ✅ PASS — wire format end-to-end clean");
}

async function main() {
  const auth = await signIn();
  console.log(`[smoke] signed in`);

  const reuseId = process.env.E2E_SESSION_ID;
  const sessionId = reuseId ?? (await hireSession(auth));
  if (reuseId) {
    console.log(`[smoke] reusing session ${reuseId} (E2E_SESSION_ID set)`);
  } else {
    await waitForRunning(auth, sessionId);
    console.log(`[smoke] session ${sessionId} is running`);
  }

  try {
    await smokeOnSession(sessionId, auth.wsToken);
  } finally {
    if (!reuseId) {
      // Only dismiss sessions WE hired. Reused sessions belong to the
      // operator — they decide when to dismiss.
      await dismissSession(auth, sessionId);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
