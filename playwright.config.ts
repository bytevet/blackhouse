import { defineConfig, devices } from "@playwright/test";

// Workers + retries scale with E2E_DOCKER: docker-gated runs spawn ~3 GB
// agent containers (Chromium screencast + ffmpeg + code-server), and the
// Podman VM ships with a 3.8 GB memory cap. Default Playwright workers (~5)
// puts spawn-time peaks well over budget — qa observed lifecycle + terminal
// WS flakes at workers=5 (#66). Cap docker runs at 2 workers and grant one
// retry so a single overlap-peak doesn't take down a `.serial` describe.
// Non-docker runs keep Playwright's default parallelism.
const DOCKER_MODE = !!process.env.E2E_DOCKER;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: DOCKER_MODE ? 2 : undefined,
  retries: DOCKER_MODE ? 1 : 0,
  timeout: 30000,
  expect: { timeout: 10000 },
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
    storageState: "tests/e2e/.auth/admin.json",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(!process.env.E2E_BASE_URL && {
    webServer: {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60000,
    },
  }),
});
