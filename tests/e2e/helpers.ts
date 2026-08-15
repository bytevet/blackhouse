import Docker from "dockerode";
import { expect, type Page } from "@playwright/test";

/** Base URL for API calls — defaults to the Vite dev server. */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || "http://localhost:5173";
}

/* ------------------------------------------------------------------ auth -- */

/**
 * The composer textarea — the one element that is on screen for every signed-in
 * user on the landing route and nothing else.
 *
 * Anchoring sign-in on this rather than on a heading is deliberate: the channel
 * page's only heading is the `#slug`, which changes per channel, and the roster
 * heading no longer lives on the landing route at all. The composer carries
 * `aria-label="Message #<slug>"` (`components/channel/composer.tsx`) and an
 * explicit `role="combobox"` for the mention listbox, so it is both stable and
 * slug-agnostic when matched on the prefix.
 */
export function composer(page: Page) {
  return page.getByRole("combobox", { name: /^Message #/ });
}

/**
 * Sign in with the admin user. Honors E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD;
 * falls back to the dev seed defaults (`admin` / `test1234`). No-op when the
 * storage state already carries a live session.
 */
export async function signInAsAdmin(page: Page) {
  const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "test1234";

  // `domcontentloaded`, never `networkidle`: every authed tab holds the
  // multiplexed SSE stream (`GET /api/stream`) open for its lifetime, so a
  // 500ms-of-silence wait never fires inside the test timeout.
  await page.goto("/channels", { waitUntil: "domcontentloaded" });

  // The server serves the SPA shell for /channels regardless of auth; the
  // client-side gate then either renders the channel (already authed via
  // storageState) or navigates to /login. Right after domcontentloaded the URL
  // does not yet tell us which side of that race we are on — wait for whichever
  // concrete signal appears first.
  const landed = composer(page);
  const loginField = page.getByPlaceholder("username");
  await Promise.race([
    landed.waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined),
    loginField.waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined),
  ]);
  if (await landed.isVisible().catch(() => false)) return;

  // Let the bundle hydrate before driving the form: Better Auth's submit
  // handler attaches on mount, and clicking earlier races the native submit.
  await page.waitForLoadState("load");
  await loginField.fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // Anchor on the composer rather than a URL match: `/login` redirects to
  // `/channels`, which redirects again to `/channels/general`, and a URL-only
  // wait can match the transient middle hop.
  await expect(landed).toBeVisible({ timeout: 15000 });
}

/* --------------------------------------------------------------- REST API -- */

/**
 * Playwright's request context shares the page's cookie jar, so every call
 * below is authenticated as whoever the browser context is signed in as.
 * `failOnStatusCode` stays off everywhere — the caller decides what a bad
 * status means.
 */
async function apiJson<T>(
  page: Page,
  method: "get" | "post" | "put" | "delete",
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await page.request[method](`${getBaseUrl()}${path}`, {
    ...(data === undefined ? {} : { data, headers: { "Content-Type": "application/json" } }),
    failOnStatusCode: false,
  });
  if (!res.ok())
    throw new Error(`${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

export type AgentStatus = "creating" | "running" | "stopped" | "error" | "destroyed";
export type AgentActivity = "idle" | "busy" | "unknown";

/**
 * `GET /api/agents` row. Note `status` (container) and `activity` (the process
 * inside it) are two independent fields — assertions must not fold them
 * together. See `src/lib/agent-status.ts`.
 */
export interface AgentSummary {
  id: string;
  handle: string;
  displayName: string;
  blueprintId: string;
  status: AgentStatus;
  activity: AgentActivity;
  statusLine: string | null;
  containerId: string | null;
  sandboxRuntime: string | null;
  runtimeUsed: string | null;
  egressPolicy: string | null;
  pausedAt: string | null;
}

export interface BlueprintSummary {
  id: string;
  name: string;
  cli: string;
  image: string | null;
  imageBuildStatus: string;
  sandboxRuntime: string;
  egressPolicy: string;
}

export interface ChannelSummary {
  id: string;
  slug: string;
  name: string;
  topic: string | null;
  autoApproveDispatch: boolean;
  isArchived: boolean;
}

/** Every E2E-created object is named from this prefix so teardown can sweep it. */
export const E2E_PREFIX = "e2e";

/** A fresh, schema-valid agent handle: lowercase, digits, `-`/`_`, 2–32 chars. */
export function uniqueHandle(prefix = E2E_PREFIX): string {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
  return `${prefix}-${suffix}`.slice(0, 32);
}

export async function listBlueprints(page: Page): Promise<BlueprintSummary[]> {
  return apiJson<BlueprintSummary[]>(page, "get", "/api/settings/blueprints");
}

/** The seeded "Claude Code" blueprint if present, else whatever is first. */
export async function defaultBlueprintId(page: Page): Promise<string> {
  const blueprints = await listBlueprints(page);
  if (blueprints.length === 0) throw new Error("no blueprints seeded — run `npm run db:seed`");
  return (blueprints.find((b) => b.cli === "claude-code") ?? blueprints[0]).id;
}

export async function listAgents(page: Page): Promise<AgentSummary[]> {
  return apiJson<AgentSummary[]>(page, "get", "/api/agents");
}

export async function getAgent(page: Page, agentId: string): Promise<AgentSummary> {
  return apiJson<AgentSummary>(page, "get", `/api/agents/${agentId}`);
}

/**
 * Create an agent row via the API.
 *
 * This does **not** need Docker: `POST /api/agents` only inserts the row with
 * `status: "creating"`. The container is not built until `POST
 * /api/agents/:id/start`, which is the line every docker-gated spec sits behind.
 */
export async function createAgent(
  page: Page,
  opts: {
    handle?: string;
    displayName?: string;
    blueprintId?: string;
    gitRepoUrl?: string | null;
    sandboxRuntime?: "auto" | "runc" | "runsc" | "kata";
    egressPolicy?: "none" | "allowlist" | "open";
  } = {},
): Promise<AgentSummary> {
  const handle = opts.handle ?? uniqueHandle();
  return apiJson<AgentSummary>(page, "post", "/api/agents", {
    handle,
    displayName: opts.displayName ?? handle,
    blueprintId: opts.blueprintId ?? (await defaultBlueprintId(page)),
    gitRepoUrl: opts.gitRepoUrl ?? null,
    ...(opts.sandboxRuntime ? { sandboxRuntime: opts.sandboxRuntime } : {}),
    ...(opts.egressPolicy ? { egressPolicy: opts.egressPolicy } : {}),
  });
}

/**
 * Best-effort teardown. `DELETE /api/agents/:id` force-destroys the container
 * when there is one and otherwise just flips the row to `destroyed`, so it is
 * safe to call on a Docker-less host. 404s and 403s are swallowed.
 */
export async function deleteAgent(page: Page, agentId: string): Promise<void> {
  await page.request
    .delete(`${getBaseUrl()}/api/agents/${agentId}`, { failOnStatusCode: false })
    .catch(() => {});
}

/** Look up the containerId for a running agent. Throws while it has none. */
export async function getAgentContainerId(page: Page, agentId: string): Promise<string> {
  const agent = await getAgent(page, agentId);
  if (!agent.containerId) throw new Error(`agent ${agentId} has no containerId`);
  return agent.containerId;
}

export async function listChannels(page: Page): Promise<ChannelSummary[]> {
  return apiJson<ChannelSummary[]>(page, "get", "/api/channels");
}

export async function channelBySlug(page: Page, slug: string): Promise<ChannelSummary> {
  const found = (await listChannels(page)).find((c) => c.slug === slug);
  if (!found) throw new Error(`channel #${slug} not found`);
  return found;
}

export interface PostedMessage {
  message: { id: string; body: string; kind: string; mentions: string[] | null };
  dispatched: Array<{ agentId: string; runId: string; queued: boolean; reason?: string }>;
}

/**
 * Post into a channel. Mentions in `body` are resolved server-side and each
 * one creates a run — queued rather than injected when the agent is not
 * running, which is what makes this callable without Docker.
 */
export async function postChannelMessage(
  page: Page,
  slug: string,
  body: string,
  mode: "queue" | "interrupt" = "queue",
): Promise<PostedMessage> {
  return apiJson<PostedMessage>(page, "post", `/api/channels/${slug}/messages`, { body, mode });
}

export interface TranscriptPage {
  messages: Array<{ id: string; kind: string; body: string | null; createdAt: string }>;
  hasMore: boolean;
  nextCursor: string | null;
}

/** Keyset transcript page, newest first. */
export async function listChannelMessages(
  page: Page,
  slug: string,
  limit = 50,
): Promise<TranscriptPage> {
  return apiJson<TranscriptPage>(page, "get", `/api/channels/${slug}/messages?limit=${limit}`);
}

/* ------------------------------------------------------------------- SSE -- */

/** One decoded frame from `GET /api/stream`. Every frame carries its topic. */
export interface StreamFrame {
  event: string;
  topic: string;
  type: string;
  [key: string]: unknown;
}

export interface StreamProbe {
  /** Next frame, or `null` when the stream closed or the wait timed out. */
  next(timeoutMs?: number): Promise<StreamFrame | null>;
  /** Next frame whose `type` matches, discarding anything before it. */
  nextOfType(type: string, timeoutMs?: number): Promise<StreamFrame | null>;
  close(): void;
}

/**
 * Subscribe to the multiplexed SSE stream.
 *
 * There is exactly one stream endpoint and one connection per tab —
 * `GET /api/stream?topics=channel:<uuid>,agent:<uuid>` — because browsers cap
 * concurrent connections per origin at around six and per-room streams would
 * starve each other. Frames arrive as `event: <type>` plus a JSON `data` line
 * that repeats the type and adds the topic.
 *
 * `ready` and `ping` frames are filtered out; the iterator only yields payload
 * frames. Uses raw `node:http` with the context's cookies so no EventSource
 * polyfill is needed.
 */
export async function openStream(page: Page, topics: string[]): Promise<StreamProbe> {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const url = new URL(`${getBaseUrl()}/api/stream`);
  url.searchParams.set("topics", topics.join(","));

  const http = await import("node:http");
  const https = await import("node:https");
  const lib = url.protocol === "https:" ? https : http;

  const queue: StreamFrame[] = [];
  const waiters: ((frame: StreamFrame | null) => void)[] = [];
  let closed = false;
  let buf = "";

  // Resolved once the server has answered and written its `ready` frame, so a
  // caller that posts immediately after `openStream` cannot race the
  // subscription and miss its own event.
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const deliver = (frame: StreamFrame) => {
    if (waiters.length) waiters.shift()!(frame);
    else queue.push(frame);
  };
  const drain = () => {
    while (waiters.length) waiters.shift()!(null);
  };

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
        markReady();
        drain();
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        // SSE frames are delimited by a blank line.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = raw.split("\n");
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message";
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (event === "ready") markReady();
          if (!dataLine || event === "ping" || event === "ready") continue;
          try {
            const payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            deliver({
              ...payload,
              event,
              topic: String(payload.topic ?? ""),
              type: String(payload.type ?? event),
            });
          } catch {
            /* malformed payload — drop */
          }
        }
      });
      res.on("end", () => {
        closed = true;
        markReady();
        drain();
      });
    },
  );
  req.on("error", () => {
    closed = true;
    markReady();
    drain();
  });
  req.end();

  // Never hang the suite on a stream that will not open.
  await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);

  const next = (timeoutMs = 5000): Promise<StreamFrame | null> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    if (closed) return Promise.resolve(null);
    return new Promise<StreamFrame | null>((resolve) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(handler);
        if (i !== -1) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const handler = (frame: StreamFrame | null) => {
        clearTimeout(timer);
        resolve(frame);
      };
      waiters.push(handler);
    });
  };

  return {
    next,
    async nextOfType(type: string, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const frame = await next(remaining);
        if (!frame) return null;
        if (frame.type === type) return frame;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        req.destroy();
      } catch {
        /* already torn down */
      }
      drain();
    },
  };
}

/* ------------------------------------------------------- Docker / Podman -- */

/**
 * Docker gating.
 *
 * There is no daemon in CI or in the dev container, and an agent image is
 * multi-GB, so anything that needs a real container is opt-in behind
 * `E2E_DOCKER=1`. Specs that only drive the UI and the REST API run
 * unconditionally.
 */
export const DOCKER_E2E = !!process.env.E2E_DOCKER;
export const DOCKER_SKIP_REASON = "Requires Docker — set E2E_DOCKER=1 to enable";

/**
 * Lazy singleton dockerode client pointing at the same socket the server uses.
 * Honors DOCKER_HOST_SOCKET for parity with `.env`; falls back to the default
 * `/var/run/docker.sock` (symlinked to the Podman socket on the dev box).
 */
let _docker: Docker | null = null;
export function getTestDockerClient(): Docker {
  return (_docker ??= new Docker({
    socketPath: process.env.DOCKER_HOST_SOCKET || "/var/run/docker.sock",
  }));
}

/**
 * Is a daemon actually reachable? `E2E_DOCKER=1` states intent; this states
 * fact. Docker-gated specs check both so a mis-set env var skips cleanly
 * instead of failing with a socket error.
 */
export async function dockerReachable(): Promise<boolean> {
  try {
    await getTestDockerClient().ping();
    return true;
  } catch {
    return false;
  }
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
