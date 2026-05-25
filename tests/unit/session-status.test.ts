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

  it("should have className and i18n keys for every entry", () => {
    for (const status of SESSION_STATUSES) {
      const entry = sessionStatusConfig[status];
      expect(entry).toHaveProperty("className");
      expect(entry).toHaveProperty("labelKey");
      expect(entry).toHaveProperty("workerLabelKey");
      expect(typeof entry.className).toBe("string");
      expect(typeof entry.labelKey).toBe("string");
      expect(typeof entry.workerLabelKey).toBe("string");
      expect(entry.className.length).toBeGreaterThan(0);
      expect(entry.labelKey.length).toBeGreaterThan(0);
      expect(entry.workerLabelKey.length).toBeGreaterThan(0);
    }
  });

  describe("color patterns", () => {
    // Status classes now use the semantic tokens introduced in #52
    // (success/warning/info/error) so the same status reads the same hue
    // across pages and respects dark-mode token swaps.
    it("should use the success token for running", () => {
      expect(sessionStatusConfig.running.className).toContain("success");
    });

    it("should use the warning token for stopped", () => {
      expect(sessionStatusConfig.stopped.className).toContain("warning");
    });

    it("should use the info token for pending", () => {
      expect(sessionStatusConfig.pending.className).toContain("info");
    });

    it("should use the error token for destroyed", () => {
      expect(sessionStatusConfig.destroyed.className).toContain("error");
    });
  });

  describe("labelKeys", () => {
    // #55 migrated label fields from literal strings to i18n keys, so the
    // status vocabulary lives in `src/i18n/locales/*.json` (translator-
    // editable) and consumers resolve via `useTranslation().t()`.
    it("should expose the worker-themed i18n keys", () => {
      expect(sessionStatusConfig.running.labelKey).toBe("status.onDuty");
      expect(sessionStatusConfig.stopped.labelKey).toBe("status.offDuty");
      expect(sessionStatusConfig.pending.labelKey).toBe("status.pending");
      expect(sessionStatusConfig.destroyed.labelKey).toBe("status.terminated");
    });
  });
});
