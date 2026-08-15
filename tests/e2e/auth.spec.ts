import { test, expect } from "@playwright/test";
import { composer, signInAsAdmin } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Auth is the one part of the harness the domain rewrite did not touch — Better
 * Auth, username/password plus optional GitHub. What changed underneath it is
 * where a signed-in user lands: `/channels`, not `/dashboard`.
 */
test.describe("Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // globalSetup's storage state (which carries the lang lock) is discarded on
    // this file, so pin the locale per-context instead.
    await page.addInitScript(() => localStorage.setItem("blackhouse-lang", "en"));
  });

  test("unauthenticated users are redirected to /login with the target preserved", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fagents/);
  });

  test("the catch-all route sends an unauthenticated visitor to /login", async ({ page }) => {
    // `*` → /channels → the auth gate. `/dashboard` is a dead route now; this
    // asserts it does not 404 or render stale chrome on the way.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login page renders correctly", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Blackhouse", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("username")).toBeVisible();
    await expect(page.getByPlaceholder("********")).toBeVisible();
    await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
  });

  test("no sign-up option is available", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Sign up")).toHaveCount(0);
    await expect(page.getByText("Create your account")).toHaveCount(0);
    // The copy states the policy rather than offering a link.
    await expect(page.getByText(/invite-only per workspace/i)).toBeVisible();
  });

  test("can sign in with admin credentials and lands in #general", async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page).toHaveURL(/\/channels\/general/);
    await expect(composer(page)).toBeVisible();
  });

  test("shows an error on invalid credentials", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");
    await page.getByPlaceholder("username").fill("nonexistent_user");
    await page.getByPlaceholder("********").fill("wrongpassword");
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // `Alert tone="danger"` renders `role="alert"` (NotYet UI).
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
