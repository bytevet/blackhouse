import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

// Post-#48 (sidebar app shell) + #54/#56 (thematic copy pass + Template rename):
// sidebar group is labeled "Templates"; nav targets are `My Templates` / `Public
// Templates` routing to /templates/mine and /templates/public. In-page dialog/
// heading copy ("New Template", "Edit Template", "Delete Template",
// "Browse templates...") is the canonical surface.

test.describe("Templates", () => {
  test("templates sidebar shows My + Public links", async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page.getByRole("link", { name: "My Templates" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Public Templates" })).toBeVisible();
  });

  test("new template button is visible", async ({ page }) => {
    await signInAsAdmin(page);
    await page.getByRole("link", { name: "My Templates" }).click();
    await expect(page).toHaveURL(/\/templates\/mine/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /new template/i })).toBeVisible();
  });

  test("can create, edit, and delete a template", async ({ page }) => {
    await signInAsAdmin(page);
    await page.getByRole("link", { name: "My Templates" }).click();
    await expect(page).toHaveURL(/\/templates\/mine/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    // Create
    await page.getByRole("button", { name: /new template/i }).click();
    await expect(page.getByRole("heading", { name: "New Template" })).toBeVisible({
      timeout: 5000,
    });
    await page.getByPlaceholder("Template name").fill("E2E Test Template");
    await page.getByPlaceholder("Brief description").fill("Created by e2e test");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /new template/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("E2E Test Template")).toBeVisible({ timeout: 5000 });

    // Edit
    await page
      .getByRole("button", { name: /^edit$/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Edit Template" })).toBeVisible({
      timeout: 5000,
    });
    const nameInput = page.getByPlaceholder("Template name");
    await nameInput.clear();
    await nameInput.fill("E2E Updated Template");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /update template/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("E2E Updated Template")).toBeVisible({ timeout: 5000 });

    // Delete
    await page
      .getByRole("button", { name: /^delete$/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Delete Template" })).toBeVisible({
      timeout: 5000,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^delete$/i })
      .click();
    await page.waitForLoadState("networkidle");
    // Use `toBeHidden` (polling) instead of `not.toBeVisible` (instantaneous-
    // at-eval) so the disappearance check survives slow list-refetches under
    // heavy parallel load (see task #32).
    await expect(page.getByText("E2E Updated Template", { exact: true })).toBeHidden({
      timeout: 10000,
    });
  });

  test("public templates page shows the description text", async ({ page }) => {
    await signInAsAdmin(page);
    await page.getByRole("link", { name: "Public Templates" }).click();
    await expect(page).toHaveURL(/\/templates\/public/, { timeout: 5000 });
    await expect(page.getByText("Browse templates shared by other users")).toBeVisible({
      timeout: 5000,
    });
  });
});
