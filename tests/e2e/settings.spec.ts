import { test, expect, type Page } from "@playwright/test";
import { createAgent, deleteAgent, signInAsAdmin } from "./helpers";

/**
 * Workspace settings: Blueprints, Sandbox runtimes, Egress allowlist, Members,
 * Profile. `/settings/agents`, `/settings/docker` and `/settings/users` are
 * gone — blueprints replaced agent configs, and the docker screen split into
 * the runtimes and egress pages.
 *
 * None of this needs Docker. Runtimes is the one screen that talks to the
 * daemon, and it is written to stay honest when the daemon is missing, which is
 * why its assertion accepts either answer.
 *
 * Every `getByLabel` here passes `exact: true`: the default is a
 * case-insensitive substring, and "Name" is a substring of "Username" (and
 * "New password" of "Confirm new password").
 */

/**
 * A settings card, located through the text it carries plus an action it owns.
 * Cards are plain divs with no test id (see the handover note); the innermost
 * div satisfying both filters is the card.
 */
function card(page: Page, text: string, actionName: string) {
  return page
    .locator("div")
    .filter({ hasText: text })
    .filter({ has: page.getByRole("button", { name: actionName }) })
    .last();
}

test.describe("Settings shell", () => {
  test("/settings lands on Blueprints and the rail lists every section", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/settings\/blueprints/);

    const rail = page.getByRole("navigation", { name: "workspace settings" });
    for (const label of [
      "Blueprints",
      "Sandbox runtimes",
      "Egress allowlist",
      "Members",
      "Profile",
    ]) {
      await expect(rail.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // The rail is `NavLink`s, not a tablist: these are real routes with URLs.
    await rail.getByRole("link", { name: "Members", exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/members/);
  });
});

test.describe("Blueprints", () => {
  test("lists the seeded blueprints", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/blueprints", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Blueprints", level: 1 })).toBeVisible();
    for (const name of ["Claude Code", "Codex", "Antigravity"]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    // The CLI is on the card because it is also the sidecar adapter key: it
    // decides how this agent's transcript is read back into a channel.
    await expect(page.getByText("claude-code", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New blueprint" }).first()).toBeVisible();
  });

  test("create, rename and delete a blueprint", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/blueprints", { waitUntil: "domcontentloaded" });

    const name = "E2E Blueprint";
    const renamed = "E2E Blueprint Renamed";

    await page.getByRole("button", { name: "New blueprint" }).first().click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Create" }).click();

    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 10000 });
    // A fresh blueprint has no image, and the card says so rather than letting
    // an operator assume one exists.
    await expect(card(page, name, "Edit")).toContainText("not built");

    await card(page, name, "Edit").getByRole("button", { name: "Edit" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(renamed);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(renamed, { exact: true })).toBeVisible({ timeout: 10000 });

    await card(page, renamed, "Delete").getByRole("button", { name: "Delete" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Delete this blueprint?");
    // Agents already spawned from it keep running — the dialog says so.
    await expect(dialog).toContainText(/keep running/);
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe("Sandbox runtimes", () => {
  test("reports what the host can run, or why it cannot say", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/runtimes", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Sandbox runtimes", level: 1 })).toBeVisible();

    // Unavailable runtimes stay listed and greyed rather than hidden, and a
    // daemon that cannot be reached is stated outright. Either is correct;
    // silence is not.
    const listed = page.getByText("gVisor", { exact: true });
    const failed = page.getByText("Could not reach the container daemon");
    await expect(listed.or(failed).first()).toBeVisible({ timeout: 15000 });
  });
});

test.describe("Egress allowlist", () => {
  test("labels the allowlist as blueprint defaults, not enforcement", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/egress", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Egress allowlist", level: 1 })).toBeVisible();
    // An editable table backed by nothing would let an operator add a host, see
    // it listed, and believe an agent could reach it.
    await expect(page.getByText("Not enforced yet")).toBeVisible();
  });
});

test.describe("Members", () => {
  test("humans and agents share the list but are badged apart", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page, { displayName: "Member Probe" });

    try {
      await page.goto("/settings/members", { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
      await expect(page.getByText("admin@blackhouse.local")).toBeVisible();
      await expect(page.getByText(`@${agent.handle}`, { exact: true })).toBeVisible();

      // Badged apart because only a human can approve an agent→agent dispatch.
      await expect(page.getByText("agent", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("human", { exact: true }).first()).toBeVisible();
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("add and remove a member", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/members", { waitUntil: "domcontentloaded" });

    const stamp = Date.now().toString(36);
    const email = `e2e-member-${stamp}@blackhouse.local`;

    await page.getByRole("button", { name: "Add member" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("E2E Member");
    await dialog.getByLabel("Username", { exact: true }).fill(`e2e${stamp}`);
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await dialog.getByLabel("Starting password", { exact: true }).fill("e2e-password-1234");
    await dialog.getByRole("button", { name: "Create member" }).click();

    await expect(page.getByText(email)).toBeVisible({ timeout: 10000 });

    await page
      .locator("div")
      .filter({ hasText: email })
      .filter({ has: page.getByRole("button", { name: "Remove" }) })
      .last()
      .getByRole("button", { name: "Remove" })
      .click();

    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remove this member?");
    await dialog.getByRole("button", { name: "Remove" }).click();

    await expect(page.getByText(email)).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe("Profile", () => {
  test("display name round-trips through the server", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });

    const name = page.getByLabel("Display name", { exact: true });
    await expect(name).toBeVisible();

    await name.fill("Admin Updated");
    await page.getByRole("button", { name: "Save" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Admin Updated");

    // Restore: the display name is the author label on every message this
    // account posts, so leaving it changed would leak into other specs.
    await page.getByLabel("Display name", { exact: true }).fill("Admin");
    await page.getByRole("button", { name: "Save" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue("Admin");
  });

  test("password change is validated client-side before it is sent", async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });

    // Deliberately never completes: changing the admin password would break
    // every other spec's sign-in.
    await page.getByLabel("Current password", { exact: true }).fill("whatever");
    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("Confirm new password", { exact: true }).fill("different");
    await page.getByRole("button", { name: "Update password" }).click();

    await expect(page.getByText("Use at least 8 characters")).toBeVisible();
    await expect(page.getByText("The two passwords do not match")).toBeVisible();
  });
});
