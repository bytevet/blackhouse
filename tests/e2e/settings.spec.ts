import { test, expect, type Page } from "@playwright/test";

async function signUp(page: Page, suffix: string) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.locator("button", { hasText: /^Sign up$/ }).click();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Your name").fill(`Settings User ${suffix}`);
  await page.getByPlaceholder("you@example.com").fill(`settings-${suffix}@example.com`);
  await page.getByPlaceholder("username").fill(`setuser${suffix}`);
  await page.getByPlaceholder("********").fill("TestPassword123!");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
}

test.describe("Settings", () => {
  test("settings page shows profile tab", async ({ page }) => {
    await signUp(page, `${Date.now()}`);

    await page.getByText("Settings").first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    await expect(page.getByText("Profile")).toBeVisible();
  });

  test("normal user cannot see admin tabs", async ({ page }) => {
    await signUp(page, `noadmin${Date.now()}`);

    await page.getByText("Settings").first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    // Admin-only tabs should not be visible for regular users
    await expect(page.locator("[data-value='agents']")).not.toBeVisible();
    await expect(page.locator("[data-value='docker']")).not.toBeVisible();
    await expect(page.locator("[data-value='users']")).not.toBeVisible();
  });
});
