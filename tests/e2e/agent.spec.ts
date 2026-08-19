import { test, expect } from "@playwright/test";
import {
  DOCKER_E2E,
  DOCKER_SKIP_REASON,
  createAgent,
  deleteAgent,
  dockerReachable,
  execInContainer,
  getAgent,
  getAgentContainerId,
  getBaseUrl,
  listBlueprints,
  signInAsAdmin,
  type AgentSummary,
} from "./helpers";

/**
 * The agent pane (`/agents/:agentId`).
 *
 * A pane inside `AppShell` rather than a page of its own, so the rail is on
 * screen throughout — which is why there is no breadcrumb to assert on any
 * more. The URL is unchanged and still deep-linkable.
 *
 * Wired to the real API (`components/agent/agent-data.ts`), so everything that
 * does not need a live container is exercised against an agent created through
 * `POST /api/agents` — which stops at `status: "creating"` and never touches
 * Docker.
 */
test.describe("Agent pane", () => {
  test("an unknown agent id renders the error state, not a spinner", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents/00000000-0000-4000-8000-000000000000", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("alert")).toContainText(/does not exist/i, { timeout: 15000 });
  });

  test.describe("for a created-but-not-started agent", () => {
    let agent: AgentSummary;

    test.beforeEach(async ({ page }) => {
      await signInAsAdmin(page);
      agent = await createAgent(page, { displayName: "Detail Probe" });
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Detail Probe")).toBeVisible({ timeout: 15000 });
    });

    test.afterEach(async ({ page }) => {
      if (agent) await deleteAgent(page, agent.id);
    });

    test("header shows identity plus both state signals", async ({ page }) => {
      // The rail replaced the breadcrumb: it is always on screen and already
      // says which agent you are in.
      await expect(page.locator("aside")).toBeVisible();
      await expect(page.locator("main").getByText(`@${agent.handle}`).first()).toBeVisible();

      // Container status and process activity are separate pills, and a fresh
      // row pairs `creating` with `unknown` — a legal combination, and the
      // whole reason for two fields. Never assert one as a proxy for the other.
      //
      // Lowercase on purpose: `agent-header.tsx` renders the last segment of
      // the `agentStatus.*` key rather than the translated label, which is what
      // gives the design its `● running` / `busy · …` monospace styling. This
      // assertion previously read "Creating" and had been failing against the
      // real app.
      // Scoped to the pane. The rail is on screen now and lists every agent in
      // the workspace with its own status, so an unscoped `getByText` matches
      // one row per agent rather than this one's header.
      const pane = page.locator("main");
      await expect(pane.getByText("creating", { exact: true }).first()).toBeVisible();
      await expect(pane.getByText("unknown", { exact: true }).first()).toBeVisible();

      // Not running → Start only. Restart/Stop belong to a live container.
      await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Restart" })).toHaveCount(0);
    });

    test("the terminal refuses to attach and says why", async ({ page }) => {
      await expect(
        page.getByText("The agent is creating. Start it to attach a terminal."),
      ).toBeVisible();
    });

    test("the five views are tabs, and IDE degrades with the same reason", async ({ page }) => {
      for (const name of ["Terminal", "IDE", "Browser", "Artifacts", "Settings"]) {
        await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
      }

      const ide = page.getByRole("tab", { name: "IDE", exact: true });
      await ide.click();
      await expect(ide).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByText("The agent is creating. Start it to open the IDE."),
      ).toBeVisible();
    });

    test("split mode pins the terminal to the left pane", async ({ page }) => {
      // The toggle only exists at >= 900px wide (`useSplitAvailable`); the
      // default Playwright desktop viewport (1280) clears it.
      const split = page.getByRole("switch", { name: "Split" });
      await expect(split).toBeVisible();
      await split.click();

      // Terminal goes inert and the same strip now drives the right pane.
      await expect(page.getByRole("tab", { name: "Terminal" })).toBeDisabled();
      await expect(page.getByRole("tablist", { name: "Right pane view" })).toBeVisible();

      await split.click();
      await expect(page.getByRole("tab", { name: "Terminal" })).toBeEnabled();
    });

    test("destroy is confirmation-gated and states what is lost", async ({ page }) => {
      await page.getByRole("tab", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Destroy/ }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`Destroy @${agent.handle}?`);
      // The consequence is spelled out rather than implied.
      await expect(dialog).toContainText(/deletes the workspace and state volumes/i);

      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      expect((await getAgent(page, agent.id)).status).toBe("creating");
    });
  });
});

/**
 * Everything past this point needs a real container.
 *
 * Gated on `E2E_DOCKER=1` (intent) *and* a reachable daemon (fact), so a
 * mis-set env var skips cleanly instead of failing on a socket error. Neither
 * CI nor the dev container has a daemon.
 *
 * They also need a blueprint whose image starts without provider credentials.
 * `tests/fixtures/mock-agent-tui.sh` and its `mock` blueprint are being built
 * for exactly that; until one is seeded these skip themselves rather than
 * burning a multi-GB pull on a real agent image. Cleanup is left to
 * `global-teardown.ts`, which sweeps every `e2e-` handle.
 */
test.describe.serial("Agent lifecycle (docker)", () => {
  test.skip(() => !DOCKER_E2E, DOCKER_SKIP_REASON);

  let agentId = "";

  test("starts a mock-blueprint agent and attaches its terminal", async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);
    test.skip(!(await dockerReachable()), "No Docker daemon on this host");

    const blueprints = await listBlueprints(page);
    const mock = blueprints.find((b) => b.cli === "mock" || /^mock$/i.test(b.name));
    test.skip(
      !mock,
      "No `mock` blueprint seeded — see tests/fixtures/mock-agent-tui.sh. Real agent images " +
        "need provider credentials and a multi-GB pull, so this stays skipped without it.",
    );

    const agent = await createAgent(page, { blueprintId: mock!.id, displayName: "Mock Agent" });
    agentId = agent.id;

    const started = await page.request.post(`${getBaseUrl()}/api/agents/${agent.id}/start`, {
      failOnStatusCode: false,
    });
    expect(started.ok()).toBe(true);
    expect((await getAgent(page, agent.id)).status).toBe("running");

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    // `components/terminal.tsx` prints the connection state under the viewport.
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 30000 });
  });

  test("injects a channel-style prompt onto the live PTY", async ({ page }) => {
    test.skip(!agentId, "No agent started");
    test.slow();
    await signInAsAdmin(page);

    const marker = `e2e-inject-${Date.now()}`;
    const res = await page.request.post(`${getBaseUrl()}/api/agents/${agentId}/inject`, {
      data: { text: marker, mode: "queue" },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBe(true);

    // Assert through the container, not through xterm: the terminal paints to a
    // canvas, so its contents are not readable from the DOM.
    //
    // The proof is the session JSONL rather than the echoed `> <line>`, because
    // that file is also what the sidecar tails — so a passing assertion here
    // means the bytes reached the CLI's stdin AND became a transcript event,
    // which is the whole path a channel mention depends on.
    const containerId = await getAgentContainerId(page, agentId);
    await expect
      .poll(
        async () =>
          (
            await execInContainer(containerId, [
              "sh",
              "-c",
              'cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/mock/*.jsonl 2>/dev/null || true',
            ])
          ).stdout,
        { timeout: 20000 },
      )
      .toContain(marker);
  });
});

/**
 * Destroying an agent, which moved here when the roster screen was folded into
 * the rail. It is confirmation-gated because it deletes the workspace and state
 * volumes — the one action in this pane that loses data on disk.
 */
test.describe("Destroy", () => {
  test("is confirmation-gated, and cancelling leaves the agent alone", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page, { displayName: "Destroy Probe" });

    try {
      await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Destroy Probe")).toBeVisible({ timeout: 15000 });

      await page.getByRole("tab", { name: "Settings" }).click();
      await page
        .getByRole("button", { name: /Destroy/ })
        .first()
        .click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The title names the agent, so a mis-scoped click is visible rather than
      // silently destroying the wrong one.
      await expect(dialog).toContainText(`@${agent.handle}`);

      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      expect(await getAgent(page, agent.id)).not.toBeNull();
    } finally {
      await deleteAgent(page, agent.id);
    }
  });
});
