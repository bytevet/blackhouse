import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Dashboard", () => {
  test("shows dashboard page for logged in user", async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /new session/i })).toBeVisible();
  });

  test("sidebar navigation works", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });

    await page.getByText("Settings").first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });

    await page.getByText("Dashboard").first().click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5000 });
  });

  test("new session dialog opens", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByRole("button", { name: /new session/i }).click();
    await page.waitForTimeout(500);

    await expect(page.getByText("Create New Session")).toBeVisible({ timeout: 5000 });
  });
});
