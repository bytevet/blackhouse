import Docker from "dockerode";
import { expect, type Page } from "@playwright/test";

/** Base URL for API calls — defaults to the Vite dev server. */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || "http://localhost:5173";
}

/**
 * Sign in with the admin user. Honors E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD;
 * falls back to the local dev seed defaults (admin / test1234, per the Podman
 * setup in task #1). No-op if the page is already on the dashboard.
 */
export async function signInAsAdmin(page: Page) {
  const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "test1234";

  // `domcontentloaded` (not `networkidle`) — the messaging UI's
  // InboxEventsProvider holds an SSE EventSource open on every authed
  // page. `networkidle` waits 500ms of zero-network — the SSE never
  // closes, so it never fires within the test timeout. The sign-in /
  // dashboard probes here only need the DOM ready before interacting.
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  // Skip the form if storageState already authed us. Match on pathname,
  // not substring — when unauth'd the server redirects to
  // `/login?redirect=%2Fdashboard`, which trivially "includes" the
  // string `/dashboard` and would incorrectly skip the sign-in.
  if (new URL(page.url()).pathname.startsWith("/dashboard")) return;

  // Wait for the SPA bundle to fully hydrate before driving the form —
  // the Better Auth client's submit handler is attached on mount, and
  // clicking before hydration completes can race the JS-handler vs the
  // native HTML form submit.
  await page.waitForLoadState("load");
  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Don't waitForURL alone — Better Auth's post-login flow briefly bounces
  // /dashboard → /login?redirect=/dashboard → /dashboard while the
  // freshly-set cookie propagates through `useSession`. waitForURL would
  // match the first transition and return mid-bounce. Anchor on the
  // dashboard's actual content (Roster heading) so the helper returns
  // only when the page is stable.
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: /roster/i })).toBeVisible({ timeout: 15000 });
}

/**
 * Drive the Hire-Worker dialog. Shared body for `createSession` (any agent)
 * and `createSessionWithPreset` (specific preset). The two public helpers
 * differ only in how they pick the agent inside the open dropdown.
 *
 * Post-#54 naming: "New Session" → "Hire Worker"; "Create Session" → "Hire".
 * Anchor on `^hire$` for the submit button to avoid colliding with the
 * trigger button (which contains the substring "Hire" via "Hire Worker").
 */
async function hireWorker(
  page: Page,
  name: string,
  pickAgent: () => Promise<void>,
): Promise<string> {
  await page.goto("/dashboard");
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: /hire worker/i }).click();
  await page.waitForTimeout(500);

  // Dialog uses <FieldLabel> + <Input placeholder="My session">; FieldLabel
  // has no htmlFor association, so target by placeholder.
  await page.getByPlaceholder("My session").fill(name);

  // Open the "Agent Config" Select. Scope to the Field wrapper whose label
  // text is "Agent Config" — the dialog has multiple selects (Agent, Template).
  const agentField = page.locator('[data-slot="field"]').filter({ hasText: "Agent Config" });
  await agentField.locator('[data-slot="select-trigger"]').click();
  await page.waitForTimeout(300);
  await pickAgent();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^hire$/i })
    .click();

  await page.waitForURL(/\/sessions\//, { timeout: 30000 });
  return page.url().match(/\/sessions\/([a-f0-9-]+)/)?.[1] ?? "";
}

/** Create a session and pick the first non-disabled agent. Returns sessionId. */
export async function createSession(page: Page, name: string): Promise<string> {
  return hireWorker(page, name, async () => {
    await page.locator("[role=option]:not([data-disabled])").first().click();
  });
}

/** Create a session with a named agent preset (e.g. "Antigravity"). */
export async function createSessionWithPreset(
  page: Page,
  name: string,
  presetDisplayName: string,
): Promise<string> {
  return hireWorker(page, name, async () => {
    await page.getByRole("option", { name: presetDisplayName, exact: true }).click();
  });
}

/**
 * Best-effort session cleanup via the DELETE API. Used at the end of docker-
 * gated tests instead of driving the UI's Stop→Destroy dance — that path only
 * works when status=stopped and is several confirm-dialogs deep. DELETE tears
 * the container + DB row down in one call, and 404s on already-gone sessions
 * are silently ignored.
 */
export async function cleanupSession(page: Page, sessionId: string): Promise<void> {
  await page.request.delete(`${getBaseUrl()}/api/sessions/${sessionId}`).catch(() => {});
}

/**
 * Ensure the session page's right-hand sidebar (IDE / Result / Browser tabs)
 * is open. On fresh sessions the panel starts collapsed and the toggle button
 * is labeled "IDE"; once open, the tab list is mounted. Idempotent — safe to
 * call when the panel is already open (the locator misses and we no-op).
 */
export async function openSidePanel(page: Page) {
  const openLabel = page.getByRole("button", { name: /^ide$/i });
  if (await openLabel.isVisible().catch(() => false)) {
    await openLabel.click();
    await page.getByRole("tab", { name: /^ide$/i }).waitFor({ state: "visible", timeout: 5000 });
  }
}

/* ---------- Docker / Podman helpers (#7, #16, #27) ---------- */

/**
 * Lazy singleton dockerode client pointing at the same socket the server uses.
 * Honors DOCKER_HOST_SOCKET for parity with `.env`; falls back to the default
 * `/var/run/docker.sock` (which on the dev box is symlinked to the Podman
 * socket — see task #1 writeup).
 */
let _docker: Docker | null = null;
export function getTestDockerClient(): Docker {
  return (_docker ??= new Docker({
    socketPath: process.env.DOCKER_HOST_SOCKET || "/var/run/docker.sock",
  }));
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Exec a command inside a container by id. Manually demuxes the multiplexed
 * stream (avoids a dockerode `demuxStream` race where downstream readables
 * can end before their `data` listeners drain). Docker stream-frame format:
 *   8-byte header: [stream_type(1=out,2=err), 0, 0, 0, size_be_32]
 *   followed by `size` bytes of payload
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  opts: { user?: string; workingDir?: string } = {},
): Promise<ExecResult> {
  const container = getTestDockerClient().getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: opts.user,
    WorkingDir: opts.workingDir,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const raw = Buffer.concat(chunks);
  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  for (let i = 0; i + 8 <= raw.length; ) {
    const streamType = raw[i];
    const size = raw.readUInt32BE(i + 4);
    const payload = raw.subarray(i + 8, i + 8 + size);
    if (streamType === 1) stdoutParts.push(payload);
    else if (streamType === 2) stderrParts.push(payload);
    i += 8 + size;
  }

  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode,
    stdout: Buffer.concat(stdoutParts).toString("utf8"),
    stderr: Buffer.concat(stderrParts).toString("utf8"),
  };
}

/** Look up the containerId for a session via the API (assumes signed-in). */
export async function getSessionContainerId(page: Page, sessionId: string): Promise<string> {
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/${sessionId}`);
  if (!res.ok()) throw new Error(`GET /api/sessions/${sessionId} -> ${res.status()}`);
  const data = (await res.json()) as { containerId?: string | null };
  if (!data.containerId) throw new Error(`session ${sessionId} has no containerId`);
  return data.containerId;
}

/* ---------- Inter-session messaging helpers (#70) ---------- */

/**
 * Per-session token for messaging endpoint auth (#70). The messaging API uses
 * `authSessionToken` — the same per-session `SESSION_TOKEN` env var the
 * in-container skill scripts read — NOT the Better Auth cookie. Tests fetch
 * the token via `GET /api/sessions/:id` (admin/owner-only) and pass it via
 * `Authorization: Bearer <token>` on each messaging call.
 *
 * The token is durable for the session's lifetime — cache the result per
 * sessionId rather than refetching for every call.
 */
const _sessionTokenCache = new Map<string, string>();
export async function getSessionToken(page: Page, sessionId: string): Promise<string> {
  const cached = _sessionTokenCache.get(sessionId);
  if (cached) return cached;
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/${sessionId}`);
  if (!res.ok()) throw new Error(`GET /api/sessions/${sessionId} -> ${res.status()}`);
  const data = (await res.json()) as { sessionToken?: string | null };
  if (!data.sessionToken) throw new Error(`session ${sessionId} has no sessionToken`);
  _sessionTokenCache.set(sessionId, data.sessionToken);
  return data.sessionToken;
}

export interface InboxMessage {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  message: string;
  requestId: string | null;
  status: "pending" | "expired";
  deliveredAt: string | null;
  ackAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SendMessageResponse {
  message_id: string;
  queued_at: string;
  target_unread_count: number;
}

export interface SendMessageOpts {
  requestId?: string;
  /** Override response expectation — pass `false` to read 4xx/429 status without throwing. */
  expectOk?: boolean;
}

/**
 * Send a message from `fromSessionId` to `targetSessionId`. Auth via the
 * sender's session token (so tests can exercise cross-user 403 by passing
 * the wrong session's token, and ID-guess attacks by passing a foreign
 * `targetSessionId`).
 *
 * Returns the raw Playwright APIResponse so callers can assert status —
 * use `response.json()` to read the body on success.
 */
export async function sendMessage(
  page: Page,
  fromSessionId: string,
  targetSessionId: string,
  message: string,
  opts: SendMessageOpts = {},
) {
  const token = await getSessionToken(page, fromSessionId);
  return page.request.post(`${getBaseUrl()}/api/sessions/${fromSessionId}/send-message`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      target_session_id: targetSessionId,
      message,
      ...(opts.requestId ? { request_id: opts.requestId } : {}),
    },
    failOnStatusCode: false,
  });
}

/** Convenience: send + parse + assert 200. Throws if !ok. */
export async function sendMessageOk(
  page: Page,
  fromSessionId: string,
  targetSessionId: string,
  message: string,
  opts: SendMessageOpts = {},
): Promise<SendMessageResponse> {
  const res = await sendMessage(page, fromSessionId, targetSessionId, message, opts);
  if (!res.ok()) {
    throw new Error(`sendMessage -> ${res.status()}: ${await res.text()}`);
  }
  return (await res.json()) as SendMessageResponse;
}

export interface GetInboxOpts {
  unread?: boolean;
  limit?: number;
  /** Sender-side `--wait` polling — server filters to `request_id IS <id>`. */
  replyTo?: string;
  /** Override token (e.g. for 403 tests with a deliberately-wrong token). */
  tokenOverride?: string;
}

/**
 * Fetch the inbox for `sessionId`. By default returns *unread* pending
 * messages. Server marks returned rows' `delivered_at = NOW()` — this is
 * observability only, does NOT flip status/ack_at; tests assert it to
 * detect "agent autonomously called check-inbox.sh."
 */
export async function getInbox(
  page: Page,
  sessionId: string,
  opts: GetInboxOpts = {},
): Promise<InboxMessage[]> {
  const token = opts.tokenOverride ?? (await getSessionToken(page, sessionId));
  const params = new URLSearchParams();
  if (opts.unread !== false) params.set("unread", "true");
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.replyTo) params.set("reply_to", opts.replyTo);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/${sessionId}/inbox${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`GET /inbox -> ${res.status()}: ${await res.text()}`);
  const body = (await res.json()) as { messages: InboxMessage[] };
  return body.messages;
}

/** Cheap unread-count probe — same path the sidecar daemon polls. */
export async function getInboxCount(page: Page, sessionId: string): Promise<number> {
  const token = await getSessionToken(page, sessionId);
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/${sessionId}/inbox/count`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`GET /inbox/count -> ${res.status()}: ${await res.text()}`);
  const data = (await res.json()) as { unread: number };
  return data.unread;
}

/** Ack a single message. Idempotent: returns 200 with `already_acked: true` on second ack. */
export async function ackMessage(page: Page, sessionId: string, msgId: string) {
  const token = await getSessionToken(page, sessionId);
  return page.request.put(`${getBaseUrl()}/api/sessions/${sessionId}/messages/${msgId}/ack`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
}

/**
 * Ack a batch by ID. The server-side `to_session_id = :id` clause is
 * load-bearing — foreign IDs in `ids` are silently ignored, NOT 403'd.
 * Returns `{ acked: N }` where N is the count of own-session rows that
 * actually flipped.
 */
export async function ackMessageBatch(page: Page, sessionId: string, ids: string[]) {
  const token = await getSessionToken(page, sessionId);
  return page.request.put(`${getBaseUrl()}/api/sessions/${sessionId}/messages/ack-batch`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: { ids },
    failOnStatusCode: false,
  });
}

export interface SessionListMineRow {
  id: string;
  name: string;
  status: "pending" | "running" | "stopped" | "destroyed";
  preset: string | null;
  agentTitle: string | null;
}

/**
 * Sender-side discovery: list all of the auth'd user's non-destroyed
 * sessions. Token's session must belong to the requesting user (server
 * derives userId from the token's session row).
 */
export async function listMineSessions(
  page: Page,
  callerSessionId: string,
): Promise<SessionListMineRow[]> {
  const token = await getSessionToken(page, callerSessionId);
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/list-mine`, {
    headers: { Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
  });
  if (!res.ok()) throw new Error(`GET /list-mine -> ${res.status()}: ${await res.text()}`);
  const body = (await res.json()) as { sessions: SessionListMineRow[] };
  return body.sessions;
}

/**
 * Open an SSE subscription to `/api/inbox-events`. Returns an async iterator
 * over decoded JSON events plus a `close()` to tear the stream down. Uses
 * Playwright's `page.request.fetch` so the auth cookie is carried.
 *
 * The endpoint is one connection per logged-in user (NOT per session). Each
 * dashboard tab opens its own EventSource; tests open one stream and assert
 * the expected `{ type, sessionId, unreadCount }` event arrives within ~1s
 * of a send / ack operation.
 *
 * Heartbeats arrive as `event: ping\ndata: \n\n` and are filtered out — the
 * iterator only yields `data` lines.
 */
export interface InboxEvent {
  type: "unread-changed";
  sessionId: string;
  unreadCount: number;
}

export interface InboxEventStream {
  /** Next event or `null` if the stream closed / timed out. */
  next(timeoutMs?: number): Promise<InboxEvent | null>;
  close(): void;
}

export async function openInboxEventsStream(page: Page): Promise<InboxEventStream> {
  // Playwright's request context supports streaming SSE via Node fetch under
  // the hood; we use the raw `node:http` path to keep this dependency-free.
  // Cookies from `page.context()` are reused for auth.
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const url = new URL(`${getBaseUrl()}/api/sessions/inbox-events`);

  // Dynamic import keeps this off the hot path for non-SSE tests.
  const http = await import("node:http");
  const https = await import("node:https");
  const lib = url.protocol === "https:" ? https : http;

  const queue: InboxEvent[] = [];
  const waiters: ((ev: InboxEvent | null) => void)[] = [];
  let closed = false;
  let buf = "";

  const req = lib.request(
    {
      method: "GET",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: { Accept: "text/event-stream", Cookie: cookieHeader },
    },
    (res) => {
      if (res.statusCode !== 200) {
        closed = true;
        while (waiters.length) waiters.shift()!(null);
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        // SSE frames are delimited by blank lines (`\n\n`).
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Skip heartbeats (`event: ping`) and comment lines.
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as InboxEvent;
            if (waiters.length) waiters.shift()!(ev);
            else queue.push(ev);
          } catch {
            /* malformed payload — drop */
          }
        }
      });
      res.on("end", () => {
        closed = true;
        while (waiters.length) waiters.shift()!(null);
      });
    },
  );
  req.on("error", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  req.end();

  return {
    next(timeoutMs = 5000): Promise<InboxEvent | null> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise<InboxEvent | null>((resolve) => {
        const t = setTimeout(() => {
          const idx = waiters.indexOf(handler);
          if (idx !== -1) waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        const handler = (ev: InboxEvent | null) => {
          clearTimeout(t);
          resolve(ev);
        };
        waiters.push(handler);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      while (waiters.length) waiters.shift()!(null);
    },
  };
}
