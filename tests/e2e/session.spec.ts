import { test, expect } from "@playwright/test";
import { signInAsAdmin, createSession, getBaseUrl } from "./helpers";

test.describe.serial("Session lifecycle", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  let sessionId: string;

  test("can create a new session", async ({ page }) => {
    await signInAsAdmin(page);

    sessionId = await createSession(page, "E2E Session");
    expect(sessionId).toBeTruthy();

    // Should navigate to session page
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`), { timeout: 15000 });
    await expect(page.getByText("E2E Session")).toBeVisible();
  });

  test("session page shows terminal", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("E2E Session")).toBeVisible();
    // Terminal should connect
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 15000 });
  });

  test("can toggle file explorer", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    // Open file explorer
    const filesButton = page.getByRole("button", { name: /files/i });
    await filesButton.click();
    await expect(page.getByText("File Explorer")).toBeVisible({ timeout: 5000 });

    // Close file explorer
    await page.getByRole("button", { name: /hide panel/i }).click();
    await expect(page.getByText("File Explorer")).not.toBeVisible();
  });

  test("can stop a session", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /stop/i }).click();
    // Confirm dialog
    await expect(page.getByText("Stop Session")).toBeVisible({ timeout: 5000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^stop$/i })
      .click();

    await expect(page.getByText("stopped")).toBeVisible({ timeout: 15000 });
  });

  test("can destroy a session", async ({ page }) => {
    test.skip(!sessionId, "No session created");
    await signInAsAdmin(page);

    await page.goto(`/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /destroy/i }).click();
    await expect(page.getByText("Destroy Session")).toBeVisible({ timeout: 5000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^destroy$/i })
      .click();

    // Should redirect to dashboard
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });
});

test.describe("WebSocket terminal", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("terminal WebSocket connects and receives data", async ({ page }) => {
    await signInAsAdmin(page);

    const sessionId = await createSession(page, "WS Test");
    await page.goto(`/sessions/${sessionId}`);

    // Wait for terminal to connect
    await expect(page.getByText("Connected")).toBeVisible({ timeout: 15000 });

    // Terminal should have rendered some output (prompt or agent output)
    await page.waitForTimeout(3000);

    // The terminal canvas should exist
    const terminal = page.locator(".xterm-screen");
    await expect(terminal).toBeVisible();

    // Clean up
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
  });
});

test.describe("API health", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const baseUrl = getBaseUrl();
    const response = await request.get(`${baseUrl}/api/health`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeTruthy();
  });

  test("unauthenticated API returns 401", async ({ request }) => {
    const baseUrl = getBaseUrl();
    const response = await request.get(`${baseUrl}/api/sessions`);
    expect(response.status()).toBe(401);
  });
});
