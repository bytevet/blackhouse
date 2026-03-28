import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Settings", () => {
  test("settings page shows all admin tabs", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Settings").first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    await expect(page.getByText("Profile")).toBeVisible();
    await expect(page.getByText("Coding Agents")).toBeVisible();
    await expect(page.getByText("Docker")).toBeVisible();
    await expect(page.getByText("Users")).toBeVisible();
  });
});
