import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit, _resetRateLimitForTests } from "../../server/lib/messaging-rate-limit.js";

describe("messaging rate-limit", () => {
  beforeEach(() => {
    _resetRateLimitForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows traffic below per-session limit", () => {
    for (let i = 0; i < 100; i++) {
      const r = checkRateLimit("sess-a", "user-1");
      expect(r.ok).toBe(true);
    }
  });

  it("blocks at the per-session limit (100/min)", () => {
    for (let i = 0; i < 100; i++) checkRateLimit("sess-a", "user-1");
    const r = checkRateLimit("sess-a", "user-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("blocks at the per-user limit (1000/min, across sessions)", () => {
    // 10 sessions × 100 msgs = 1000 — hits user cap first if session cap
    // doesn't trip.
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 100; i++) checkRateLimit(`sess-${s}`, "user-1");
    }
    const r = checkRateLimit("sess-fresh", "user-1");
    expect(r.ok).toBe(false);
  });

  it("does not charge buckets when rejecting", () => {
    for (let i = 0; i < 100; i++) checkRateLimit("sess-a", "user-1");
    // Block — this must NOT increment the bucket past 100.
    checkRateLimit("sess-a", "user-1");
    // Advance 61s; should now be allowed again because the original
    // batch has fully expired.
    vi.advanceTimersByTime(61_000);
    const r = checkRateLimit("sess-a", "user-1");
    expect(r.ok).toBe(true);
  });

  it("isolates per-session buckets", () => {
    for (let i = 0; i < 100; i++) checkRateLimit("sess-a", "user-1");
    // sess-a is at limit; sess-b (same user) should still pass until
    // it also reaches its own limit.
    const r = checkRateLimit("sess-b", "user-1");
    expect(r.ok).toBe(true);
  });

  it("isolates per-user buckets", () => {
    // Burn user-1's session budget; user-2 should be unaffected.
    for (let i = 0; i < 100; i++) checkRateLimit("sess-a", "user-1");
    const r = checkRateLimit("sess-x", "user-2");
    expect(r.ok).toBe(true);
  });

  it("rolls forward after window expiry", () => {
    for (let i = 0; i < 100; i++) checkRateLimit("sess-a", "user-1");
    vi.advanceTimersByTime(60_001);
    const r = checkRateLimit("sess-a", "user-1");
    expect(r.ok).toBe(true);
  });
});
