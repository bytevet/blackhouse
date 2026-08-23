import { describe, expect, it } from "vitest";
import { describeEgress, describeResourceCaps } from "../../src/components/agent/agent-facts";

/**
 * The Agent Detail header used to render two hardcoded values as if they were
 * real: `mockBlueprint()` hashed the blueprint id into one of three invented
 * names, and a four-host `MOCK_EGRESS_ALLOWLIST` made every agent read
 * `allowlist · 4`. On the live deployment that badge sat over an agent whose
 * resolved policy was `open` — a safety surface claiming an isolation boundary
 * that did not exist.
 *
 * These are the two pure seams behind the fix. Both encode the same rule: an
 * absent or unenforced fact must render as absent, never as a plausible
 * default.
 */

describe("describeEgress", () => {
  it("counts the resolved allowlist rather than a fixed number", () => {
    expect(describeEgress("allowlist", 0).label).toBe("allowlist · 0");
    expect(describeEgress("allowlist", 1).detail).toContain("1 allowed host.");
    expect(describeEgress("allowlist", 12).label).toBe("allowlist · 12");
    expect(describeEgress("allowlist", 12).detail).toContain("12 allowed hosts.");
  });

  it("treats open as the permissive posture, whatever the rule count says", () => {
    // `resolveAgentEgress` returns `rules: ["*"]` for open, so a caller passing
    // `rules.length` hands this a 1. It must not become "allowlist · 1".
    const fact = describeEgress("open", 1);
    expect(fact.label).toBe("open");
    expect(fact.permissive).toBe(true);
    expect(fact.tone).toBe("warning");
  });

  it("demotes a restrictive policy that nothing enforces", () => {
    const enforced = describeEgress("allowlist", 4, true);
    expect(enforced.tone).toBe("success");
    expect(enforced.unenforced).toBe(false);

    // Same policy, no proxy applying it: the agent can reach any host, so the
    // badge must stop reading as a boundary.
    const unenforced = describeEgress("allowlist", 4, false);
    expect(unenforced.unenforced).toBe(true);
    expect(unenforced.tone).toBe("warning");
    expect(unenforced.permissive).toBe(true);
    expect(unenforced.detail).toContain("not applied");

    expect(describeEgress("none", 0, false).unenforced).toBe(true);
    // Unenforced open is still open — nothing to demote.
    expect(describeEgress("open", 1, false).unenforced).toBe(false);
  });
});

describe("describeResourceCaps", () => {
  it("formats caps in the units Docker means", () => {
    expect(describeResourceCaps({ nanoCpus: 2_000_000_000, memoryBytes: 4 * 1024 ** 3 })).toEqual({
      cpu: "2 vCPU",
      memory: "4 GiB",
    });
    expect(describeResourceCaps({ nanoCpus: 1_500_000_000, memoryBytes: 512 * 1024 ** 2 })).toEqual(
      {
        cpu: "1.5 vCPU",
        memory: "512 MiB",
      },
    );
  });

  it("reports an absent cap as absent instead of inventing one", () => {
    // Null is not "the default": an unset `memory_bytes` means the container
    // gets whatever the daemon allows, which is the opposite of the "4 GB RAM"
    // the mock blueprint printed for every agent.
    expect(describeResourceCaps({ nanoCpus: null, memoryBytes: null })).toEqual({
      cpu: null,
      memory: null,
    });
    expect(describeResourceCaps({ nanoCpus: 0, memoryBytes: 0 })).toEqual({
      cpu: null,
      memory: null,
    });
    expect(describeResourceCaps({ nanoCpus: 4_000_000_000, memoryBytes: null }).memory).toBeNull();
  });
});
