import Docker from "dockerode";
import type { Page } from "@playwright/test";

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

  await page.goto("/dashboard", { waitUntil: "networkidle" });
  if (page.url().includes("/dashboard")) return;

  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
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
  await page.waitForLoadState("networkidle");

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
