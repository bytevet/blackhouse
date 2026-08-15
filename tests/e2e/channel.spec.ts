import { test, expect, type Page } from "@playwright/test";
import {
  channelBySlug,
  composer,
  createAgent,
  deleteAgent,
  listChannelMessages,
  openStream,
  postChannelMessage,
  signInAsAdmin,
} from "./helpers";

/**
 * The channel view — the primary screen.
 *
 * ⚠️ `src/pages/channel.tsx` still seeds its state from
 * `components/channel/mock-data.ts`: the transcript, the roster and the channel
 * list are local state, not `GET /api/channels/...`. That makes the UI half of
 * this file deterministic — every test starts from the same fixture on load —
 * but it also means these assertions pin the *mock*. When the page is wired to
 * the API the selectors stay valid; the seeded values (`@scout`, `#backend`,
 * "Dana Okafor") become setup instead of fixtures.
 *
 * The API half at the bottom talks to the real server and still needs no
 * Docker: a mention of an agent that is not running parks a queued run rather
 * than injecting.
 */

/** The channel column — header, transcript and composer. Excludes the rail. */
function channelMain(page: Page) {
  return page.locator("main");
}

/**
 * Channel rows in the rail carry an unread badge or a mention dot, so their
 * accessible name is `"<slug>"`, `"<slug> 3"` or `"<slug> ●"`. Anchor on the
 * start of the name — a bare substring would also hit the `@backend` agent row.
 */
function channelLink(page: Page, slug: string) {
  return page.getByRole("link", { name: new RegExp(`^${slug}\\b`) });
}

async function openChannel(page: Page, slug: string) {
  await signInAsAdmin(page);
  await page.goto(`/channels/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(composer(page)).toBeVisible();
}

test.describe("Channel view", () => {
  test("the rail lists channels and the agent roster side by side", async ({ page }) => {
    await openChannel(page, "general");

    for (const slug of ["general", "backend", "frontend", "incidents", "random"]) {
      await expect(channelLink(page, slug)).toBeVisible();
    }

    // Agents live in the same rail as the channels because they are teammates,
    // and every row carries its activity and its status line.
    await expect(page.getByRole("link", { name: /@scout/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /@reviewer/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /@backend/ })).toBeVisible();
  });

  test("switching channels moves the header, topic and composer together", async ({ page }) => {
    await openChannel(page, "general");

    await channelLink(page, "backend").click();
    await expect(page).toHaveURL(/\/channels\/backend/);
    await expect(page.getByRole("heading", { name: "backend", level: 1 })).toBeVisible();
    await expect(page.getByText("Payments refactor")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message #backend" })).toBeVisible();
  });

  test("posting appends the message to the transcript", async ({ page }) => {
    await openChannel(page, "general");

    const body = `e2e plain post ${Date.now()}`;
    await composer(page).fill(body);
    await composer(page).press("Enter");

    await expect(channelMain(page).getByText(body)).toBeVisible();
    await expect(composer(page)).toHaveValue("");
  });

  test("the delivery-mode toggle states its consequence, not just its name", async ({ page }) => {
    await openChannel(page, "general");

    const mode = page.getByRole("radiogroup", { name: "Delivery mode" });
    await expect(mode.getByRole("radio", { name: "Queue" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText("Delivers when the agent is idle")).toBeVisible();

    // Interrupt sends ESC to a live TUI mid-task, so the hint restates the
    // consequence in the danger tone rather than leaving it to the label.
    await mode.getByRole("radio", { name: "Interrupt" }).click();
    await expect(mode.getByRole("radio", { name: "Interrupt" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByText("Stops the agent mid-task and runs this now")).toBeVisible();
  });

  test("mentioning a busy agent queues the run in place, with a way back", async ({ page }) => {
    await openChannel(page, "general");

    // `@backend` is running-and-busy in the fixture, so queue mode parks it.
    // The fixture already carries one queued chip, so take the newest.
    await composer(page).fill("@backend once tests are green, open a PR");
    await composer(page).press("Enter");

    const chip = channelMain(page)
      .getByText(/@backend is busy/)
      .last();
    await expect(chip).toContainText("Queued");
    await expect(chip).toContainText("delivers when idle");

    // The chip answers "why is nothing happening?" where the question was
    // asked, and taking it back is one click from there.
    await channelMain(page).getByRole("button", { name: "cancel" }).last().click();
    await expect(channelMain(page).getByText(/@backend is busy/)).toHaveCount(1);
  });

  test("interrupt mode says so on the queued chip", async ({ page }) => {
    await openChannel(page, "general");

    await page
      .getByRole("radiogroup", { name: "Delivery mode" })
      .getByRole("radio", { name: "Interrupt" })
      .click();
    await composer(page).fill("@backend stop and look at this");
    await composer(page).press("Enter");

    const chip = channelMain(page)
      .getByText(/@backend is busy/)
      .last();
    await expect(chip).toContainText("Interrupting");
    await expect(chip).toContainText("stops the current task");
  });

  test("mention autocomplete is a listbox the textarea points at", async ({ page }) => {
    await openChannel(page, "general");

    await composer(page).fill("@re");

    // Deliberately not a Select: the caret stays in the textarea and the
    // listbox is referenced through aria-controls / aria-activedescendant.
    await expect(composer(page)).toHaveAttribute("aria-expanded", "true");
    const listbox = page.getByRole("listbox", { name: "Agents" });
    await expect(listbox).toBeVisible();
    const option = listbox.getByRole("option", { name: /@reviewer/ });
    await expect(option).toBeVisible();
    // Every row carries live status, so Queue vs Interrupt is a decision you
    // can make before sending rather than four minutes later.
    await expect(option).toContainText("idle");

    await composer(page).press("Enter");
    await expect(composer(page)).toHaveValue("@reviewer ");
    await expect(listbox).toHaveCount(0);
  });

  test("Escape dismisses the listbox without clearing the half-typed handle", async ({ page }) => {
    await openChannel(page, "general");

    await composer(page).fill("@sc");
    await expect(page.getByRole("listbox", { name: "Agents" })).toBeVisible();
    await composer(page).press("Escape");
    await expect(page.getByRole("listbox", { name: "Agents" })).toHaveCount(0);
    await expect(composer(page)).toHaveValue("@sc");
  });

  test("turning auto-approve on is confirmed, badged and recorded", async ({ page }) => {
    await openChannel(page, "general");

    await page.getByRole("button", { name: "Channel settings" }).click();
    const toggle = page.getByRole("switch", { name: "Auto-approve dispatches" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Removing the only human gate on agent→agent dispatch asks first.
    await toggle.click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("Turn on auto-approve?");
    await confirm.getByRole("button", { name: "Turn on auto-approve" }).click();

    // Permanently visible from the top of the screen, not buried in a menu.
    await expect(page.getByText("auto-approve on", { exact: true })).toBeVisible();
    // …and written into the transcript: a silent removal of the gate is
    // exactly what must not be possible.
    await expect(channelMain(page).getByText(/turned auto-approve on/)).toBeVisible();
  });

  test("the create-channel dialog adds a room to the rail", async ({ page }) => {
    await openChannel(page, "general");

    await page.getByRole("button", { name: "Create channel" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Create a channel");

    await dialog.getByLabel("Name", { exact: true }).fill("e2e-room");
    await dialog.getByRole("button", { name: "Create channel" }).click();

    await expect(channelLink(page, "e2e-room")).toBeVisible();
    // Client state only for now — the dialog is not wired to `POST
    // /api/channels`, so nothing is left behind for global-teardown to sweep.
  });
});

/**
 * The channel API, exercised directly. Still no Docker: `routeMention` parks a
 * run as `queued` whenever the target agent is not running, which is every
 * agent that has never been started.
 */
test.describe("Channel API", () => {
  test("a posted message comes back in the keyset transcript", async ({ page }) => {
    await signInAsAdmin(page);

    const body = `e2e api post ${Date.now()}`;
    const posted = await postChannelMessage(page, "general", body);
    expect(posted.message.body).toBe(body);
    expect(posted.dispatched).toEqual([]);

    const transcript = await listChannelMessages(page, "general", 10);
    expect(transcript.messages.some((m) => m.id === posted.message.id)).toBe(true);
  });

  test("mentioning a stopped agent parks a queued run and says why", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      const posted = await postChannelMessage(page, "general", `@${agent.handle} take a look`);
      expect(posted.message.mentions).toContain(agent.id);
      expect(posted.dispatched).toHaveLength(1);

      const [run] = posted.dispatched;
      expect(run.agentId).toBe(agent.id);
      // Queued rather than dropped, and the reason travels with it instead of
      // being re-derived from the status field.
      expect(run.queued).toBe(true);
      expect(run.reason).toMatch(/not running/i);
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("an unresolvable handle dispatches nothing", async ({ page }) => {
    await signInAsAdmin(page);
    const posted = await postChannelMessage(page, "general", "@nobody-here are you there");
    expect(posted.dispatched).toEqual([]);
  });

  test("the multiplexed SSE stream carries the channel topic", async ({ page }) => {
    await signInAsAdmin(page);
    const channel = await channelBySlug(page, "general");

    // One connection per tab, multiplexed by topic — per-room streams would hit
    // the browser's ~6-connections-per-origin cap once a few rooms are open.
    const stream = await openStream(page, [`channel:${channel.id}`]);
    try {
      const body = `e2e sse ${Date.now()}`;
      const posted = await postChannelMessage(page, "general", body);

      const frame = await stream.nextOfType("message.created", 10000);
      expect(frame).not.toBeNull();
      expect(frame!.topic).toBe(`channel:${channel.id}`);
      expect(frame!.messageId).toBe(posted.message.id);
    } finally {
      stream.close();
    }
  });
});
