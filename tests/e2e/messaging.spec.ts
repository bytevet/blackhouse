/**
 * Inter-session messaging e2e suite (#70).
 *
 * Pre-work scaffolding — bodies are written against the expected API shape
 * from `/Users/copr/.claude/plans/woolly-yawning-pudding.md` §be commits 3+6.
 * Until be lands commit 3 the runtime calls 404; until commit 6 the SSE test
 * times out. All tests are gated on `E2E_DOCKER=1` for the container-needing
 * paths; the pure-API ones (cross-user 403, payload cap, dedup) also gate on
 * docker because they hire real sessions for token + DB rows.
 *
 * Layout:
 *   - "Messaging API" (tests 1-9, 11): happy-path / 403 / 404 / 429 / size /
 *     dedup / wait-flow / SSE delivery. Parallelizable per-test.
 *   - "Messaging — container respawn" (test 10): .serial — kills the
 *     receiver container mid-flight, expects DB-persisted message to
 *     survive.
 *   - "Autonomous-check" (3 tests, one per preset): the load-bearing gate
 *     for Phase 1.5. test.slow() + 60s `expect.poll` on `delivered_at`.
 *   - "Codex sandbox empirical check": runs once, documents whether the
 *     Codex container's seccomp/netns allows curl-to-host-loopback.
 */

import { test, expect } from "@playwright/test";
import {
  signInAsAdmin,
  createSession,
  createSessionWithPreset,
  cleanupSession,
  execInContainer,
  getSessionContainerId,
  getTestDockerClient,
  sendMessage,
  sendMessageOk,
  getInbox,
  getInboxCount,
  ackMessage,
  ackMessageBatch,
  listMineSessions,
  openInboxEventsStream,
} from "./helpers";

/* ─────────────────────────────────────────────────────────────────────────
 * Test 1 — happy path round-trip
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — happy path", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("send-message → inbox → ack flips status", async ({ page }) => {
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-happy-sender");
    const receiverId = await createSession(page, "msg-happy-receiver");
    try {
      const sent = await sendMessageOk(page, senderId, receiverId, "hello world");
      expect(sent.message_id).toBeTruthy();
      expect(sent.target_unread_count).toBeGreaterThanOrEqual(1);

      const inbox = await getInbox(page, receiverId);
      const found = inbox.find((m) => m.id === sent.message_id);
      expect(found).toBeDefined();
      expect(found!.message).toBe("hello world");
      expect(found!.fromSessionId).toBe(senderId);
      // `ack_at` is null — only an explicit ack flips that.
      expect(found!.ackAt).toBeNull();
      // `delivered_at` is stamped on the rows AFTER the GET handler builds
      // its response, so the FIRST observation always sees null. A second
      // observation shows the stamp. (BE docstring is ambiguous about
      // whether the stamp is observable in the same response — be is
      // tracking the doc tightening. Test checks the next-observation
      // behavior which is the contract that matters to clients.)
      const inboxObserved = await getInbox(page, receiverId);
      const foundObserved = inboxObserved.find((m) => m.id === sent.message_id);
      expect(foundObserved!.deliveredAt).not.toBeNull();

      const ackRes = await ackMessage(page, receiverId, sent.message_id);
      expect(ackRes.ok()).toBe(true);
      const ackBody = (await ackRes.json()) as { ok: boolean; ack_at?: string };
      expect(ackBody.ok).toBe(true);

      // After ack the unread count drops and the message no longer appears
      // in the unread inbox.
      expect(await getInboxCount(page, receiverId)).toBe(0);
      const inboxAfter = await getInbox(page, receiverId);
      expect(inboxAfter.find((m) => m.id === sent.message_id)).toBeUndefined();

      // Idempotent re-ack returns 200 with `already_acked: true` — covers
      // the retry-after-network-blip path.
      const ackAgain = await ackMessage(page, receiverId, sent.message_id);
      expect(ackAgain.status()).toBe(200);
      const ackAgainBody = (await ackAgain.json()) as { already_acked?: boolean };
      expect(ackAgainBody.already_acked).toBe(true);
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Test 2 — cross-user 403 (HARD GATE)
 * Sender from user A, receiver from user B → POST /send-message must 403.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — security boundary", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("cross-user send rejected with 403", async ({ browser, page }) => {
    // User A: admin (default seeded). Hire one session as A.
    await signInAsAdmin(page);
    const userASessionId = await createSession(page, "msg-cross-A");

    // User B: a second user via a fresh context. Critically, the test
    // suite's `use.storageState` (admin.json) auto-loads admin cookies
    // into every new context — so we MUST explicitly clear storageState
    // here, otherwise pageB starts already-authed as admin and the
    // sign-in form never runs. Without that, both contexts share the
    // admin userId and the 403 boundary can't be exercised.
    // Test setup also assumes a seeded non-admin "user" / "test1234"
    // pair from `db/seed.ts` (added in 6b7a59d after qa's earlier flag).
    const ctxB = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const pageB = await ctxB.newPage();
    let userBSessionId = "";
    try {
      const userB = process.env.E2E_USER_USERNAME ?? "user";
      const userBPass = process.env.E2E_USER_PASSWORD ?? "test1234";
      await pageB.goto("/login", { waitUntil: "networkidle" });
      await pageB.getByPlaceholder("username").fill(userB);
      await pageB.getByPlaceholder("********").fill(userBPass);
      await pageB.getByRole("button", { name: /sign in/i }).click();
      await pageB.waitForURL(/\/dashboard/, { timeout: 15000 });
      userBSessionId = await createSession(pageB, "msg-cross-B");

      // A tries to message B. Use A's token but B's session id as target.
      const res = await sendMessage(page, userASessionId, userBSessionId, "leak attempt");
      expect(res.status()).toBe(403);
    } finally {
      await cleanupSession(page, userASessionId);
      if (userBSessionId) await cleanupSession(pageB, userBSessionId);
      await ctxB.close();
    }
  });

  test("wrong-session 404 when target id does not exist", async ({ page }) => {
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-404-sender");
    try {
      // Random UUID with no row.
      const res = await sendMessage(
        page,
        senderId,
        "00000000-0000-0000-0000-000000000000",
        "ghost",
      );
      expect(res.status()).toBe(404);
    } finally {
      await cleanupSession(page, senderId);
    }
  });

  test("ack-batch ignores foreign IDs (HARD GATE on `to_session_id` guard)", async ({ page }) => {
    await signInAsAdmin(page);
    const aId = await createSession(page, "msg-ack-batch-a");
    const bId = await createSession(page, "msg-ack-batch-b");
    try {
      // Send msg to A and msg to B (both from A).
      const msgToA = await sendMessageOk(page, aId, aId, "self-A");
      const msgToB = await sendMessageOk(page, aId, bId, "to-B");

      // A acks the batch including B's message id. Server's
      // `to_session_id = $1` filter should silently drop the foreign id.
      const res = await ackMessageBatch(page, aId, [msgToA.message_id, msgToB.message_id]);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { acked: number };
      // Only msgToA flips; foreign id silently ignored (NOT 403'd — that
      // would leak existence of foreign ids).
      expect(body.acked).toBe(1);

      // Verify B's message is still unacked.
      const inboxB = await getInbox(page, bId);
      const stillThere = inboxB.find((m) => m.id === msgToB.message_id);
      expect(stillThere).toBeDefined();
      expect(stillThere!.ackAt).toBeNull();
    } finally {
      await cleanupSession(page, aId);
      await cleanupSession(page, bId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Tests 4-5 — rate-limit + payload cap
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — limits", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("per-session rate-limit returns 429 with Retry-After", async ({ page }) => {
    test.slow(); // 100+ requests
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-rl-sender");
    const receiverId = await createSession(page, "msg-rl-receiver");
    try {
      // Per-session cap is 100/min per the design. Fire ~110 fast.
      // Burst sequentially — the server's token bucket is single-instance
      // in-memory, so parallel doesn't change the eventual 429.
      let got429 = false;
      let retryAfter: string | null = null;
      for (let i = 0; i < 110; i++) {
        const res = await sendMessage(page, senderId, receiverId, `burst-${i}`);
        if (res.status() === 429) {
          got429 = true;
          retryAfter = res.headers()["retry-after"] ?? null;
          break;
        }
      }
      expect(got429).toBe(true);
      expect(retryAfter).toBeTruthy(); // Retry-After header is required by RFC 6585
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });

  test("payload over 100k bytes returns 4xx", async ({ page }) => {
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-payload-sender");
    const receiverId = await createSession(page, "msg-payload-receiver");
    try {
      // BE Zod cap is `z.string().max(100_000)` — i.e. 100 thousand chars,
      // NOT 100 * 1024. Over-cap is rejected (400/413/422); exactly-cap
      // succeeds.
      const overCap = "x".repeat(100_001);
      const res = await sendMessage(page, senderId, receiverId, overCap);
      expect([400, 413, 422]).toContain(res.status());

      // Exactly 100,000 should succeed (boundary check).
      const atCap = "x".repeat(100_000);
      const okRes = await sendMessage(page, senderId, receiverId, atCap);
      expect(okRes.ok()).toBe(true);
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Test 6 — request_id dedup
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — dedup", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("identical (from, request_id) within 60s returns same message_id", async ({ page }) => {
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-dedup-sender");
    const receiverId = await createSession(page, "msg-dedup-receiver");
    try {
      const reqId = `e2e-dedup-${Date.now()}`;
      const first = await sendMessageOk(page, senderId, receiverId, "first", { requestId: reqId });
      const second = await sendMessageOk(page, senderId, receiverId, "second-ignored", {
        requestId: reqId,
      });
      expect(second.message_id).toBe(first.message_id);

      // The inbox should still show only one row, with the FIRST payload —
      // dedup ignores second body, doesn't update.
      const inbox = await getInbox(page, receiverId);
      const matches = inbox.filter((m) => m.id === first.message_id);
      expect(matches.length).toBe(1);
      expect(matches[0].message).toBe("first");
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Tests 7-9 — --wait flow (server-side: filtered GET /inbox?reply_to=<id>)
 *
 * The `send-msg.sh --wait=Ns` client-side polls GET /inbox?reply_to=<reqId>&
 * unread=true every 5s for up to N seconds. We exercise the API surface
 * directly — the shell wrapper's poll loop is covered by the unit test in
 * `tests/unit/check-inbox-cli.test.ts`.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — wait flow", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("--wait happy path: reply already present resolves immediately", async ({ page }) => {
    await signInAsAdmin(page);
    const aId = await createSession(page, "msg-wait-happy-a");
    const bId = await createSession(page, "msg-wait-happy-b");
    try {
      const reqId = `e2e-wait-happy-${Date.now()}`;
      // A sends to B with reqId. B replies to A with the same reqId.
      await sendMessageOk(page, aId, bId, "question?", { requestId: reqId });
      await sendMessageOk(page, bId, aId, "answer!", { requestId: reqId });

      // A's --wait poll: fetch A's inbox filtered by reply_to=<reqId>.
      const replies = await getInbox(page, aId, { replyTo: reqId });
      expect(replies.length).toBe(1);
      expect(replies[0].message).toBe("answer!");
      expect(replies[0].fromSessionId).toBe(bId);
    } finally {
      await cleanupSession(page, aId);
      await cleanupSession(page, bId);
    }
  });

  test("--wait block-then-resolve: reply arrives during poll window", async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);
    const aId = await createSession(page, "msg-wait-block-a");
    const bId = await createSession(page, "msg-wait-block-b");
    try {
      const reqId = `e2e-wait-block-${Date.now()}`;
      await sendMessageOk(page, aId, bId, "ping", { requestId: reqId });

      // Schedule B's reply at t+2s.
      const replyAt = setTimeout(() => {
        void sendMessageOk(page, bId, aId, "pong", { requestId: reqId });
      }, 2000);

      // Poll A's inbox for the reply — expect.poll runs every 1s up to 10s.
      try {
        await expect
          .poll(
            async () => {
              const replies = await getInbox(page, aId, { replyTo: reqId });
              return replies.length;
            },
            { timeout: 10000, intervals: [1000, 1000, 1000, 1000, 1000] },
          )
          .toBeGreaterThan(0);
      } finally {
        clearTimeout(replyAt);
      }
    } finally {
      await cleanupSession(page, aId);
      await cleanupSession(page, bId);
    }
  });

  test("--wait timeout: no reply within window returns empty", async ({ page }) => {
    await signInAsAdmin(page);
    const aId = await createSession(page, "msg-wait-to-a");
    const bId = await createSession(page, "msg-wait-to-b");
    try {
      const reqId = `e2e-wait-to-${Date.now()}`;
      await sendMessageOk(page, aId, bId, "alone?", { requestId: reqId });

      // No reply ever — A's filtered inbox stays empty.
      const replies = await getInbox(page, aId, { replyTo: reqId });
      expect(replies.length).toBe(0);
    } finally {
      await cleanupSession(page, aId);
      await cleanupSession(page, bId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Test 10 — container respawn mid-flight
 * Messages are DB-durable; the receiver container restarting must NOT lose
 * pending messages. Tests the queue's persistence guarantee.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe.serial("Messaging — container respawn", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("pending message survives receiver container restart", async ({ page }) => {
    test.slow();
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-respawn-sender");
    const receiverId = await createSession(page, "msg-respawn-receiver");
    try {
      const sent = await sendMessageOk(page, senderId, receiverId, "pre-restart");

      // Restart the receiver container — DB row should outlive it. Use
      // dockerode directly; the API doesn't have a "restart" endpoint.
      const containerId = await getSessionContainerId(page, receiverId);
      await getTestDockerClient().getContainer(containerId).restart({ t: 5 });

      // Wait for the sidecar to come back up (~10s for entrypoint reinit).
      await page.waitForTimeout(10_000);

      // Pending message must still be there.
      const inbox = await getInbox(page, receiverId);
      const found = inbox.find((m) => m.id === sent.message_id);
      expect(found).toBeDefined();
      expect(found!.message).toBe("pre-restart");
      expect(found!.ackAt).toBeNull();

      // Ack still works post-restart.
      const ackRes = await ackMessage(page, receiverId, sent.message_id);
      expect(ackRes.ok()).toBe(true);
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Test 11 — SSE inbox-events delivery
 * Subscribe to /api/inbox-events, send + ack, assert events arrive within 1s.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — SSE delivery", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("emits unread-changed within 1s of send + ack", async ({ page }) => {
    await signInAsAdmin(page);
    const senderId = await createSession(page, "msg-sse-sender");
    const receiverId = await createSession(page, "msg-sse-receiver");
    const stream = await openInboxEventsStream(page);
    try {
      // Drain any startup events (some implementations may emit an initial
      // snapshot — we don't assert on those).
      await stream.next(100).catch(() => null);

      const sent = await sendMessageOk(page, senderId, receiverId, "sse hello");
      const sendEvent = await stream.next(2000);
      expect(sendEvent).not.toBeNull();
      expect(sendEvent!.type).toBe("unread-changed");
      expect(sendEvent!.sessionId).toBe(receiverId);
      expect(sendEvent!.unreadCount).toBeGreaterThanOrEqual(1);

      // Ack — should emit another event with the decremented count.
      await ackMessage(page, receiverId, sent.message_id);
      const ackEvent = await stream.next(2000);
      expect(ackEvent).not.toBeNull();
      expect(ackEvent!.sessionId).toBe(receiverId);
      expect(ackEvent!.unreadCount).toBe(0);
    } finally {
      stream.close();
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Sender discovery — GET /api/sessions/list-mine
 * Quick smoke for the list endpoint the agent uses to discover peers.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — sender discovery", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("list-mine returns the auth'd user's non-destroyed sessions", async ({ page }) => {
    await signInAsAdmin(page);
    const aId = await createSession(page, "msg-listmine-a");
    const bId = await createSession(page, "msg-listmine-b");
    try {
      const list = await listMineSessions(page, aId);
      const ids = list.map((s) => s.id);
      expect(ids).toContain(aId);
      expect(ids).toContain(bId);
      // Destroyed sessions must NOT appear.
      for (const s of list) expect(s.status).not.toBe("destroyed");
    } finally {
      await cleanupSession(page, aId);
      await cleanupSession(page, bId);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Autonomous-check tests (HARD GATE: ≥2/3 must pass for Phase 1.5)
 *
 * Pattern: hire two sessions of the same preset, send a message, wait up to
 * 60s for the receiver agent to autonomously call check-inbox.sh — detected
 * via `delivered_at` flipping from null on the inbox row.
 * ───────────────────────────────────────────────────────────────────────── */
const AUTONOMOUS_PRESETS = ["Claude Code", "Codex", "Antigravity"] as const;
type Preset = (typeof AUTONOMOUS_PRESETS)[number];

function autonomousCheckTest(preset: Preset) {
  test(`${preset} agent autonomously calls check-inbox.sh within 60s`, async ({ page }) => {
    test.slow(); // 60s receiver-side wait + container warmup
    await signInAsAdmin(page);
    const senderId = await createSessionWithPreset(page, `msg-auto-${preset}-sender`, preset);
    const receiverId = await createSessionWithPreset(page, `msg-auto-${preset}-receiver`, preset);
    try {
      const sent = await sendMessageOk(
        page,
        senderId,
        receiverId,
        "Please run `check-inbox.sh` so I know you received this.",
      );

      // Signal: poll `/inbox/count` until it drops to 0 — proves the
      // agent processed the message end-to-end (autonomously called
      // check-inbox.sh AND followed ack discipline). We deliberately
      // avoid polling `getInbox` here because every GET /inbox flips
      // `delivered_at` server-side, so the test's own poll would race
      // with the agent's call. `/inbox/count` is a pure read with no
      // observability side-effects, so it's the cleanest signal.
      await expect
        .poll(() => getInboxCount(page, receiverId), {
          timeout: 60_000,
          intervals: [2_000, 5_000, 10_000],
        })
        .toBe(0);

      // Final assertion: the specific message is ack'd.
      const inboxFinal = await getInbox(page, receiverId);
      const stillUnacked = inboxFinal.find((m) => m.id === sent.message_id && m.ackAt === null);
      expect(stillUnacked).toBeUndefined();
    } finally {
      await cleanupSession(page, senderId);
      await cleanupSession(page, receiverId);
    }
  });
}

test.describe("Messaging — autonomous-check (HARD GATE)", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");
  for (const preset of AUTONOMOUS_PRESETS) autonomousCheckTest(preset);
});

/* ─────────────────────────────────────────────────────────────────────────
 * Codex sandbox empirical check — does Codex's seccomp/netns block
 * curl-to-host-loopback? Documents the outcome; if it fails, the Codex
 * autonomous-check would fail for sandbox reasons (not prompt reasons) and
 * we'd need to escalate sandbox config to research + be BEFORE marking the
 * autonomous-check as a true negative.
 * ───────────────────────────────────────────────────────────────────────── */
test.describe("Messaging — Codex sandbox empirical check", () => {
  test.skip(() => !process.env.E2E_DOCKER, "Requires Docker — set E2E_DOCKER=1 to enable");

  test("Codex container can curl BLACKHOUSE_URL /inbox/count from inside the sandbox", async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const sessionId = await createSessionWithPreset(page, "msg-codex-sandbox", "Codex");
    try {
      const containerId = await getSessionContainerId(page, sessionId);
      // SESSION_TOKEN + BLACKHOUSE_URL are exported into the container by
      // the entrypoint; read both from inside via the shell so the test
      // hits exactly the URL the agent itself would use. Reading
      // process.env.BLACKHOUSE_CONTAINER_URL on the runner is wrong — the
      // Playwright process inherits a different env than the Hono server,
      // and host.docker.internal is not a meaningful host on the runner
      // side either.
      const exec = await execInContainer(containerId, [
        "sh",
        "-c",
        'curl -fsS -H "Authorization: Bearer $SESSION_TOKEN" "$BLACKHOUSE_URL/api/sessions/$SESSION_ID/inbox/count"',
      ]);
      if (exec.exitCode !== 0) {
        // Don't silently green — surface the sandbox failure clearly.
        throw new Error(
          `Codex sandbox blocked curl-to-host: exit=${exec.exitCode}\n` +
            `stdout=${exec.stdout}\nstderr=${exec.stderr}\n` +
            `→ escalate to be/research before running Codex autonomous-check`,
        );
      }
      const body = JSON.parse(exec.stdout) as { unread: number };
      expect(typeof body.unread).toBe("number");
    } finally {
      await cleanupSession(page, sessionId);
    }
  });
});
