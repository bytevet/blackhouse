import { test, expect, type Page } from "@playwright/test";

async function signUp(page: Page, suffix: string) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.locator("button", { hasText: /^Sign up$/ }).click();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Your name").fill(`Dashboard User ${suffix}`);
  await page.getByPlaceholder("you@example.com").fill(`dash-${suffix}@example.com`);
  await page.getByPlaceholder("username").fill(`dashuser${suffix}`);
  await page.getByPlaceholder("********").fill("TestPassword123!");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
}

test.describe("Dashboard", () => {
  test("shows dashboard page for logged in user", async ({ page }) => {
    await signUp(page, `${Date.now()}`);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /new session/i })).toBeVisible();
  });

  test("sidebar navigation works", async ({ page }) => {
    await signUp(page, `nav${Date.now()}`);

    // Navigate to Templates
    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });

    // Navigate to Settings
    await page.getByText("Settings").first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });

    // Navigate back to Dashboard
    await page.getByText("Dashboard").first().click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5000 });
  });

  test("new session dialog opens", async ({ page }) => {
    await signUp(page, `dialog${Date.now()}`);

    await page.getByRole("button", { name: /new session/i }).click();
    await page.waitForTimeout(500);

    // Dialog should be visible
    await expect(page.getByText("Create New Session")).toBeVisible({ timeout: 5000 });
  });
});
