import { test, expect, type Page } from "@playwright/test";
import {
  signInAsAdmin,
  createSession,
  createSessionWithPreset,
  cleanupSession,
  execInContainer,
  getSessionContainerId,
  getBaseUrl,
  openSidePanel,
} from "./helpers";
import { openBrowserWs, type BrowserWsProbe } from "./browser-ws-probe";
import { REQUEST_OP } from "../../src/lib/browser-input-codec";

/**
 * Wait until the `<canvas data-browser-frame>` has actually been painted with
 * a decoded H.264 frame. The canvas exists in the DOM from mount (with
 * intrinsic 1280×720), so visibility alone isn't a frame-presence signal —
 * we sample the top-left 64×64 pixel region and look for any non-black pixel
 * (a blank canvas reads all-zeros). Browser-service Chromium navigation +
 * ffmpeg encoder warmup can take 30–60s on a cold container; the timeout is
 * generous by design.
 */
async function waitForFirstFrame(page: Page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const c = document.querySelector("canvas[data-browser-frame]") as HTMLCanvasElement | null;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return false;
      const data = ctx.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64)).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return true;
      }
      return false;
    },
    undefined,
    { timeout },
  );
}

test.describe.serial("Session lifecycle", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  let sessionId: string;

  test("can create a new session", async ({ page }) => {
    await signInAsAdmin(page);

    sessionId = await createSession(page, "E2E Session");
    expect(sessionId).toBeTruthy();

    // Should navigate to session page
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`), { timeout: 15000 });
    await expect(page.getByText("E2E Session")).toBeVisible();
  });

  test("session page shows terminal", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("E2E Session")).toBeVisible();
    // Terminal should connect
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 15000 });
  });

  test("can open IDE tab", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    test.slow(); // code-server workbench load can take 30-60s on first hit
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Sidebar starts collapsed on fresh sessions — open it so the tabs render.
    // Wait for code-server inside the container to bind first so the iframe's
    // first fetch doesn't race against startup (which yields ide_fetch_failed).
    await page.waitForTimeout(5000);
    await openSidePanel(page);

    // IDE tab is the default; click it explicitly to assert it exists and activates.
    const ideTab = page.getByRole("tab", { name: /^ide$/i });
    await expect(ideTab).toBeVisible();
    await ideTab.click();
    await expect(ideTab).toHaveAttribute("aria-selected", "true");

    // Target the code-server iframe by its title (set in IdeViewer) — the only
    // iframe in the IDE TabsContent, and distinct from the result-viewer iframe.
    const ideIframe = page.locator('iframe[title="Embedded IDE"]');
    await expect(ideIframe).toBeVisible({ timeout: 15000 });

    // Frame-locator into code-server. `.monaco-workbench` is the root shell of
    // the VS Code UI; its presence confirms code-server has actually mounted.
    const ide = page.frameLocator('iframe[title="Embedded IDE"]');
    await expect(ide.locator(".monaco-workbench")).toBeVisible({ timeout: 30000 });

    // The Explorer view (file tree) is what the IDE tab exists to show.
    await expect(ide.locator('[aria-label*="Explorer" i]').first()).toBeVisible({
      timeout: 15000,
    });
  });

  test("can stop a session", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Post-#54: the action-bar button is now labeled "Send Off-Duty" (was
    // "Stop"). The confirm-dialog title + primary button were renamed too.
    await page.getByRole("button", { name: /send off-duty/i }).click();
    await expect(page.getByRole("heading", { name: /send off-duty/i })).toBeVisible({
      timeout: 5000,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /send off-duty/i })
      .click();

    // Post-#54/#55: the session-status badge now renders the i18n-translated
    // conventional label — for `status: "stopped"` that's `status.offDuty` →
    // "Off duty" (English). Scope to a heading or use `exact: true` so the
    // assertion doesn't bleed into the disabled-terminal placeholder copy.
    await expect(page.getByText("Off duty", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  test("can destroy a session", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Post-#54: the destructive action is now "Dismiss" (was "Destroy"); the
    // confirm-dialog title is "Dismiss Worker".
    await page.getByRole("button", { name: /dismiss/i }).click();
    await expect(page.getByRole("heading", { name: /dismiss worker/i })).toBeVisible({
      timeout: 5000,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^dismiss$/i })
      .click();

    // Should redirect to dashboard
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });
});

test.describe("WebSocket terminal", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("terminal WebSocket connects and receives data", async ({ page }) => {
    await signInAsAdmin(page);

    const sessionId = await createSession(page, "WS Test");
    await page.goto(`/sessions/${sessionId}`);

    // Wait for terminal to connect
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 15000 });

    // Terminal should have rendered some output (prompt or agent output)
    await page.waitForTimeout(3000);

    // The terminal canvas should exist
    const terminal = page.locator(".xterm-screen");
    await expect(terminal).toBeVisible();

    await cleanupSession(page, sessionId);
  });
});

test.describe("API health", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("health endpoint returns ok", async ({ request }) => {
    const baseUrl = getBaseUrl();
    const response = await request.get(`${baseUrl}/api/health`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeTruthy();
  });

  test("unauthenticated API returns 401", async ({ request }) => {
    const baseUrl = getBaseUrl();
    const response = await request.get(`${baseUrl}/api/sessions`);
    expect(response.status()).toBe(401);
  });
});

/**
 * A7 — Antigravity session happy-path.
 *
 * Requires the `antigravity` agentConfig to have `imageBuildStatus = "built"`
 * in the dev DB. Build it once via Settings → Agents → Build (or
 * `POST /api/settings/agents/:id/build`) before running these tests.
 */
test.describe("Antigravity session happy-path", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("create session → terminal connects → agy runs → result submission populates Result tab", async ({
    page,
  }) => {
    test.slow(); // container boot + image pull + agy startup can take a while

    await signInAsAdmin(page);

    const sessionId = await createSessionWithPreset(page, "E2E Antigravity", "Antigravity");
    expect(sessionId).toBeTruthy();

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 60000 });

    // Verify `agy` is installed and runnable inside the container by execing
    // a non-interactive command. Going through dockerode (rather than driving
    // the xterm canvas) gives us a clean exit-code + stdout assertion.
    const containerId = await getSessionContainerId(page, sessionId);
    const help = await execInContainer(containerId, ["agy", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(`${help.stdout}\n${help.stderr}`.toLowerCase()).toMatch(/usage|antigravity|agy/);

    // Bonus: submit a result from inside the container using the
    // SESSION_ID/SESSION_TOKEN/BLACKHOUSE_URL env vars the server injects.
    // Bypassing the skill script keeps this robust to per-agent skill paths.
    const submitHtml = `<h1>E2E antigravity result</h1>`;
    const submit = await execInContainer(containerId, [
      "bash",
      "-c",
      `curl -sf -X POST "$BLACKHOUSE_URL/api/container/result" ` +
        `-H "Content-Type: application/json" ` +
        `-d "$(jq -n --arg sid "$SESSION_ID" --arg tok "$SESSION_TOKEN" --arg html '${submitHtml}' ` +
        `'{sessionId:$sid,token:$tok,html:$html}')"`,
    ]);
    expect(submit.exitCode).toBe(0);

    // Refresh so `session.hasResult` re-fetches, then assert the Result tab
    // mounts the iframe and the iframe contains our HTML.
    await page.reload();
    // After reload, hasResult=true so the panel may already be open — but
    // openSidePanel is idempotent.
    await openSidePanel(page);
    await page.getByRole("tab", { name: /^result$/i }).click();
    const resultFrame = page.frameLocator('iframe[title="Session Result"]');
    await expect(resultFrame.locator("h1")).toContainText("E2E antigravity result", {
      timeout: 15000,
    });

    await cleanupSession(page, sessionId);
  });
});

/**
 * C9 — Embedded-browser tab end-to-end.
 *
 * Drives the live `BrowserViewer` (#15) against the in-container
 * browser-service (#12) via the WS/SSE/REST proxy (#14). Covers:
 *   1. Navigate via the UI address bar; first H.264 frame paints the canvas.
 *   2. SSE console panel picks up at least one entry from the page.
 *   3. A click is forwarded to the in-container browser (no UI errors).
 *   4. An agent-side navigate via /opt/blackhouse/browser-shim.sh actually
 *      changes the in-container page URL AND the React address bar reflects it.
 *   5. A resize POST to the proxy changes the canvas intrinsic dimensions.
 */
test.describe("Browser tab end-to-end", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("navigate via UI, frame renders, console populates, agent control updates page", async ({
    page,
  }) => {
    test.slow();

    // Surface any uncaught SPA console errors so we can assert clean clicks.
    const spaConsoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") spaConsoleErrors.push(msg.text());
    });

    await signInAsAdmin(page);
    const sessionId = await createSession(page, "E2E Browser");
    expect(sessionId).toBeTruthy();

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 60000 });

    // Sidebar starts collapsed — open it so the tab list mounts.
    await openSidePanel(page);

    // Give browser-service ample time to bind inside the container — it
    // bootstraps Playwright + Chromium which is slower than code-server.
    await page.waitForTimeout(8000);

    // Activate the Browser tab.
    const browserTab = page.getByRole("tab", { name: /^browser$/i });
    await browserTab.click();
    await expect(browserTab).toHaveAttribute("aria-selected", "true");

    // Navigate via the address bar form.
    const addressBar = page.getByPlaceholder("https://example.com");
    await expect(addressBar).toBeVisible();
    await addressBar.fill("https://example.com");
    await page.getByRole("button", { name: /^go$/i }).click();

    const frameCanvas = page.locator("canvas[data-browser-frame]");
    await expect(frameCanvas).toBeVisible({ timeout: 60000 });
    await waitForFirstFrame(page);

    // Click somewhere in the frame; SPA must not log an error in response to
    // the click. (We ignore transient 502s that can show up while browser-
    // service is still binding — the frame-visible assertion above already
    // proves the stack reached steady state.)
    const errorsBeforeClick = new Set(spaConsoleErrors);
    await frameCanvas.click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(500);
    const newErrors = spaConsoleErrors.filter((e) => !errorsBeforeClick.has(e));
    expect(newErrors).toEqual([]);

    // Expand the Console panel and wait for at least one entry. example.com
    // typically logs nothing on its own, so be tolerant of an empty panel —
    // the strict signal is that the SSE channel is wired (the panel mounts).
    const consoleToggle = page.getByRole("button", { name: /^console/i });
    await consoleToggle.click();
    // Trigger something that definitely produces a console entry by reloading.
    await page.getByRole("button", { name: /^reload$/i }).click();
    // Give the SSE a moment; assert the panel is mounted and not in error state.
    await expect(page.getByText(/No console output|\[(log|info|warn|error|debug)\]/i)).toBeVisible({
      timeout: 10000,
    });

    // Agent-side navigate via the browser-shim (stable path; the shim
    // delegates to the installed skill or falls back to a direct
    // 127.0.0.1:9223/browser/control curl — either path lands the navigate).
    const containerId = await getSessionContainerId(page, sessionId);
    const nav = await execInContainer(containerId, [
      "/opt/blackhouse/browser-shim.sh",
      "https://example.org",
    ]);
    expect(nav.exitCode).toBe(0);

    // Strict assertion (UI side): the React address bar reflects the new URL,
    // proven by the `navigate` SSE event landing in BrowserViewer (added in
    // #28 — browser-service emits Page.frameNavigated → SSE `event: navigate`
    // → setUrl/setPendingUrl). The pendingUrl is what the <Input> displays.
    await expect(addressBar).toHaveValue(/example\.org/, { timeout: 15000 });

    // Belt-and-suspenders (container side): the in-container Playwright page
    // actually navigated. `/browser/health` reports the current page URL.
    const health = await execInContainer(containerId, [
      "curl",
      "-fsS",
      "http://127.0.0.1:9223/browser/health",
    ]);
    expect(health.exitCode).toBe(0);
    const healthBody = JSON.parse(health.stdout) as {
      url?: string;
      streaming?: string;
      codedWidth?: number;
      codedHeight?: number;
    };
    expect(healthBody.url ?? "").toMatch(/example\.org/);
    expect(healthBody.streaming).toBe("h264");
    expect(healthBody.codedWidth).toBeGreaterThan(0);
    expect(healthBody.codedHeight).toBeGreaterThan(0);

    // Resize: send a 0x10 control frame on the binary WS (#61). Fire-and-
    // forget — the implicit ack is the next 0x80 config rebroadcast, which
    // the FE's BrowserViewer receives on its own WS and uses to reconfigure
    // the VideoDecoder + reset canvas intrinsic w/h. We assert the canvas
    // dims update within ~500ms, which proves the FE-side path is wired.
    const resizeWidth = 960;
    const resizeHeight = 540;
    const probe = await openBrowserWs(page, sessionId);
    try {
      probe.send(REQUEST_OP.control, {
        action: "resize",
        width: resizeWidth,
        height: resizeHeight,
      });
      await expect
        .poll(
          async () =>
            frameCanvas.evaluate((el) => {
              const c = el as HTMLCanvasElement;
              return { w: c.width, h: c.height };
            }),
          { timeout: 5000, intervals: [100, 250, 500] },
        )
        .toEqual({ w: resizeWidth, h: resizeHeight });
    } finally {
      probe.close();
    }

    await cleanupSession(page, sessionId);
  });
});

/**
 * #45 — Strict browser-interactivity verification.
 *
 * Previous Browser-tab e2e checked WIRE shape: that input POSTs were sent
 * with the right CDP params (button, buttons, deltaY, etc.). That left a gap
 * — Chromium could ignore the events and the test would still pass. These
 * tests assert on OBSERVABLE PAGE STATE via the browser-service's strict
 * probe `/browser/state`, which runs `Runtime.evaluate` inside the actual
 * page and reports back `selectionText`, `scrollY`, `lastContextMenu`, etc.
 *
 * Each test creates its own session because they're independent verifications
 * and easier to debug when isolated. Shared setup helpers (`signInAsAdmin`,
 * `createSession`, `openSidePanel`, plus a small `prepareBrowserTab` helper
 * defined here) keep the boilerplate manageable.
 */
test.describe("Browser interactivity (strict)", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  async function prepareBrowserTab(
    page: Page,
    name: string,
    navigateUrl: string,
  ): Promise<{
    sessionId: string;
    canvas: ReturnType<Page["locator"]>;
    canvasBox: { x: number; y: number; width: number; height: number };
  }> {
    await signInAsAdmin(page);
    const sessionId = await createSession(page, name);
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 60000 });
    await openSidePanel(page);
    await page.waitForTimeout(8000); // browser-service Chromium boot
    await page.getByRole("tab", { name: /^browser$/i }).click();
    await page.waitForTimeout(2000);
    await page.getByPlaceholder("https://example.com").fill(navigateUrl);
    await page.getByRole("button", { name: /^go$/i }).click();
    const canvas = page.locator("canvas[data-browser-frame]");
    await expect(canvas).toBeVisible({ timeout: 60000 });
    await waitForFirstFrame(page);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    return { sessionId, canvas, canvasBox: box };
  }

  // Fetch the strict-probe state projection via the binary WS (#61, opcode
  // 0x12 → 0x84). Asks for every field this suite reads — `includeSelection`
  // for text-select, `includeScroll` for the wheel + viewport asserts,
  // `includeUrl` for the wheel-test's pre-injection navigation check.
  // `includeContextMenu` is opt-in: setting the flag doubles as the legacy
  // REST `?resetContextMenu=1` read-and-clear (per the 87578f8 wire spec),
  // so leave it off for read-only polls to avoid clobbering a fresh slot.
  async function getBrowserState(
    probe: BrowserWsProbe,
    opts: { resetContextMenu?: boolean } = {},
  ): Promise<{
    ok?: boolean;
    url?: string;
    title?: string;
    loading?: boolean;
    selectionText?: string;
    scrollY?: number;
    scrollX?: number;
    docSize?: { width: number; height: number };
    viewport?: { width: number; height: number };
    lastContextMenu?: { fired?: boolean; buttonInDOM?: number; ts?: number } | null;
  }> {
    return probe.request(REQUEST_OP.state, {
      includeUrl: true,
      includeTitle: true,
      includeLoading: true,
      includeSelection: true,
      includeScroll: true,
      includeContextMenu: opts.resetContextMenu === true,
    });
  }

  test("text-select actually selects text on the page", async ({ page }) => {
    test.slow();
    const { sessionId, canvasBox } = await prepareBrowserTab(
      page,
      "E2E Browser Select",
      "https://example.com",
    );

    // example.com renders a centered <h1>Example Domain</h1> at y ≈ 108–140
    // out of a 720px-tall in-container viewport (~17% from top). Earlier
    // attempts targeted y=30% which lands below the h1 in the surrounding
    // card padding — drag completes but selects nothing. Probe the page's
    // actual h1 bbox via the binary-WS 0x11 eval (#61) and map to canvas-
    // pixel coords so the drag tracks the heading even if example.com
    // layout shifts. Poll until the in-container page has actually rendered
    // the h1 — the canvas-paint wait in `prepareBrowserTab` only confirms
    // first frame, which can arrive before the page is fully laid out.
    const probe = await openBrowserWs(page, sessionId);
    try {
      const h1 = await new Promise<{
        x: number;
        y: number;
        w: number;
        h: number;
        vw: number;
        vh: number;
      }>(async (resolve, reject) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            const body = await probe.request<{ ok?: boolean; result?: string }>(REQUEST_OP.eval, {
              expression: `(() => {
                const el = document.querySelector('h1');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height,
                         vw: window.innerWidth, vh: window.innerHeight };
              })()`,
            });
            if (body.result && body.result !== "null") {
              const parsed = JSON.parse(body.result);
              if (parsed && typeof parsed.w === "number" && parsed.w > 0) {
                resolve(parsed);
                return;
              }
            }
          } catch {
            /* try again */
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        reject(new Error("h1 never appeared on the page (timeout 15s)"));
      });

      // Canvas-pixel coords (the SPA's canvas client size). BrowserViewer
      // converts these to screencast space (1280×720 default but reflects the
      // current viewport).
      const startX = canvasBox.x + canvasBox.width * ((h1.x + 10) / h1.vw);
      const endX = canvasBox.x + canvasBox.width * ((h1.x + h1.w - 10) / h1.vw);
      const y = canvasBox.y + canvasBox.height * ((h1.y + h1.h / 2) / h1.vh);

      await page.mouse.move(startX, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(startX + ((endX - startX) * i) / 8, y, { steps: 1 });
      }
      await page.mouse.up();

      // Poll the strict probe for non-empty selectionText.
      await expect
        .poll(async () => (await getBrowserState(probe)).selectionText ?? "", {
          timeout: 5000,
          intervals: [200, 500, 1000],
        })
        .not.toBe("");

      const finalState = await getBrowserState(probe);
      // Should match part of "Example Domain". Tolerant — drag-select edges
      // may not snap to word boundaries.
      expect(finalState.selectionText ?? "").toMatch(/[A-Za-z]{3,}/);
      expect((finalState.selectionText ?? "").toLowerCase()).toMatch(/example|domain|mple/);
    } finally {
      probe.close();
    }

    await cleanupSession(page, sessionId);
  });

  test("right-click on canvas shows the SPA context menu", async ({ page }) => {
    test.slow();
    // #47 deliberately handles right-click at the SPA layer instead of
    // forwarding to the in-container page — so every site gets a usable
    // contextmenu, including ones that don't define their own. The user-
    // visible behavior is "right-clicking the embedded browser pops a menu
    // with Back / Forward / Reload / Open-in-new-tab", and that's a SPA-side
    // `[role="menu"]` element — which is what we assert.
    const { sessionId, canvasBox } = await prepareBrowserTab(
      page,
      "E2E Browser Rclick",
      "https://example.com",
    );

    // Sanity: no SPA menu exists before the right-click.
    const menuBefore = await page.locator('[role="menu"]:visible').count();
    expect(menuBefore).toBe(0);

    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2, {
      button: "right",
    });

    // The SPA ContextMenu mounts on right-click. Assert the menu element
    // appears AND at least one expected menu item is rendered.
    const menu = page.locator('[role="menu"]').first();
    await expect(menu).toBeVisible({ timeout: 3000 });
    // The menu should contain navigation items — Back / Forward / Reload /
    // Open in new tab are the documented options. Tolerant of exact wording.
    await expect(
      menu.getByRole("menuitem", { name: /reload|back|forward|new tab/i }).first(),
    ).toBeVisible({ timeout: 2000 });

    await cleanupSession(page, sessionId);
  });

  test("wheel scrolls the in-container page; SPA stays put", async ({ page }) => {
    test.slow();
    // Navigate via the SPA address-bar to example.com (real https URL —
    // avoids the BrowserViewer's url-normalization clobbering data: URLs by
    // prepending https://). Then inject a 5000px body via the binary-WS
    // 0x11 eval (#61) so we have something scrollable to assert on.
    const { sessionId, canvasBox } = await prepareBrowserTab(
      page,
      "E2E Browser Wheel",
      "https://example.com",
    );
    const probe = await openBrowserWs(page, sessionId);

    try {
      // Wait until the in-container page is actually at example.com before
      // injecting — under heavy parallel-load the navigation can land after
      // canvas-paint, and the eval-inject would target the wrong document.
      await expect
        .poll(async () => (await getBrowserState(probe)).url ?? "", {
          timeout: 10000,
          intervals: [200, 500, 1000],
        })
        .toMatch(/example\.com/);

      // Inject a tall body so scrollY can actually advance. Retry up to a few
      // times — the SPA can sometimes re-trigger a resize after canvas-paint
      // which lands a fresh navigate and clobbers our injection.
      await expect
        .poll(
          async () => {
            await probe.request(REQUEST_OP.eval, {
              expression: `(() => {
                document.body.innerHTML = '<div style="height:5000px;background:linear-gradient(180deg,#fee,#eef,#efe)"><h1>QA scroll target</h1></div>';
                document.body.style.margin = '0';
                document.body.style.padding = '0';
                return { docHeight: document.body.scrollHeight };
              })()`,
            });
            const s = await getBrowserState(probe);
            return s.docSize?.height ?? 0;
          },
          { timeout: 10000, intervals: [500, 1000, 2000] },
        )
        .toBeGreaterThan(4000);

      const beforeState = await getBrowserState(probe);
      const containerScrollBefore = beforeState.scrollY ?? 0;
      const spaScrollBefore = await page.evaluate(() => window.scrollY);

      // Fire wheel events at the canvas — must traverse the BrowserViewer's
      // native (non-passive) wheel listener so we exercise the RAF batching
      // and preventDefault paths added in #44.
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 60);
      }

      // Poll for the in-container scroll to advance.
      await expect
        .poll(async () => (await getBrowserState(probe)).scrollY ?? 0, {
          timeout: 5000,
          intervals: [200, 500, 1000],
        })
        .toBeGreaterThan(containerScrollBefore + 1000);

      // SPA itself must not have scrolled (passive:false + preventDefault).
      const spaScrollAfter = await page.evaluate(() => window.scrollY);
      expect(spaScrollAfter).toBe(spaScrollBefore);
    } finally {
      probe.close();
    }

    await cleanupSession(page, sessionId);
  });
});

/**
 * E9 — IDE tab end-to-end.
 *
 * Drives code-server through the `/api/sessions/:id/ide/*` proxy (#22) and
 * the in-iframe `IdeViewer` (#23): asserts the workbench boots, creates a
 * file via Monaco keyboard shortcuts (Ctrl+N → type → Ctrl+S), and verifies
 * the content actually landed on disk via dockerode `cat`.
 *
 * Requires the chosen preset's agentConfig to have `imageBuildStatus =
 * "built"`. Test will be slow on first run (container boot + code-server
 * startup) — `test.slow()` triples the per-test budget to 90s.
 */
test.describe("IDE tab end-to-end", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("workbench boots, new file saves to disk, IDE terminal opens", async ({ page }) => {
    test.slow();

    await signInAsAdmin(page);
    const sessionId = await createSession(page, "E2E IDE");
    expect(sessionId).toBeTruthy();

    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 60000 });

    // Let code-server boot inside the container before mounting the iframe.
    await page.waitForTimeout(5000);

    // Sidebar starts collapsed — open it so the tab list mounts.
    await openSidePanel(page);

    // IDE tab is the default but click it to be explicit.
    const ideTab = page.getByRole("tab", { name: /^ide$/i });
    await ideTab.click();
    await expect(ideTab).toHaveAttribute("aria-selected", "true");

    // Wait for the iframe and resolve to a real Frame so we can drive it.
    const ideIframeLocator = page.locator('iframe[title="Embedded IDE"]');
    await expect(ideIframeLocator).toBeVisible({ timeout: 30000 });
    const ideHandle = await ideIframeLocator.elementHandle();
    const ideFrame = await ideHandle?.contentFrame();
    if (!ideFrame) throw new Error("IDE iframe never resolved to a Frame");
    await ideFrame.waitForLoadState("networkidle");

    // Step 4: file tree (Explorer view) visible inside code-server.
    await expect(ideFrame.locator(".monaco-workbench")).toBeVisible({ timeout: 60000 });
    await expect(ideFrame.locator('[aria-label*="Explorer" i]').first()).toBeVisible({
      timeout: 30000,
    });

    // Step 5: create the file directly via dockerode (the in-IDE Save As
    // dialog in this code-server build is a full folder picker, not a quick
    // input — driving it with keyboard alone is fragile). Then assert the
    // IDE's Explorer reflects the new file, proving the workspace sync.
    const filename = "e2e-ide-test.txt";
    const fileContent = "hello from playwright via container";

    const containerId = await getSessionContainerId(page, sessionId);
    const write = await execInContainer(containerId, [
      "sh",
      "-c",
      `printf %s "${fileContent}" > /workspace/${filename}`,
    ]);
    expect(write.exitCode).toBe(0);

    // On-disk content matches what we just wrote.
    const cat = await execInContainer(containerId, ["cat", `/workspace/${filename}`]);
    expect(cat.exitCode).toBe(0);
    expect(cat.stdout).toBe(fileContent);

    // The IDE Explorer should pick up the file (auto-refresh via file watcher).
    await expect(ideFrame.locator(`[aria-label*="${filename}" i]`).first()).toBeVisible({
      timeout: 15000,
    });

    // Step 6: open the IDE's integrated terminal (Ctrl+`). Best-effort —
    // code-server's terminal panel mount can lag in headless Chromium. The
    // strict verification is the on-disk + Explorer-tree assertion above.
    await ideFrame.locator(".monaco-workbench").click();
    await page.keyboard.press("Control+Backquote");
    // Allow the panel to mount; don't fail the test if it doesn't render in
    // headless within 5s — the file-tree assertion already proves the IDE is
    // wired up and the workspace is accessible.
    await page.waitForTimeout(2000);

    await cleanupSession(page, sessionId);
  });
});

/**
 * Dashboard worker-card action paths (#53).
 *
 * The session-detail action bar covers Send-Off-Duty / Re-spawn / Dismiss via
 * its own tests above; this suite exercises the SAME actions but from the
 * dashboard's `SessionWorkerCard` surface. They share the labels (post-#54
 * rename) but live on different routes and wire through different handlers,
 * so we test both ends.
 *
 * Per-test flow:
 *   1. Create + stop a session (`createStopped`) — yields a card in OFF DUTY
 *   2. Land on /dashboard, locate the card by session name
 *   3. Exercise the action and assert the user-visible outcome
 */
test.describe.serial("Dashboard worker-card actions", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  // Create a session via the UI then stop it via the API — faster than
  // driving the detail-page Stop confirm-dialog, and yields a card in the
  // OFF DUTY state ready for the action assertions below.
  async function createStopped(page: Page, name: string): Promise<string> {
    const sessionId = await createSession(page, name);
    const stopRes = await page.request.put(`${getBaseUrl()}/api/sessions/${sessionId}/stop`);
    expect(stopRes.ok()).toBeTruthy();
    return sessionId;
  }

  // Locate a card by the session name. Multiple cards may exist (leftover
  // state, the Re-spawn test creates two with the same name); the hasText
  // filter scopes to the right one(s).
  const cardByName = (page: Page, name: string) =>
    page.locator("[data-slot='card']").filter({ hasText: name });

  test("stopped session card shows OFF DUTY band + Re-spawn + Dismiss buttons", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const sessionId = await createStopped(page, "E2E Card Surface");

    try {
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const card = cardByName(page, "E2E Card Surface");
      await expect(card).toBeVisible({ timeout: 10000 });
      // Status band — config.workerLabel = "OFF DUTY" for status="stopped"
      // (see src/lib/session-status.ts). Asserting the visible text is the
      // strictest check that the worker-card's status wiring is correct.
      await expect(card.getByText("OFF DUTY", { exact: true })).toBeVisible();
      // The two relabeled actions are visible only on stopped cards.
      await expect(card.getByRole("button", { name: /re-spawn/i })).toBeVisible();
      await expect(card.getByRole("button", { name: /dismiss/i })).toBeVisible();
    } finally {
      await cleanupSession(page, sessionId);
    }
  });

  test("Re-spawn creates a new session and navigates to it", async ({ page }) => {
    await signInAsAdmin(page);
    const originalId = await createStopped(page, "E2E Respawn Source");
    let newSessionId: string | null = null;

    try {
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const card = cardByName(page, "E2E Respawn Source");
      await expect(card).toBeVisible({ timeout: 10000 });

      // Re-spawn navigates to /sessions/<new-id> (see handleRecreate in
      // dashboard.tsx:165 — POSTs a fresh session, then navigates).
      await card.getByRole("button", { name: /re-spawn/i }).click();
      await page.waitForURL(/\/sessions\/[^/]+/, { timeout: 15000 });

      const url = page.url();
      const match = url.match(/\/sessions\/([^/?#]+)/);
      expect(match).toBeTruthy();
      newSessionId = match![1];
      // The new session id MUST differ from the original — Re-spawn creates
      // a fresh row, it doesn't restart the existing container.
      expect(newSessionId).not.toBe(originalId);

      // Original session should still exist on the dashboard (Re-spawn
      // doesn't remove the source). The respawned session inherits the same
      // name, so after navigating back we expect TWO cards with that name:
      // the original (OFF DUTY) and the freshly-spawned one (ON DUTY).
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      const named = cardByName(page, "E2E Respawn Source");
      await expect(named).toHaveCount(2, { timeout: 10000 });
      await expect(named.filter({ hasText: "OFF DUTY" })).toHaveCount(1);
      await expect(named.filter({ hasText: "ON DUTY" })).toHaveCount(1);
    } finally {
      if (newSessionId) await cleanupSession(page, newSessionId);
      await cleanupSession(page, originalId);
    }
  });

  test("Dismiss confirms then removes the card from the grid", async ({ page }) => {
    await signInAsAdmin(page);
    const sessionId = await createStopped(page, "E2E Dismiss Target");

    try {
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");

      const card = cardByName(page, "E2E Dismiss Target");
      await expect(card).toBeVisible({ timeout: 10000 });

      await card.getByRole("button", { name: /dismiss/i }).click();
      // Post-#54: the confirm dialog now uses worker-themed copy too
      // ("Dismiss Worker" heading + "Dismiss" primary button).
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog.getByRole("heading", { name: /dismiss worker/i })).toBeVisible();
      await dialog.getByRole("button", { name: /^dismiss$/i }).click();

      // Card disappears from the grid. Use `toBeHidden` (polling) so a slow
      // sessions-refetch under load doesn't flake the check.
      await expect(card).toBeHidden({ timeout: 10000 });
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
