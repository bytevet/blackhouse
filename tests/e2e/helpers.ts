import type { Page } from "@playwright/test";

/**
 * Sign in with the admin user.
 * Uses E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD env vars,
 * falling back to the seed defaults: admin / admin123
 */
export async function signInAsAdmin(page: Page) {
  const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "admin123";

  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
}
