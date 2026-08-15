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
  // live session for the expected user. Skipping the form sign-in avoids Better
  // Auth's sliding-window rate limit during back-to-back full-suite runs.
  //
  // The cached state must also carry the i18n lang lock (`blackhouse-lang=en`
  // in localStorage). Without it the run inherits the host browser's navigator
  // locale, and every text assertion in the suite becomes locale-dependent —
  // `src/i18n/index.ts` detects `localStorage` first, then `navigator`.
  if (existsSync(STORAGE_STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STORAGE_STATE_PATH, "utf-8")) as {
        origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
      };
      const hasLangLock = state.origins?.some((o) =>
        o.localStorage?.some((kv) => kv.name === "blackhouse-lang" && kv.value === "en"),
      );
      if (!hasLangLock) {
        throw new Error("storage state missing the lang lock — re-capturing");
      }
      // Hand Playwright the path rather than the parsed object: `state` above
      // is deliberately typed to just the shape this check reads.
      const cached = await browser.newContext({ storageState: STORAGE_STATE_PATH });
      const probe = await cached.request.get(`${baseURL}/api/auth/get-session`);
      const ok = probe.ok();
      const body = ok ? ((await probe.json()) as { user?: { username?: string } } | null) : null;
      await cached.close();
      if (ok && body?.user?.username === username) {
        await browser.close();
        return;
      }
    } catch {
      // fall through to a fresh sign-in
    }
  }

  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // Force English for locale-deterministic e2e. Persisted via storageState so
  // subsequent workers inherit it.
  await page.evaluate(() => localStorage.setItem("blackhouse-lang", "en"));
  await page.getByPlaceholder("username").fill(username);
  await page.getByPlaceholder("********").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // Post-login lands on `/channels`, which redirects again to
  // `/channels/general` (see `src/App.tsx`). The pattern matches both hops.
  await page.waitForURL(/\/channels/, { timeout: 15000 });
  await page.waitForLoadState("domcontentloaded");

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  // Sentinel referenced by no other code; keeps a stale cookie from silently
  // carrying across servers.
  writeFileSync("tests/e2e/.auth/.created", new Date().toISOString());
}
