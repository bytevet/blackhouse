import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("unauthenticated users are redirected to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login page renders correctly", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Blackhouse" })).toBeVisible();
    await expect(page.getByPlaceholder("username")).toBeVisible();
    await expect(page.getByPlaceholder("********")).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /github/i })).toBeVisible();
  });

  test("can toggle between sign in and sign up", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Click the "Sign up" toggle button
    await page.locator("button", { hasText: /^Sign up$/ }).click();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder("Your name")).toBeVisible();

    // Toggle back
    await page.locator("button", { hasText: /^Sign in$/ }).click();
    await expect(page.getByText("Sign in to your account")).toBeVisible({ timeout: 5000 });
  });

  test("can sign up a new user", async ({ page }) => {
    const ts = Date.now();
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Switch to sign up
    await page.locator("button", { hasText: /^Sign up$/ }).click();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });

    // Fill the form
    await page.getByPlaceholder("Your name").fill(`Test User ${ts}`);
    await page.getByPlaceholder("you@example.com").fill(`test-${ts}@example.com`);
    await page.getByPlaceholder("username").fill(`testuser${ts}`);
    await page.getByPlaceholder("********").fill("TestPassword123!");

    // Submit
    await page.getByRole("button", { name: /create account/i }).click();

    // Should redirect to dashboard
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });

  test("can sign in with created user", async ({ page }) => {
    const ts = Date.now();

    // First create a user
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.locator("button", { hasText: /^Sign up$/ }).click();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("Your name").fill(`Login Test ${ts}`);
    await page.getByPlaceholder("you@example.com").fill(`login-${ts}@example.com`);
    await page.getByPlaceholder("username").fill(`loginuser${ts}`);
    await page.getByPlaceholder("********").fill("TestPassword123!");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

    // Clear cookies and go back to login
    await page.context().clearCookies();
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Sign in
    await page.getByPlaceholder("username").fill(`loginuser${ts}`);
    await page.getByPlaceholder("********").fill("TestPassword123!");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("username").fill("nonexistent_user");
    await page.getByPlaceholder("********").fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should stay on login page
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/login/);
  });
});
