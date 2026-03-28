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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return 'just now' for dates less than 60 seconds ago", () => {
    const now = new Date();
    expect(timeAgo(now)).toBe("just now");
  });

  it("should return 'just now' for dates 30 seconds ago", () => {
    const date = new Date(Date.now() - 30 * 1000);
    expect(timeAgo(date)).toBe("just now");
  });

  it("should return minutes for dates 1-59 minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(timeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("should return '1m ago' for exactly 60 seconds", () => {
    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    expect(timeAgo(oneMinAgo)).toBe("1m ago");
  });

  it("should return hours for dates 1-23 hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("should return days for dates 1-29 days ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(timeAgo(twoDaysAgo)).toBe("2d ago");
  });

  it("should return months for dates 30+ days ago", () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    expect(timeAgo(sixtyDaysAgo)).toBe("2mo ago");
  });

  it("should accept a string date", () => {
    const dateStr = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(timeAgo(dateStr)).toBe("10m ago");
  });

  it("should return '1h ago' for exactly 60 minutes", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(timeAgo(oneHourAgo)).toBe("1h ago");
  });

  it("should return '1d ago' for exactly 24 hours", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(timeAgo(oneDayAgo)).toBe("1d ago");
  });
});
