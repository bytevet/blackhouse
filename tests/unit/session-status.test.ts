import { describe, it, expect } from "vitest";
import { sessionStatusConfig } from "@/lib/session-status";
import { SESSION_STATUSES } from "@/db/schema";

describe("sessionStatusConfig", () => {
  it("should have entries for all session statuses", () => {
    for (const status of SESSION_STATUSES) {
      expect(sessionStatusConfig).toHaveProperty(status);
    }
  });

  it("should have exactly 4 status entries", () => {
    expect(Object.keys(sessionStatusConfig)).toHaveLength(4);
  });

  it("should have className and label for every entry", () => {
    for (const status of SESSION_STATUSES) {
      const entry = sessionStatusConfig[status];
      expect(entry).toHaveProperty("className");
      expect(entry).toHaveProperty("label");
      expect(typeof entry.className).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(entry.className.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  describe("color patterns", () => {
    it("should use green classes for running", () => {
      expect(sessionStatusConfig.running.className).toContain("green");
    });

    it("should use yellow classes for stopped", () => {
      expect(sessionStatusConfig.stopped.className).toContain("yellow");
    });

    it("should use blue classes for pending", () => {
      expect(sessionStatusConfig.pending.className).toContain("blue");
    });

    it("should use red classes for destroyed", () => {
      expect(sessionStatusConfig.destroyed.className).toContain("red");
    });
  });

  describe("labels", () => {
    it("should have capitalized labels", () => {
      expect(sessionStatusConfig.running.label).toBe("Running");
      expect(sessionStatusConfig.stopped.label).toBe("Stopped");
      expect(sessionStatusConfig.pending.label).toBe("Pending");
      expect(sessionStatusConfig.destroyed.label).toBe("Destroyed");
    });
  });
});
