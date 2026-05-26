import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Dashboard", () => {
  test("shows dashboard page for logged in user", async ({ page }) => {
    await signInAsAdmin(page);
    // Post-#54: the dashboard page heading is now "Roster"; the CTA button
    // was renamed from "New Session" to "Hire Worker".
    await expect(page.getByRole("heading", { name: /roster/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /hire worker/i })).toBeVisible();
  });

  test("sidebar navigation works", async ({ page }) => {
    await signInAsAdmin(page);

    // Post-#48 (sidebar shell) + #54 (thematic rename): sidebar groups are
    // "Templates" + "Settings"; nav targets are "My Templates", "Roster",
    // "Profile", etc. Click sub-item links by accessible role for stability.
    // `exact: true` on "Profile" avoids matching the brand link or any chip
    // that may contain "profile" as a substring.
    await page.getByRole("link", { name: "My Templates", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/mine/, { timeout: 5000 });

    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile/, { timeout: 5000 });

    await page.getByRole("link", { name: "Roster", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 5000 });
  });

  test("hire worker dialog opens and has required fields", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByRole("button", { name: /hire worker/i }).click();
    await page.waitForTimeout(500);

    await expect(page.getByRole("heading", { name: "Hire a New Worker" })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByPlaceholder("My session")).toBeVisible();
    await expect(page.getByText("Agent Config", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("https://github.com/user/repo")).toBeVisible();
  });

  test("admin can toggle show all sessions", async ({ page }) => {
    await signInAsAdmin(page);
    await page.waitForLoadState("networkidle");

    // Admin should see the toggle
    const toggle = page.getByRole("switch");
    await expect(toggle).toBeVisible();
    // Toggle works — just verify the switch toggles without error
    await toggle.click();
    await page.waitForTimeout(300);
    await toggle.click();
    await page.waitForTimeout(300);
    // Page should still be functional
    await expect(page.getByRole("heading", { name: /roster/i })).toBeVisible();
  });

  test("theme toggle works", async ({ page }) => {
    await signInAsAdmin(page);

    // Theme toggle lives in the sidebar footer (`src/components/app-
    // sidebar.tsx` — Button with `aria-label="Toggle theme"`). Anchoring on
    // aria-label is stable against icon swaps (sun ↔ moon) and avoids the
    // pre-#50 catch-all `button:has(svg)` heuristic that started matching the
    // sidebar collapse trigger after the revamp.
    const themeButton = page.getByRole("button", { name: /toggle theme/i });
    await expect(themeButton).toBeVisible();

    await themeButton.click();
    await page.waitForTimeout(300);

    await expect(page.getByRole("heading", { name: /roster/i })).toBeVisible();
  });
});
