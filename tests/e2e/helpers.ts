import Docker from "dockerode";
import type { Page } from "@playwright/test";

/**
 * Get the base URL for API calls.
 */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || "http://localhost:5173";
}

/**
 * Sign in with the admin user.
 * Uses E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD env vars,
 * falling back to the local dev seed defaults: admin / test1234.
 *
 * Note: actual seed password depends on the ADMIN_PASSWORD env var at seed
 * time. The dev Podman env stood up in task #1 uses `test1234`.
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
 * Create a new session from the dashboard.
 * Picks the first available built agent.
 * Returns the session ID from the URL.
 */
export async function createSession(page: Page, name: string): Promise<string> {
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  // Post-#54: "New Session" button → "Hire Worker"; dialog primary action
  // "Create Session" → "Hire". The dialog's placeholder for the session name
  // is still "My session" (the input itself wasn't themed).
  await page.getByRole("button", { name: /hire worker/i }).click();
  await page.waitForTimeout(500);

  // Hire-Worker dialog uses <FieldLabel> + <Input placeholder="My session">.
  // FieldLabel has no htmlFor association, so target by placeholder instead.
  await page.getByPlaceholder("My session").fill(name);

  // Open the "Agent Config" Select. Scope to the Field wrapper whose label
  // text is "Agent Config" so we pick the right select-trigger when the
  // dialog has multiple selects (Agent Config, Template, …).
  const agentField = page.locator('[data-slot="field"]').filter({ hasText: "Agent Config" });
  await agentField.locator('[data-slot="select-trigger"]').click();
  await page.waitForTimeout(300);
  // Click the first non-disabled option in the open dropdown
  const agentOption = page.locator("[role=option]:not([data-disabled])").first();
  await agentOption.click();

  // Anchor on `^hire$` to avoid colliding with the trigger button (which
  // includes the word "Hire" in "Hire Worker"). The dialog's primary button
  // is just "Hire" (or "Hiring..." mid-flight).
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^hire$/i })
    .click();

  // Wait for navigation to session page
  await page.waitForURL(/\/sessions\//, { timeout: 30000 });

  const url = page.url();
  const match = url.match(/\/sessions\/([a-f0-9-]+)/);
  return match?.[1] ?? "";
}

/**
 * Create a new session and pick a specific agent preset by displayName.
 *
 * Used by Track A (antigravity happy-path), C (browser tests need a specific
 * agent), and D (smoke loops over every preset).
 *
 * Returns the session ID from the URL.
 */
export async function createSessionWithPreset(
  page: Page,
  name: string,
  presetDisplayName: string,
): Promise<string> {
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  // Same #54 rename as createSession above.
  await page.getByRole("button", { name: /hire worker/i }).click();
  await page.waitForTimeout(500);

  await page.getByPlaceholder("My session").fill(name);

  const agentField = page.locator('[data-slot="field"]').filter({ hasText: "Agent Config" });
  await agentField.locator('[data-slot="select-trigger"]').click();
  await page.waitForTimeout(300);
  await page.getByRole("option", { name: presetDisplayName, exact: true }).click();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^hire$/i })
    .click();

  await page.waitForURL(/\/sessions\//, { timeout: 30000 });

  const url = page.url();
  const match = url.match(/\/sessions\/([a-f0-9-]+)/);
  return match?.[1] ?? "";
}

/**
 * Ensure the session page's right-hand sidebar (containing the IDE / Result /
 * Browser tabs) is open. On fresh sessions it defaults to closed; the toggle
 * button shows "IDE" when closed and "Hide Panel" when open.
 *
 * Idempotent — safe to call when the panel is already open.
 */
export async function openSidePanel(page: Page) {
  const openLabel = page.getByRole("button", { name: /^ide$/i });
  if (await openLabel.isVisible().catch(() => false)) {
    await openLabel.click();
    // Wait for the tab list to mount inside the now-open sidebar.
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
  if (_docker) return _docker;
  const socketPath = process.env.DOCKER_HOST_SOCKET || "/var/run/docker.sock";
  _docker = new Docker({ socketPath });
  return _docker;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Exec a command inside a container by id (NOT session id).
 * Resolves the session's containerId via the API helper below if needed.
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  opts: { user?: string; workingDir?: string } = {},
): Promise<ExecResult> {
  const docker = getTestDockerClient();
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: opts.user,
    WorkingDir: opts.workingDir,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  // Collect the raw multiplexed stream and demux ourselves — avoids a
  // dockerode `demuxStream` race where downstream readables can end before
  // their `data` listeners drain. Format per Docker API:
  //   8-byte header: [stream_type, 0, 0, 0, size_be_32]
  //   stream_type: 1=stdout, 2=stderr
  //   followed by `size` bytes of payload
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const raw = Buffer.concat(chunks);
  const stdoutParts: Buffer[] = [];
  const stderrParts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= raw.length) {
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

/**
 * Look up the containerId for a session via the API (assumes the requesting
 * page is already authenticated).
 */
export async function getSessionContainerId(page: Page, sessionId: string): Promise<string> {
  const res = await page.request.get(`${getBaseUrl()}/api/sessions/${sessionId}`);
  if (!res.ok()) throw new Error(`GET /api/sessions/${sessionId} -> ${res.status()}`);
  const data = (await res.json()) as { containerId?: string | null };
  if (!data.containerId) throw new Error(`session ${sessionId} has no containerId`);
  return data.containerId;
}
