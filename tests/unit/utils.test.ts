import { describe, it, expect, vi, afterEach } from "vitest";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";

describe("cn()", () => {
  it("should merge class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("should handle conditional classes", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  it("should merge conflicting tailwind classes (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("should handle empty inputs", () => {
    expect(cn()).toBe("");
  });

  it("should handle undefined and null inputs", () => {
    expect(cn("base", undefined, null)).toBe("base");
  });

  it("should handle arrays of classes", () => {
    expect(cn(["px-2", "py-1"])).toBe("px-2 py-1");
  });
});

describe("timeAgo()", () => {
  // #55: `timeAgo` migrated from hardcoded abbreviations ("5m ago") to
  // `Intl.RelativeTimeFormat` so non-English locales get correct phrasing for
  // free. With { numeric: "auto" } in `en`, 0s → "now"; 1-59s → "N seconds ago";
  // ≥60s → minute/hour/day/month buckets. Exact strings may vary slightly with
  // future ICU CLDR updates, so we anchor on substrings where helpful.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should treat dates less than 60 seconds ago as 'now' or 'seconds ago'", () => {
    const now = new Date();
    expect(timeAgo(now)).toMatch(/now|second/);
  });

  it("should report 30 seconds ago as a seconds-style relative", () => {
    const date = new Date(Date.now() - 30 * 1000);
    expect(timeAgo(date)).toMatch(/30 seconds ago|now/);
  });

  it("should return minutes for dates 1-59 minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(timeAgo(fiveMinAgo)).toBe("5 minutes ago");
  });

  it("should return '1 minute ago' for exactly 60 seconds", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    expect(timeAgo(oneMinAgo)).toBe("1 minute ago");
  });

  it("should return hours for dates 1-23 hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(timeAgo(threeHoursAgo)).toBe("3 hours ago");
  });

  it("should return days for dates 1-29 days ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(timeAgo(twoDaysAgo)).toBe("2 days ago");
  });

  it("should return months for dates 30+ days ago", () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(timeAgo(sixtyDaysAgo)).toBe("2 months ago");
  });

  it("should accept a string date", () => {
    const dateStr = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(timeAgo(dateStr)).toBe("10 minutes ago");
  });

  it("should return '1 hour ago' for exactly 60 minutes", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(timeAgo(oneHourAgo)).toBe("1 hour ago");
  });

  it("should return 'yesterday' (or '1 day ago') for exactly 24 hours", () => {
    // `numeric: "auto"` yields "yesterday" for -1 day; numeric mode would yield
    // "1 day ago". Accept either to keep the test stable across ICU versions.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(timeAgo(oneDayAgo)).toMatch(/yesterday|1 day ago/);
  });
});
