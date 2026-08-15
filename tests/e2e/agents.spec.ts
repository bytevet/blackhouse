import { test, expect, type Page } from "@playwright/test";
import {
  createAgent,
  deleteAgent,
  listAgents,
  signInAsAdmin,
  uniqueHandle,
  type AgentSummary,
} from "./helpers";

/**
 * The roster (`/agents`) and the create-agent wizard (`/agents/new`).
 *
 * None of this needs Docker. `POST /api/agents` only writes the row with
 * `status: "creating"`; the container is not built until `POST
 * /api/agents/:id/start`, and `DELETE` force-removes a container only when one
 * exists. Everything below therefore runs unconditionally.
 */

/**
 * The roster card for one agent.
 *
 * Cards are plain divs with no test id (see the handover note), so the card is
 * identified structurally: the innermost div that contains the agent's
 * `/agents/:id` links, its `@handle`, *and* its action buttons. That is the
 * card and its enclosing grid; `.last()` takes the card. Add
 * `data-testid={"agent-card-" + agent.id}` in `src/pages/agents.tsx` and this
 * collapses to one line.
 */
function agentCard(page: Page, agent: AgentSummary) {
  return page
    .locator("div")
    .filter({ has: page.locator(`a[href="/agents/${agent.id}"]`) })
    .filter({ hasText: `@${agent.handle}` })
    .filter({ has: page.getByRole("button", { name: "Destroy" }) })
    .last();
}

test.describe("Roster", () => {
  test("the legacy /dashboard route lands a signed-in user in #general", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    // `*` → /channels → /channels/general (`src/App.tsx`). The roster moved to
    // /agents; /dashboard resolves to nothing of its own any more.
    await expect(page).toHaveURL(/\/channels\/general/);
  });

  test("renders the roster shell", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Roster", level: 1 })).toBeVisible();
    // Two "New agent" affordances: the header CTA and the dashed tile.
    await expect(page.getByRole("button", { name: "New agent" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Workspace/ })).toBeVisible();
  });

  test("shows container status and process activity as two independent signals", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page, { displayName: "Roster Probe" });

    try {
      await page.goto("/agents", { waitUntil: "domcontentloaded" });
      const card = agentCard(page, agent);
      await expect(card).toBeVisible();

      // `status` is the container. It is drawn as a dot on the avatar whose
      // `title` is the localized label — a fresh row is `creating`.
      await expect(card.locator('[title="Creating"]')).toBeVisible();
      // `activity` is the process inside it, drawn as a separate pill. A fresh
      // row is `idle` — a creating container with an idle process is a legal
      // combination, which is exactly why these are two fields.
      await expect(card).toContainText("idle");
      await expect(card).toContainText("Roster Probe");
      await expect(card.getByRole("link", { name: `@${agent.handle}`, exact: true })).toBeVisible();
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("destroying an agent is confirmation-gated", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      await page.goto("/agents", { waitUntil: "domcontentloaded" });
      const card = agentCard(page, agent);
      await expect(card).toBeVisible();

      await card.getByRole("button", { name: "Destroy" }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Destroy this agent?");
      // The body names the agent, so a mis-scoped click is visible rather than
      // silently destroying the wrong one.
      await expect(dialog).toContainText(`@${agent.handle}`);

      // Cancel leaves it alone.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      expect((await listAgents(page)).some((a) => a.id === agent.id)).toBe(true);

      // Confirming removes it. Destroy is Docker-free for an agent that never
      // got a container: `destroyAgent` skips the driver when `containerId` is
      // null and just flips the row to `destroyed`.
      await card.getByRole("button", { name: "Destroy" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Destroy", exact: true }).click();

      await expect(card).toHaveCount(0, { timeout: 10000 });
      expect((await listAgents(page)).some((a) => a.id === agent.id)).toBe(false);
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("theme toggle flips the document theme", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents", { waitUntil: "domcontentloaded" });

    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(before);
    await expect(page.getByRole("heading", { name: "Roster", level: 1 })).toBeVisible();
  });
});

test.describe("Create-agent wizard", () => {
  test("step 1 lists the seeded blueprints and gates Continue", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents/new", { waitUntil: "domcontentloaded" });

    // Seeded by `server/db/seed.ts`.
    await expect(page.getByRole("button", { name: /Claude Code/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Codex/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Antigravity/ })).toBeVisible();

    const cont = page.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();

    const claude = page.getByRole("button", { name: /Claude Code/ });
    await claude.click();
    await expect(claude).toHaveAttribute("aria-pressed", "true");
    await expect(cont).toBeEnabled();
  });

  test("rejects an invalid handle before touching the API", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents/new", { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: /Claude Code/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Handle").fill("Not A Handle");
    await page.getByLabel("Display name").fill("Nope");
    await page.getByRole("button", { name: "Create agent" }).click();

    // Client-side zod mirrors `handleSchema` in `server/api/agents.ts`.
    await expect(page.getByText(/Lowercase letters, digits/)).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/new/);
  });

  test("creates an agent and opens its detail page", async ({ page }) => {
    await signInAsAdmin(page);
    const handle = uniqueHandle();
    let createdId = "";

    try {
      await page.goto("/agents/new", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /Claude Code/ }).click();
      await page.getByRole("button", { name: "Continue" }).click();

      await page.getByLabel("Handle", { exact: true }).fill(handle);
      await page.getByLabel("Display name", { exact: true }).fill("Wizard Agent");
      await page.getByRole("button", { name: "Create agent" }).click();

      await page.waitForURL(/\/agents\/[0-9a-f-]{36}/, { timeout: 15000 });
      createdId = page.url().match(/\/agents\/([0-9a-f-]{36})/)?.[1] ?? "";
      expect(createdId).toBeTruthy();

      // The detail page's breadcrumb and header both carry the handle.
      await expect(page.getByText(`@${handle}`).first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByText("Wizard Agent")).toBeVisible();
    } finally {
      if (createdId) await deleteAgent(page, createdId);
    }
  });
});
