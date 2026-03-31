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

  test("new session dialog opens and has required fields", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByRole("button", { name: /new session/i }).click();
    await page.waitForTimeout(500);

    await expect(page.getByRole("heading", { name: "Create New Session" })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByPlaceholder("My session")).toBeVisible();
    await expect(page.getByText("Coding Agent", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("https://github.com/user/repo")).toBeVisible();
  });

  test("admin can toggle show all sessions", async ({ page }) => {
    await signInAsAdmin(page);

    // Admin should see the toggle
    const toggle = page.getByRole("switch");
    await expect(toggle).toBeVisible();
    await expect(page.getByText("My sessions")).toBeVisible();

    // Toggle on
    await toggle.click();
    await expect(page.getByText("Show all sessions")).toBeVisible();

    // Toggle off
    await toggle.click();
    await expect(page.getByText("My sessions")).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await signInAsAdmin(page);

    // Find the theme toggle button (sun/moon icon)
    const themeButton = page
      .locator("button")
      .filter({ has: page.locator("svg") })
      .first();
    await expect(themeButton).toBeVisible();

    // Click should toggle theme without errors
    await themeButton.click();
    await page.waitForTimeout(300);

    // Page should still be functional
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });
});
