import { describe, it, expect } from "vitest";
import { codename } from "@/lib/codename";

describe("codename", () => {
  it("is deterministic for a given seed", () => {
    expect(codename("session-1")).toBe(codename("session-1"));
    expect(codename("")).toBe(codename(""));
    expect(codename("a-very-long-seed-string-12345")).toBe(
      codename("a-very-long-seed-string-12345"),
    );
  });

  it("returns a non-empty adjective-animal slug", () => {
    const out = codename("anything");
    expect(out).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("doesn't throw on 100 random seeds and stays in the slug shape", () => {
    for (let i = 0; i < 100; i++) {
      const seed = Math.random().toString(36) + Math.random().toString(36);
      const out = codename(seed);
      expect(out).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });

  it("doesn't collide cheaply on seeds with shared prefixes", () => {
    // FNV-1a avalanche-mixes per-char, so single-char differences should
    // produce different outputs in the overwhelming majority of cases.
    // Verify across a batch — at most a small fraction should collide.
    const base = "session-id-";
    const seen = new Map<string, string[]>();
    for (let i = 0; i < 200; i++) {
      const seed = base + i;
      const name = codename(seed);
      const list = seen.get(name) ?? [];
      list.push(seed);
      seen.set(name, list);
    }
    // 200 seeds into 2500-slot space, expected collisions ~7-8.
    // Allow up to 20 to keep the test stable against hash-distribution drift.
    let collisions = 0;
    for (const seeds of seen.values()) {
      if (seeds.length > 1) collisions += seeds.length - 1;
    }
    expect(collisions).toBeLessThan(20);
  });

  it("produces different names for materially different seeds", () => {
    // Specific spot-check — these two seeds should not collide.
    expect(codename("session-abc")).not.toBe(codename("session-def"));
    expect(codename("0")).not.toBe(codename("1"));
  });
});
