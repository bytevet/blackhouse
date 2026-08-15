import { chromium, type FullConfig, type APIRequestContext } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

const STORAGE_STATE_PATH = "tests/e2e/.auth/admin.json";

/**
 * Sweep leftover E2E-created objects at the end of a Playwright run.
 *
 * A test that fails mid-flight never reaches its inline cleanup. Agents are the
 * expensive case: under `E2E_DOCKER=1` each started agent holds a multi-GB
 * container, and across back-to-back runs that accumulates until unrelated
 * specs start flaking. Tests that cleaned up after themselves are no-ops here.
 *
 * Naming contract (`helpers.ts`): agent handles and channel slugs start with
 * `e2e`, blueprint names and member emails with `E2E ` / `e2e-`.
 */
const isE2eAgent = (handle: string) => /^e2e[-_]/i.test(handle);
const isE2eBlueprint = (name: string) => /^E2E\b/i.test(name);
const isE2eEmail = (email: string) => /^e2e-/i.test(email);

async function sweep<T>(
  request: APIRequestContext,
  kind: string,
  listUrl: string,
  rows: (body: unknown) => T[],
  keep: (row: T) => boolean,
  deleteUrl: (row: T) => string,
) {
  const res = await request.get(listUrl);
  if (!res.ok()) return;
  const leftover = rows(await res.json()).filter(keep);
  if (leftover.length === 0) return;
  console.log(`[global-teardown] sweeping ${leftover.length} leftover E2E ${kind}(s)`);
  await Promise.all(leftover.map((row) => request.delete(deleteUrl(row)).catch(() => {})));
}

export default async function globalTeardown(_config: FullConfig) {
  if (!existsSync(STORAGE_STATE_PATH)) return;
  const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: JSON.parse(readFileSync(STORAGE_STATE_PATH, "utf-8")),
  });

  try {
    // Agents first: destroying one force-removes its container, which is the
    // resource that actually hurts if it leaks.
    await sweep<{ id: string; handle: string }>(
      context.request,
      "agent",
      `${baseURL}/api/agents`,
      (body) => (Array.isArray(body) ? (body as { id: string; handle: string }[]) : []),
      (row) => isE2eAgent(row.handle),
      (row) => `${baseURL}/api/agents/${row.id}`,
    );

    await sweep<{ id: string; name: string }>(
      context.request,
      "blueprint",
      `${baseURL}/api/settings/blueprints`,
      (body) => (Array.isArray(body) ? (body as { id: string; name: string }[]) : []),
      (row) => isE2eBlueprint(row.name),
      (row) => `${baseURL}/api/settings/blueprints/${row.id}`,
    );

    await sweep<{ id: string; email: string }>(
      context.request,
      "member",
      `${baseURL}/api/settings/users?page=1&perPage=100`,
      (body) => {
        const data = (body as { data?: unknown }).data;
        return Array.isArray(data) ? (data as { id: string; email: string }[]) : [];
      },
      (row) => isE2eEmail(row.email),
      (row) => `${baseURL}/api/settings/users/${row.id}`,
    );

    // Channels are deliberately absent: the API has no delete route, so no spec
    // creates one server-side. The create-channel dialog is client-state only.
  } finally {
    await browser.close();
  }
}
