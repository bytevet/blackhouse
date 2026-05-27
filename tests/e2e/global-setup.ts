import { chromium, type FullConfig } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const STORAGE_STATE_PATH = "tests/e2e/.auth/admin.json";

export default async function globalSetup(_config: FullConfig) {
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";
  const username = process.env.E2E_ADMIN_USERNAME ?? "admin";
  const password = process.env.E2E_ADMIN_PASSWORD ?? "test1234";

  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();

  // Fast path: reuse an existing storageState if its cookie still resolves a
  // live session for the expected user. Skipping the form sign-in here avoids
  // hitting Better Auth's sliding-window rate limit during back-to-back
  // full-suite runs (see #32 — globalSetup failing at line 22 was the symptom).
  //
  // #55 hardening: also require the cached state to carry the i18n lang lock
  // (`blackhouse-lang=en` in localStorage). Storage states captured pre-i18n
  // have empty `origins` and would let the test run inherit the host browser's
  // navigator locale — flaky against any text assertion. If absent, fall
  // through to a fresh sign-in which re-captures localStorage.
  if (existsSync(STORAGE_STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STORAGE_STATE_PATH, "utf-8")) as {
        origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
      };
      const hasLangLock = state.origins?.some((o) =>
        o.localStorage?.some((kv) => kv.name === "blackhouse-lang" && kv.value === "en"),
      );
      if (!hasLangLock) {
        throw new Error("stale pre-i18n storage state — re-capturing with lang lock");
      }
      const cached = await browser.newContext({ storageState: state });
      const probe = await cached.request.get(`${baseURL}/api/auth/get-session`);
      const ok = probe.ok();
      const body = ok ? ((await probe.json()) as { user?: { username?: string } } | null) : null;
      await cached.close();
      if (ok && body?.user?.username === username) {
        await browser.close();
        return;
      }
    } catch {
      // fall through to fresh sign-in
    }
  }

  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // Force the i18n locale to English for locale-deterministic e2e (#55).
  // Persisted via storageState so subsequent test workers inherit it.
  await page.evaluate(() => localStorage.setItem("blackhouse-lang", "en"));
  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.waitForLoadState("domcontentloaded");

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  // Touch a sentinel file referenced by no other code; keeps storageState fresh
  // on every run so a stale cookie doesn't carry across servers.
  writeFileSync("tests/e2e/.auth/.created", new Date().toISOString());
}
