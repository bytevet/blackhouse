import { chromium, type FullConfig, type APIRequestContext } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

const STORAGE_STATE_PATH = "tests/e2e/.auth/admin.json";

/**
 * Sweep leftover E2E-named sessions + templates at the end of a Playwright run.
 *
 * Docker-gated tests each spawn a ~3 GB Podman container; when a test fails
 * mid-flight its inline `cleanupSession` never runs and the container leaks.
 * Across back-to-back runs that accumulates resource pressure on the Podman
 * VM and causes unrelated tests to flake (see task #32). Tests that succeed
 * and cleaned themselves up are no-ops here.
 *
 * Name patterns: every E2E-created session/template starts with "E2E " (the
 * "WS Test" prefix from the WebSocket suite is the only outlier).
 */
const isE2eName = (n: string) => /^(E2E|WS Test)/i.test(n);

async function sweep(
  request: APIRequestContext,
  listUrl: string,
  deleteUrlForId: (id: string) => string,
  kind: string,
) {
  const res = await request.get(listUrl);
  if (!res.ok()) return;
  const body = (await res.json()) as { data?: Array<{ id: string; name: string }> };
  const leftover = (body.data ?? []).filter((x) => isE2eName(x.name));
  if (leftover.length === 0) return;
  console.log(`[global-teardown] sweeping ${leftover.length} leftover E2E ${kind}(s)`);
  await Promise.all(leftover.map((x) => request.delete(deleteUrlForId(x.id)).catch(() => {})));
}

export default async function globalTeardown(_config: FullConfig) {
  if (!existsSync(STORAGE_STATE_PATH)) return;
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: JSON.parse(readFileSync(STORAGE_STATE_PATH, "utf-8")),
  });

  try {
    await sweep(
      context.request,
      `${baseURL}/api/sessions`,
      (id) => `${baseURL}/api/sessions/${id}`,
      "session",
    );
    // Templates: the create/edit/delete test leaves "E2E Test Template" /
    // "E2E Updated Template" behind if it fails mid-flight.
    await sweep(
      context.request,
      `${baseURL}/api/templates?mine=true&page=1&perPage=50`,
      (id) => `${baseURL}/api/templates/${id}`,
      "template",
    );
  } finally {
    await browser.close();
  }
}
