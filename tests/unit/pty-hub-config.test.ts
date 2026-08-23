import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { getPtyHub, resetPtyHub, configurePtyHub } from "../../server/agents/pty-hub.js";

/**
 * Regression cover for a bug found only by running against a real host.
 *
 * The hub used to be configured lazily inside the terminal WebSocket route, so
 * `getPtyHub()` threw "PtyHub not configured" for any code path that had not
 * been preceded by someone opening that agent's Terminal tab. Injecting a
 * channel mention is exactly such a path, so mentioning an agent failed the run
 * unless a human had visited its terminal first — the product's central feature,
 * broken in its ordinary case, with every unit test still green.
 */
describe("PTY hub configuration", () => {
  beforeEach(() => resetPtyHub());

  it("throws before configuration, which is what the injector hit", () => {
    expect(() => getPtyHub()).toThrow(/not configured/i);
  });

  it("is available to any consumer once configured", () => {
    configurePtyHub({
      resolveContainer: async () => null,
      getDocker: async () => ({}) as never,
    });
    expect(getPtyHub()).toBeDefined();
  });

  it("configuration is idempotent — startup and the WS route may both call it", () => {
    const a = configurePtyHub({
      resolveContainer: async () => null,
      getDocker: async () => ({}) as never,
    });
    const b = configurePtyHub({
      resolveContainer: async () => null,
      getDocker: async () => ({}) as never,
    });
    expect(a).toBe(b);
  });

  it("server startup configures the hub before serving requests", () => {
    // A source assertion on purpose: the failure mode was ordering, not logic.
    // Nothing else in the unit suite can observe "was this wired before a
    // request arrived", and that is precisely what regressed.
    const index = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/ensurePtyHubConfigured\(\)/);
    expect(index.indexOf("ensurePtyHubConfigured()")).toBeLessThan(index.indexOf("serve({"));
  });
});
