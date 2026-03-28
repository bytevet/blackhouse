import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Templates", () => {
  test("templates page shows tabs", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("My Templates")).toBeVisible();
    await expect(page.getByText("Public Templates")).toBeVisible();
  });

  test("new template button is visible", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /new template/i })).toBeVisible();
  });
});
