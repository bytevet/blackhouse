import { test, expect, type Page } from "@playwright/test";
import {
  channelBySlug,
  composer,
  createAgent,
  deleteAgent,
  getBaseUrl,
  listChannelMessages,
  openStream,
  postChannelMessage,
  signInAsAdmin,
  type PostedMessage,
} from "./helpers";

/**
 * Channel membership — the dialog, and the gate it turns on.
 *
 * Membership stopped being decorative: a mention only routes to an agent that
 * is in the channel, so this file has to cover both halves of that. The UI half
 * drives the dialog (which is the only way a person fixes a bad mention), and
 * the API half pins the gate itself — that a non-member mention *posts and
 * dispatches nothing*, which is the behaviour a passing UI could still get
 * wrong.
 *
 * Everything runs against seeded `#general` rather than a channel of its own.
 * `POST /api/channels` has no `DELETE` counterpart (`global-teardown.ts` says
 * so), so a spec that created its own room would leave one behind on every run,
 * on a live deployment, forever. `#general` is public and seeded with no
 * members at all, so adding one and removing it again leaves the room exactly
 * as it was found.
 *
 * The membership row is therefore what every `finally` here cleans up, not just
 * the agent: `DELETE /api/agents/:id` flips the row to `destroyed` rather than
 * deleting it, so a leaked membership would sit in the dialog as a dead agent
 * that nobody can explain.
 *
 * No Docker needed. Nothing starts a container — `POST /api/agents` only writes
 * the row, and a mention of an agent that is not running parks a queued run.
 */

const CHANNEL = "general";

/* --------------------------------------------------------------- members -- */

interface MemberRow {
  memberId: string;
  id: string;
}

interface MembersResponse {
  people: Array<MemberRow & { name: string; email: string; role: string | null }>;
  agents: Array<MemberRow & { handle: string; displayName: string; status: string }>;
}

interface CandidatesResponse {
  people: Array<{ id: string; name: string; email: string }>;
  agents: Array<{ id: string; handle: string; displayName: string }>;
}

const membersUrl = (key: string) => `${getBaseUrl()}/api/channels/${key}/members`;

/**
 * The three membership routes, called raw rather than through a helper that
 * throws: half the assertions in this file are *about* the status code (409 on
 * a duplicate, 404 on a second delete), so the caller has to see it.
 */
function addMemberRequest(page: Page, key: string, body: { agentId: string } | { userId: string }) {
  return page.request.post(membersUrl(key), { data: body, failOnStatusCode: false });
}

function removeMemberRequest(page: Page, key: string, memberId: string) {
  return page.request.delete(`${membersUrl(key)}/${memberId}`, { failOnStatusCode: false });
}

async function fetchMembers(page: Page, key: string): Promise<MembersResponse> {
  const res = await page.request.get(membersUrl(key), { failOnStatusCode: false });
  expect(res.status(), "GET members").toBe(200);
  return (await res.json()) as MembersResponse;
}

async function fetchCandidates(page: Page, key: string): Promise<CandidatesResponse> {
  const res = await page.request.get(`${membersUrl(key)}/candidates`, { failOnStatusCode: false });
  expect(res.status(), "GET member candidates").toBe(200);
  return (await res.json()) as CandidatesResponse;
}

/** Add an agent and return its membership id. Fails loudly — this is setup. */
async function addAgentMember(page: Page, key: string, agentId: string): Promise<string> {
  const res = await addMemberRequest(page, key, { agentId });
  expect(res.status(), "POST members").toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Best-effort cleanup, mirroring `deleteAgent`. The membership may already be
 * gone — the test that removes it through the dialog is the point — so a 404
 * here is success, not failure.
 */
async function dropAgentMember(page: Page, key: string, agentId: string): Promise<void> {
  try {
    // Deliberately not `fetchMembers`: an `expect` that fires from a `finally`
    // reports as a failure of whatever the test was really about.
    const res = await page.request.get(membersUrl(key), { failOnStatusCode: false });
    if (!res.ok()) return;
    const members = (await res.json()) as MembersResponse;
    const row = members.agents.find((a) => a.id === agentId);
    if (row) await removeMemberRequest(page, key, row.memberId);
  } catch {
    /* the channel or the session is gone — global-teardown sweeps the agent */
  }
}

/* ------------------------------------------------------------------- UI -- */

/** The channel column — header, transcript, note and composer. Excludes the rail. */
function channelMain(page: Page) {
  return page.locator("main");
}

/**
 * The members dialog. `title` is rendered as the `<h2>` the `<dialog>` points
 * at with `aria-labelledby`, so the accessible name is stable; the confirm
 * dialogs that live in the same header are closed, and a closed `<dialog>` is
 * hidden from the a11y tree, so this never matches one of those.
 */
function membersDialog(page: Page) {
  return page.getByRole("dialog", { name: "Channel members" });
}

/**
 * The header's member count. Its text is the count, so the accessible name is
 * `"2 humans · 1 agents"` and changes as agents come and go — the `title` is
 * the part that does not move.
 */
function memberCount(page: Page) {
  return page.getByTitle("Manage members");
}

/** One row of the `@` listbox. Matched on the handle, which is unique per test. */
function mentionOption(page: Page, handle: string) {
  return page.getByRole("option", { name: new RegExp(`@${handle}`) });
}

/**
 * Land in the channel. Split from sign-in because every test that needs an
 * agent has to create it *before* the shell mounts: the rail's roster is one
 * fetch on mount, and the composer's `@` list is that roster filtered by
 * membership. Creating first means nothing depends on the `agent.created`
 * frame arriving.
 */
async function gotoChannel(page: Page, slug = CHANNEL) {
  await page.goto(`/channels/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(composer(page)).toBeVisible();
}

async function openChannel(page: Page, slug = CHANNEL) {
  await signInAsAdmin(page);
  await gotoChannel(page, slug);
}

/** Open the dialog from the header count and wait for its first load. */
async function openMembersDialog(page: Page) {
  await memberCount(page).click();
  const dialog = membersDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Channel members dialog", () => {
  test("the header's member count opens the members dialog", async ({ page }) => {
    await openChannel(page);

    // The count is the affordance, not a statistic — clicking it is how the
    // roster gets managed at all.
    await expect(memberCount(page)).toHaveText(/\d+ humans · \d+ agents/);

    const dialog = await openMembersDialog(page);
    await expect(dialog).toContainText(`Who can read #${CHANNEL}`);
    await expect(dialog).toContainText("People");
    await expect(dialog).toContainText("Agents");

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(membersDialog(page)).toBeHidden();
  });

  test("the channel overflow menu opens the same dialog", async ({ page }) => {
    await openChannel(page);

    await page.getByRole("button", { name: "Channel settings" }).click();
    await page.getByRole("button", { name: "Members", exact: true }).click();

    await expect(membersDialog(page)).toBeVisible();
  });

  test("adding an agent puts it in the Agents card", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      await gotoChannel(page);
      const dialog = await openMembersDialog(page);

      // Person is the default; agents are the other half of the same control.
      await dialog.getByRole("button", { name: "Agent", exact: true }).click();

      // A text box backed by a datalist, matching the design. What you type is
      // resolved against the candidate list on Add, so the handle is the input.
      const picker = dialog.getByLabel("Agent to add");
      await picker.fill(`@${agent.handle}`);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();

      await expect(dialog.getByRole("button", { name: `Remove @${agent.handle}` })).toBeVisible();
      // …and it stops being suggested, because it is no longer a candidate.
      await expect(dialog.locator(`datalist option[value="@${agent.handle}"]`)).toHaveCount(0);

      const members = await fetchMembers(page, CHANNEL);
      expect(members.agents.some((a) => a.id === agent.id)).toBe(true);
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });

  test("removing an agent takes it out of the Agents card", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);
    await addAgentMember(page, CHANNEL, agent.id);

    try {
      await gotoChannel(page);
      const dialog = await openMembersDialog(page);
      const remove = dialog.getByRole("button", { name: `Remove @${agent.handle}` });
      await expect(remove).toBeVisible();

      await remove.click();
      await expect(remove).toHaveCount(0);

      // The dialog refetches after the delete, so the row going away is the
      // server's answer rather than local state.
      const members = await fetchMembers(page, CHANNEL);
      expect(members.agents.some((a) => a.id === agent.id)).toBe(false);
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });

  test("mentioning a non-member posts the message and offers the fix", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      await gotoChannel(page);

      // Trailing text, so the caret is not inside a mention when Enter is
      // pressed — otherwise Enter would pick from the listbox instead of send.
      const tail = `e2e non-member ping ${Date.now()}`;
      await composer(page).fill(`@${agent.handle} ${tail}`);
      await composer(page).press("Enter");

      // Wait for the composer to clear *first*. Until it does, the draft still
      // holds this exact text, and a `getByText` for it matches both the posted
      // row and the textarea — a strict-mode violation rather than a real
      // failure. Clearing is also the signal the post was accepted, since the
      // draft is only dropped once the server has taken it.
      await expect(composer(page)).toHaveValue("");
      // The message still posts. Losing what someone typed over a membership
      // detail would be worse than telling them about it.
      await expect(channelMain(page).getByText(tail)).toBeVisible();

      const note = page.locator('[role="status"]', { hasText: "nothing was dispatched" });
      await expect(note).toContainText(`@${agent.handle} is not in #${CHANNEL}`);

      // The way out of the note is the dialog it names.
      await note.getByRole("button", { name: "Add to channel" }).click();
      await expect(membersDialog(page)).toBeVisible();
      await membersDialog(page).getByRole("button", { name: "Done" }).click();

      await note.getByRole("button", { name: "Dismiss" }).click();
      await expect(note).toHaveCount(0);
    } finally {
      await deleteAgent(page, agent.id);
    }
  });

  test("the @ autocomplete offers members only, live in both directions", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      await gotoChannel(page);
      const box = composer(page);
      await box.fill(`@${agent.handle}`);

      // Not a member yet: offering it would be offering a mention the server
      // then refuses to route.
      await expect(mentionOption(page, agent.handle)).toHaveCount(0);
      await expect(box).toHaveAttribute("aria-expanded", "false");

      // `channel.members` on the multiplexed stream is what makes the composer
      // agree with the dialog without a reload.
      const memberId = await addAgentMember(page, CHANNEL, agent.id);
      await expect(mentionOption(page, agent.handle)).toBeVisible();

      await box.press("Enter");
      await expect(box).toHaveValue(`@${agent.handle} `);

      await removeMemberRequest(page, CHANNEL, memberId);
      await box.fill(`@${agent.handle}`);
      await expect(mentionOption(page, agent.handle)).toHaveCount(0);
      await expect(box).toHaveAttribute("aria-expanded", "false");
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });
});

/* ------------------------------------------------------------------ API -- */

test.describe("Channel members API", () => {
  test("adding the same member twice is a 409, not a silent success", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      const first = await addMemberRequest(page, CHANNEL, { agentId: agent.id });
      expect(first.status()).toBe(201);
      const memberId = ((await first.json()) as { id: string }).id;

      // `onConflictDoNothing` returns no row for a duplicate, and "already a
      // member" is a thing the dialog should say rather than a no-op that
      // looks like an add.
      const second = await addMemberRequest(page, CHANNEL, { agentId: agent.id });
      expect(second.status()).toBe(409);
      expect(((await second.json()) as { error?: string }).error).toMatch(/already a member/i);

      const members = await fetchMembers(page, CHANNEL);
      expect(members.agents.filter((a) => a.id === agent.id)).toHaveLength(1);

      expect((await removeMemberRequest(page, CHANNEL, memberId)).status()).toBe(200);
      // …and removing it a second time is a 404 rather than a cheerful ok.
      expect((await removeMemberRequest(page, CHANNEL, memberId)).status()).toBe(404);
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });

  test("candidates offer only who is not already in the channel", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      const before = await fetchCandidates(page, CHANNEL);
      expect(before.agents.some((a) => a.id === agent.id)).toBe(true);

      const memberId = await addAgentMember(page, CHANNEL, agent.id);
      const during = await fetchCandidates(page, CHANNEL);
      expect(during.agents.some((a) => a.id === agent.id)).toBe(false);

      await removeMemberRequest(page, CHANNEL, memberId);
      const after = await fetchCandidates(page, CHANNEL);
      expect(after.agents.some((a) => a.id === agent.id)).toBe(true);
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });

  test("a mention only dispatches once the agent is in the channel", async ({ page }) => {
    await signInAsAdmin(page);
    const agent = await createAgent(page);

    try {
      const stamp = Date.now();
      // `notMembers` is newer than the helper's response type, so widen it
      // here rather than editing shared plumbing mid-feature.
      const posted = (await postChannelMessage(
        page,
        CHANNEL,
        `@${agent.handle} e2e gate check ${stamp}`,
      )) as PostedMessage & { notMembers?: string[] };

      expect(posted.dispatched).toEqual([]);
      expect(posted.notMembers ?? []).toContain(agent.handle);
      // Nothing was mentioned, so nothing is owed a run…
      expect(posted.message.mentions ?? []).toHaveLength(0);
      // …but the message itself landed.
      const transcript = await listChannelMessages(page, CHANNEL, 10);
      expect(transcript.messages.some((m) => m.id === posted.message.id)).toBe(true);

      await addAgentMember(page, CHANNEL, agent.id);

      const after = (await postChannelMessage(
        page,
        CHANNEL,
        `@${agent.handle} e2e gate check ${stamp} again`,
      )) as PostedMessage & { notMembers?: string[] };

      expect(after.notMembers ?? []).toEqual([]);
      expect(after.dispatched).toHaveLength(1);
      expect(after.dispatched[0].agentId).toBe(agent.id);
      // Never started, so the run parks rather than injecting — no Docker here.
      expect(after.dispatched[0].queued).toBe(true);
      expect(after.message.mentions ?? []).toContain(agent.id);
    } finally {
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });

  test("a membership change is announced on the channel topic", async ({ page }) => {
    await signInAsAdmin(page);
    const channel = await channelBySlug(page, CHANNEL);
    const agent = await createAgent(page);

    // The frame carries no rows — both consumers want different shapes and
    // refetch. What matters is that it arrives, because the header, the dialog
    // and the composer's roster all hang off it.
    const stream = await openStream(page, [`channel:${channel.id}`]);
    try {
      await addAgentMember(page, CHANNEL, agent.id);

      const frame = await stream.nextOfType("channel.members", 10000);
      expect(frame).not.toBeNull();
      expect(frame!.topic).toBe(`channel:${channel.id}`);
      expect(frame!.channelId).toBe(channel.id);
    } finally {
      stream.close();
      await dropAgentMember(page, CHANNEL, agent.id);
      await deleteAgent(page, agent.id);
    }
  });
});
