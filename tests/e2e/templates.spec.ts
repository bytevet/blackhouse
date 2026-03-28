import { test, expect, type Page } from "@playwright/test";

async function signUp(page: Page, suffix: string) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.locator("button", { hasText: /^Sign up$/ }).click();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder("Your name").fill(`Template User ${suffix}`);
  await page.getByPlaceholder("you@example.com").fill(`tmpl-${suffix}@example.com`);
  await page.getByPlaceholder("username").fill(`tmpluser${suffix}`);
  await page.getByPlaceholder("********").fill("TestPassword123!");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
}

test.describe("Templates", () => {
  test("templates page shows tabs", async ({ page }) => {
    await signUp(page, `${Date.now()}`);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("My Templates")).toBeVisible();
    await expect(page.getByText("Public Templates")).toBeVisible();
  });

  test("new template button is visible", async ({ page }) => {
    await signUp(page, `btn${Date.now()}`);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /new template/i })).toBeVisible();
  });
});
