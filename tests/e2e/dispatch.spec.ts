import { test, expect, type Page } from "@playwright/test";
import { composer, getBaseUrl, signInAsAdmin } from "./helpers";

/**
 * The agent→agent dispatch card: a decision, not a notification.
 *
 * ⚠️ The card the UI renders comes from `components/channel/mock-data.ts` — one
 * pending request, `@scout → @reviewer`, expiring five minutes after mount.
 * Creating a real one requires an agent's own bearer token (issued to the
 * container, never returned by `GET /api/agents/:id`), so the pending →
 * approved / denied transitions are exercised through the UI's state machine
 * here and through the API's refusal paths at the bottom.
 *
 * State is per-page-load, so each test starts from the same pending card.
 */

const PENDING_EYEBROW = "Approval required · agent dispatch";
const MOCK_PROMPT = /Review the payments migration plan/;

async function openGeneral(page: Page) {
  await signInAsAdmin(page);
  await page.goto("/channels/general", { waitUntil: "domcontentloaded" });
  await expect(composer(page)).toBeVisible();
}

test.describe("Dispatch card", () => {
  test("a pending request shows the ask, the countdown and three ways out", async ({ page }) => {
    await openGeneral(page);

    await expect(page.getByText(PENDING_EYEBROW)).toBeVisible();
    await expect(page.getByText(MOCK_PROMPT)).toBeVisible();
    // A request that silently rots is worse than one that is refused, so the
    // expiry is a visible countdown rather than a tooltip.
    await expect(page.getByText(/expires in/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit & approve" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    // Where the work will actually run is stated on the card.
    await expect(page.getByText(/runs in @reviewer's sandbox/)).toBeVisible();
  });

  test("approving collapses the card to an auditable one-liner", async ({ page }) => {
    await openGeneral(page);

    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByText("Approved · agent dispatch")).toBeVisible();
    await expect(page.getByText(/Approved by Dana Okafor · dispatched to @reviewer/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

    // The decision is history now, but the record has to stay inspectable.
    await page.getByRole("button", { name: "show prompt" }).click();
    await expect(page.getByText(MOCK_PROMPT)).toBeVisible();
    await expect(page.getByRole("link", { name: /view run/ })).toBeVisible();
  });

  test("denying records who refused and notifies the asker", async ({ page }) => {
    await openGeneral(page);

    await page.getByRole("button", { name: "Deny" }).click();

    await expect(page.getByText("Denied · agent dispatch")).toBeVisible();
    await expect(page.getByText(/Denied by Dana Okafor · @scout notified/)).toBeVisible();
    // Denied never creates a run.
    await expect(page.getByRole("link", { name: /view run/ })).toHaveCount(0);
  });

  test("edit & approve stores the rewrite beside the original", async ({ page }) => {
    await openGeneral(page);

    await page.getByRole("button", { name: "Edit & approve" }).click();
    await expect(page.getByText("Editing prompt · agent dispatch")).toBeVisible();

    const prompt = page.getByLabel("Dispatch prompt");
    await expect(prompt).toBeVisible();
    await prompt.fill("Only check the webhook handler.");
    await page.getByRole("button", { name: "Approve edited" }).click();

    // "(edited)" is the flag that what ran is not what was asked for.
    await expect(page.getByText(/Approved by Dana Okafor .* \(edited\)/)).toBeVisible();
    await page.getByRole("button", { name: "show prompt" }).click();
    await expect(page.getByText("Only check the webhook handler.")).toBeVisible();
  });

  test("cancelling an edit restores the original prompt", async ({ page }) => {
    await openGeneral(page);

    await page.getByRole("button", { name: "Edit & approve" }).click();
    await page.getByLabel("Dispatch prompt").fill("something else entirely");
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByText(PENDING_EYEBROW)).toBeVisible();
    await expect(page.getByText(MOCK_PROMPT)).toBeVisible();
  });

  test("auto-approve removes the hold but keeps the record", async ({ page }) => {
    await openGeneral(page);
    await expect(page.getByText(PENDING_EYEBROW)).toBeVisible();

    await page.getByRole("button", { name: "Channel settings" }).click();
    await page.getByRole("switch", { name: "Auto-approve dispatches" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on auto-approve" }).click();

    // The card is still written — auto-approve removes the hold, not the
    // record — but it is now an after-the-fact note in the info tone.
    await expect(page.getByText("Auto-approved · agent dispatch")).toBeVisible();
    await expect(
      page.getByText(/Auto-approved · dispatched to @reviewer with no hold/),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(page.getByText("override in channel settings")).toBeVisible();
  });
});

/**
 * The server-side state machine, from the outside. Creating a dispatch needs an
 * agent bearer token, so what is reachable here is the listing and the refusal
 * paths — both of which are the ones that protect the human gate.
 */
test.describe("Dispatch API", () => {
  const MISSING = "00000000-0000-4000-8000-000000000000";

  test("listing dispatches is authenticated and filterable", async ({ page }) => {
    await signInAsAdmin(page);

    const all = await page.request.get(`${getBaseUrl()}/api/dispatches`, {
      failOnStatusCode: false,
    });
    expect(all.ok()).toBe(true);
    expect(Array.isArray(await all.json())).toBe(true);

    const pending = await page.request.get(`${getBaseUrl()}/api/dispatches?status=pending`, {
      failOnStatusCode: false,
    });
    expect(pending.ok()).toBe(true);
    for (const row of (await pending.json()) as Array<{ status: string }>) {
      expect(row.status).toBe("pending");
    }
  });

  test("approving or denying an unknown dispatch is a conflict, not a 500", async ({ page }) => {
    await signInAsAdmin(page);

    const approve = await page.request.post(`${getBaseUrl()}/api/dispatches/${MISSING}/approve`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(approve.status()).toBe(409);
    expect((await approve.json()).error).toMatch(/not found/i);

    const deny = await page.request.post(`${getBaseUrl()}/api/dispatches/${MISSING}/deny`, {
      data: {},
      failOnStatusCode: false,
    });
    expect(deny.status()).toBe(409);
  });
});
