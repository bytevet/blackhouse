import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Settings", () => {
  test("settings sidebar lists all admin items", async ({ page }) => {
    await signInAsAdmin(page);
    // Post-#48: the "Settings" sub-nav is now in the left sidebar; the
    // page-level Settings heading was removed (per fe's follow-up). Assert
    // the sidebar lists the admin Settings items.
    // Post-#54 thematic rename: sidebar admin items are "Profile" / "Roles"
    // (was "Coding Agents") / "Docker" / "Team" (was "Users"). `exact: true`
    // avoids substring collisions with the brand link "Blackhouse Coding
    // agents" and similar tagline copy elsewhere on the page.
    await expect(page.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Agent Configs", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Docker", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Team", exact: true })).toBeVisible();
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

    // Post-#56: CardTitle reads "Agent Configs" (was "Roles" briefly under
    // the workforce rename, but "Role" implied a job function; the things
    // here are actually tool/CLI configs). Button is "Add Agent Config".
    await expect(
      page.locator("[data-slot='card-title']", { hasText: "Agent Configs" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /add agent config/i })).toBeVisible();

    // Default seed agents (their `name` field in agent_configs) should be
    // present in the table. The agent names themselves aren't renamed —
    // only the page chrome that wraps them.
    await expect(page.getByRole("cell", { name: "Claude Code", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Antigravity", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Codex", exact: true })).toBeVisible();
  });

  test("users page shows user table with admin", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle");

    // Post-#54: button "Add User" → "Onboard User".
    await expect(page.getByRole("button", { name: /onboard user/i })).toBeVisible();
    await expect(page.getByRole("cell", { name: "admin@blackhouse.local" })).toBeVisible();
  });

  test("can create and delete a user", async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto("/settings/users");
    await page.waitForLoadState("networkidle");

    // Post-#54: "Add User" → "Onboard User"; delete-confirm title is now
    // "Off-board User" with primary button "Off-board". The "Create User"
    // submit button in the create-dialog was NOT renamed — leaving it as-is
    // matches the actual source.
    await page.getByRole("button", { name: /onboard user/i }).click();
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

    // Delete user — click the last button (trash) in the row, then the
    // "Off-board" confirm button.
    const row = page.getByRole("row").filter({ hasText: "test-e2e@blackhouse.local" });
    await row.getByRole("button").last().click();
    await page.waitForTimeout(500);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^off-board$/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("cell", { name: "test-e2e@blackhouse.local" })).not.toBeVisible({
      timeout: 5000,
    });
  });
});
