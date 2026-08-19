import { test, expect, type Page } from "@playwright/test";
import { createAgent, deleteAgent, signInAsAdmin, uniqueHandle } from "./helpers";

/**
 * Rail rows are whole-row links, so their accessible name is everything inside
 * them: a channel is `"general"` (the `#` is aria-hidden) and an agent is
 * `"SC@scoutidlerunning"` — avatar initials, handle, activity and status run
 * together. Neither is worth pinning, so channels anchor on the start of the
 * name and agents go by href.
 */
function channelLink(page: Page, slug: string) {
  return page.getByRole("link", { name: new RegExp(`^${slug}\\b`) });
}

/**
 * The app shell — the rail, and the rooms that render inside it.
 *
 * Replaces the old roster spec. `/agents` was a screen of its own with a card
 * grid; it is now the rail, and opening an agent swaps the content area rather
 * than the page. The cases that survived from that spec were the ones about
 * behaviour rather than about the card: the two independent status signals, the
 * theme toggle, and the whole create-agent wizard.
 *
 * None of this needs Docker. `POST /api/agents` only writes the row with
 * `status: "creating"`; the container is not built until `POST
 * /api/agents/:id/start`.
 */

test.describe("Shell", () => {
  test("the legacy /dashboard route lands a signed-in user in #general", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/channels\/general/);
  });

  test("/agents redirects to the workspace now that the roster is the rail", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/channels\/general/);
  });

  test("the rail carries both channels and the roster", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/channels/general", { waitUntil: "domcontentloaded" });

    const rail = page.locator("aside");
    await expect(rail).toBeVisible();
    await expect(rail).toContainText("Channels");
    await expect(rail).toContainText("Agents");
    await expect(channelLink(page, "general")).toBeVisible();
  });

  test("opening an agent keeps the rail and swaps only the content area", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page, { displayName: "Shell Probe" });

    try {
      await page.goto("/channels/general", { waitUntil: "domcontentloaded" });
      const rail = page.locator("aside");
      await expect(rail.locator(`a[href="/agents/${agent.id}"]`)).toBeVisible();

      // The composer is the channel's; its absence is how we know the room
      // changed rather than merely gained something.
      await expect(page.locator('textarea[placeholder^="Message #"]')).toBeVisible();

      await rail.locator(`a[href="/agents/${agent.id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));

      // This is the whole point of the change: the rail survives the move.
      await expect(rail).toBeVisible();
      await expect(rail.locator(`a[href="/agents/${agent.id}"]`)).toBeVisible();
      await expect(page.locator('textarea[placeholder^="Message #"]')).toHaveCount(0);

      // And back returns you to the transcript you left.
      await page.goBack();
      await expect(page).toHaveURL(/\/channels\/general/);
      await expect(page.locator('textarea[placeholder^="Message #"]')).toBeVisible();
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("shows container status and process activity as two independent signals", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page, { displayName: "Roster Probe" });

    try {
      await page.goto("/channels/general", { waitUntil: "domcontentloaded" });
      const row = page.locator(`aside a[href="/agents/${agent.id}"]`);
      await expect(row).toBeVisible();

      // `status` is the container, drawn as a dot on the avatar. Its tooltip
      // carries both signals in one string — `"creating container · unknown"` —
      // so match the prefix rather than pinning the whole sentence.
      await expect(row.locator('[title^="creating container"]')).toBeVisible();
      // `activity` is the process inside it, rendered as its own pill. A fresh
      // row is `unknown`: nothing has reported on the process yet, which is a
      // different claim from `idle` and must not be asserted as one.
      await expect(row).toContainText("unknown");
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("the sidebar collapses to a rail and remembers it", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/channels/general", { waitUntil: "domcontentloaded" });

    const rail = page.locator("aside");
    const width = () => rail.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(await width()).toBeGreaterThan(200);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(width).toBeLessThan(100);

    // Surviving a reload is the point of persisting it — a control that snaps
    // back reads as broken rather than optional.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(width).toBeLessThan(100);

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect.poll(width).toBeGreaterThan(200);
  });

  test("theme toggle flips the document theme", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/channels/general", { waitUntil: "domcontentloaded" });

    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole("button", { name: /theme/i }).first().click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(before);
    await expect(page.locator("aside")).toBeVisible();
  });
});

test.describe("Create-agent dialog", () => {
  test("opens over the room you were in and returns to it", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/channels/general", { waitUntil: "domcontentloaded" });

    await page.locator('aside a[href="/agents/new"]').first().click();
    await expect(page).toHaveURL(/\/agents\/new$/);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The room is still mounted behind it — that is what makes it a modal
    // rather than a screen that replaced the one you were on.
    await expect(page.locator('textarea[placeholder^="Message #"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/channels\/general/);
  });

  test("opens on a direct load, over the default channel", async ({ page }) => {
    // Regression: the fallback background pointed at `/channels`, which
    // redirects — and a `<Navigate>` behind the modal rewrote the URL, so the
    // dialog silently never rendered for anyone pasting the link.
    await signInAsAdmin(page);
    await page.goto("/agents/new", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/new$/);
  });

  test("step 1 lists the seeded blueprints and gates Continue", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/agents/new", { waitUntil: "domcontentloaded" });

    // Seeded by `server/db/seed.ts`.
    await expect(page.getByRole("button", { name: /Claude Code/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Codex/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Antigravity/ })).toBeVisible();

    const cont = page.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();
    await page.getByRole("button", { name: /Claude Code/ }).click();
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

    // Still on the form, and no agent was created.
    await expect(page).toHaveURL(/\/agents\/new$/);
  });

  test("creates an agent and opens its pane", async ({ page }) => {
    await signInAsAdmin(page);
    const handle = uniqueHandle();

    await page.goto("/agents/new", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Claude Code/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Handle").fill(handle);
    await page.getByLabel("Display name").fill("Created By Test");
    await page.getByRole("button", { name: "Create agent" }).click();

    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 15000 });
    // The rail is still there — the new agent opened as a room, not a page.
    await expect(page.locator("aside")).toBeVisible();

    const id = new URL(page.url()).pathname.split("/").pop()!;
    await deleteAgent(page, id);
  });
});
