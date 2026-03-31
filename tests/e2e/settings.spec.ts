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

  test("profile page shows display name and password forms", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/profile");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Display Name")).toBeVisible();
    await expect(page.getByText("Change Password")).toBeVisible();
    await expect(page.getByPlaceholder("Your name")).toBeVisible();
  });

  test("can update display name", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/profile");
    await page.waitForLoadState("networkidle");

    const nameInput = page.getByPlaceholder("Your name");
    await nameInput.clear();
    await nameInput.fill("Admin Updated");
    await page.getByRole("button", { name: /save/i }).click();
    await page.waitForTimeout(1000);

    // Restore original name
    await nameInput.clear();
    await nameInput.fill("Admin");
    await page.getByRole("button", { name: /save/i }).click();
  });

  test("docker settings shows connection status", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/docker");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Connection Status")).toBeVisible();
    // Should show either Connected or Disconnected with error message
    const connected = page.getByText("Connected");
    const disconnected = page.getByText("Disconnected");
    await expect(connected.or(disconnected)).toBeVisible({ timeout: 10000 });
  });

  test("docker settings shows containers and volumes sections", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/docker");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("[data-slot='card-title']", { hasText: "Active Containers" }),
    ).toBeVisible();
    await expect(page.locator("[data-slot='card-title']", { hasText: /^Volumes$/ })).toBeVisible();
  });

  test("coding agents page shows agent table", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/agents");
    await page.waitForLoadState("networkidle");

    await expect(
      page.locator("[data-slot='card-title']", { hasText: "Coding Agents" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /add agent/i })).toBeVisible();

    // Default seed agents should be present
    await expect(page.getByRole("cell", { name: "Claude Code", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Gemini", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Codex", exact: true })).toBeVisible();
  });

  test("users page shows user table with admin", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /add user/i })).toBeVisible();
    await expect(page.getByRole("cell", { name: "admin@blackhouse.local" })).toBeVisible();
  });

  test("can create and delete a user", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle");

    // Create user
    await page.getByRole("button", { name: /add user/i }).click();
    await page.waitForTimeout(500);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const inputs = dialog.locator("input");
    await inputs.nth(0).fill("Test User"); // Name
    await inputs.nth(1).fill("test-e2e@blackhouse.local"); // Email
    await inputs.nth(2).fill("teste2e"); // Username
    await inputs.nth(3).fill("testpass123"); // Password
    await dialog.getByRole("button", { name: /create user/i }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("cell", { name: "test-e2e@blackhouse.local" })).toBeVisible({
      timeout: 5000,
    });

    // Delete user — click the last button (trash) in the row
    const row = page.getByRole("row").filter({ hasText: "test-e2e@blackhouse.local" });
    await row.getByRole("button").last().click();
    await page.waitForTimeout(500);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^delete$/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("cell", { name: "test-e2e@blackhouse.local" })).not.toBeVisible({
      timeout: 5000,
    });
  });
});
