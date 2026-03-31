import type { Page } from "@playwright/test";

/**
 * Get the base URL for API calls.
 */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || "http://localhost:5173";
}

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

/**
 * Create a new session from the dashboard.
 * Picks the first available built agent.
 * Returns the session ID from the URL.
 */
export async function createSession(page: Page, name: string): Promise<string> {
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /new session/i }).click();
  await page.waitForTimeout(500);

  await page.getByLabel("Name").fill(name);

  // Select first available agent
  await page.getByText("Coding Agent").click();
  await page.waitForTimeout(300);
  // Click the first non-disabled option in the select dropdown
  const agentOption = page.locator("[role=option]").first();
  await agentOption.click();

  await page.getByRole("button", { name: /create session/i }).click();

  // Wait for navigation to session page
  await page.waitForURL(/\/sessions\//, { timeout: 30000 });

  const url = page.url();
  const match = url.match(/\/sessions\/([a-f0-9-]+)/);
  return match?.[1] ?? "";
}
