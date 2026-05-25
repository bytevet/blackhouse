import { chromium, type FullConfig } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

const STORAGE_STATE_PATH = "tests/e2e/.auth/admin.json";

/**
 * Sweep any leftover E2E-named sessions at the end of a Playwright run.
 *
 * The docker-gated tests each spawn a Podman container (~3 GB image). When a
 * test fails mid-flight, its session never reaches its own cleanup `DELETE
 * /api/sessions/:id` call and the container leaks. Across back-to-back runs
 * that accumulates resource pressure on the Podman VM and causes unrelated
 * tests to flake (see task #32 — the Templates create/edit/delete test
 * showed this pattern under load).
 *
 * This teardown lists all sessions named with our standard E2E prefixes and
 * destroys them via the API, freeing containers + DB rows before the next
 * run. Tests that succeed and cleaned themselves up are no-ops here.
 */
export default async function globalTeardown(_config: FullConfig) {
  if (!existsSync(STORAGE_STATE_PATH)) return;
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: JSON.parse(readFileSync(STORAGE_STATE_PATH, "utf-8")),
  });
  const isE2eName = (n: string) => /^(E2E|WS Test|QA Smoke)/i.test(n);

  try {
    // 1) Sweep leftover sessions (each backs a ~3GB Podman container).
    const sessRes = await context.request.get(`${baseURL}/api/sessions`);
    if (sessRes.ok()) {
      const body = (await sessRes.json()) as { data?: Array<{ id: string; name: string }> };
      const e2eSessions = (body.data ?? []).filter((s) => isE2eName(s.name));
      if (e2eSessions.length > 0) {
        console.log(`[global-teardown] sweeping ${e2eSessions.length} leftover E2E session(s)`);
        await Promise.all(
          e2eSessions.map((s) =>
            context.request.delete(`${baseURL}/api/sessions/${s.id}`).catch(() => {}),
          ),
        );
      }
    }

    // 2) Sweep leftover templates (the `Templates › can create, edit, and
    // delete` test creates "E2E Test Template" / "E2E Updated Template"; if
    // it fails mid-flight, those persist and accumulate across runs).
    const tplRes = await context.request.get(
      `${baseURL}/api/templates?mine=true&page=1&perPage=50`,
    );
    if (tplRes.ok()) {
      const body = (await tplRes.json()) as { data?: Array<{ id: string; name: string }> };
      const e2eTemplates = (body.data ?? []).filter((t) => isE2eName(t.name));
      if (e2eTemplates.length > 0) {
        console.log(`[global-teardown] sweeping ${e2eTemplates.length} leftover E2E template(s)`);
        await Promise.all(
          e2eTemplates.map((t) =>
            context.request.delete(`${baseURL}/api/templates/${t.id}`).catch(() => {}),
          ),
        );
      }
    }
  } finally {
    await browser.close();
  }
}
