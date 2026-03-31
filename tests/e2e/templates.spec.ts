import { test, expect } from "@playwright/test";
import { signInAsAdmin } from "./helpers";

test.describe("Templates", () => {
  test("templates page shows tabs", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("My Templates")).toBeVisible();
    await expect(page.getByText("Public Templates")).toBeVisible();
  });

  test("new template button is visible", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /new template/i })).toBeVisible();
  });

  test("can create, edit, and delete a template", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    // Create
    await page.getByRole("button", { name: /new template/i }).click();
    await expect(page.getByRole("heading", { name: "Create Template" })).toBeVisible({
      timeout: 5000,
    });
    await page.getByPlaceholder("Template name").fill("E2E Test Template");
    await page.getByPlaceholder("Brief description").fill("Created by e2e test");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /create template/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("E2E Test Template")).toBeVisible({ timeout: 5000 });

    // Edit
    await page
      .getByRole("button", { name: /^edit$/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Edit Template" })).toBeVisible({
      timeout: 5000,
    });
    const nameInput = page.getByPlaceholder("Template name");
    await nameInput.clear();
    await nameInput.fill("E2E Updated Template");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /update template/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("E2E Updated Template")).toBeVisible({ timeout: 5000 });

    // Delete
    await page
      .getByRole("button", { name: /^delete$/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Delete Template" })).toBeVisible({
      timeout: 5000,
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^delete$/i })
      .click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("E2E Updated Template", { exact: true })).not.toBeVisible({
      timeout: 5000,
    });
  });

  test("public templates tab shows public templates", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByText("Templates").first().click();
    await expect(page).toHaveURL(/\/templates/, { timeout: 5000 });
    await page.waitForLoadState("networkidle");

    await page.getByText("Public Templates").click();
    await expect(page.getByText("Browse templates shared by other users")).toBeVisible({
      timeout: 5000,
    });
  });
});
