import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

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
  });

  test("no sign-up option is available", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Sign up")).not.toBeVisible();
    await expect(page.getByText("Create your account")).not.toBeVisible();
  });

  test("can sign in with admin credentials", async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("username").fill("nonexistent_user");
    await page.getByPlaceholder("********").fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/login/);
  });
});
