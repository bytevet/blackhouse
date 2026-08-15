import { describe, it, expect } from "vitest";
import { nextRunAt } from "../../server/lib/scheduler.js";

/** Local-time helper — the scheduler works in the server's local zone. */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("nextRunAt", () => {
  it("advances to the next minute for a wildcard schedule", () => {
    expect(nextRunAt("* * * * *", at(2026, 3, 1, 9, 30))).toEqual(at(2026, 3, 1, 9, 31));
  });

  it("never returns the current minute, so a schedule cannot double-fire", () => {
    const now = at(2026, 3, 1, 9, 30);
    const next = nextRunAt("30 9 * * *", now)!;
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next).toEqual(at(2026, 3, 2, 9, 30));
  });

  it("finds the next daily occurrence", () => {
    expect(nextRunAt("0 3 * * *", at(2026, 3, 1, 9, 30))).toEqual(at(2026, 3, 2, 3, 0));
    expect(nextRunAt("0 3 * * *", at(2026, 3, 1, 1, 0))).toEqual(at(2026, 3, 1, 3, 0));
  });

  it("handles step values", () => {
    expect(nextRunAt("*/15 * * * *", at(2026, 3, 1, 9, 31))).toEqual(at(2026, 3, 1, 9, 45));
    expect(nextRunAt("0 */6 * * *", at(2026, 3, 1, 7, 0))).toEqual(at(2026, 3, 1, 12, 0));
  });

  it("handles comma lists and ranges", () => {
    expect(nextRunAt("0,30 * * * *", at(2026, 3, 1, 9, 5))).toEqual(at(2026, 3, 1, 9, 30));
    expect(nextRunAt("0 9-17 * * *", at(2026, 3, 1, 20, 0))).toEqual(at(2026, 3, 2, 9, 0));
  });

  it("handles day-of-week schedules", () => {
    // 2026-03-01 is a Sunday; the next weekday 09:00 is Monday the 2nd.
    expect(nextRunAt("0 9 * * 1-5", at(2026, 3, 1, 12, 0))).toEqual(at(2026, 3, 2, 9, 0));
  });

  it("crosses a month boundary", () => {
    expect(nextRunAt("0 0 1 * *", at(2026, 3, 15, 12, 0))).toEqual(at(2026, 4, 1, 0, 0));
  });

  it("returns null for a malformed expression rather than guessing", () => {
    // A bad schedule must stay inert; firing it at the wrong time would be
    // worse than not firing it at all.
    expect(nextRunAt("", at(2026, 3, 1, 9, 0))).toBeNull();
    expect(nextRunAt("* * *", at(2026, 3, 1, 9, 0))).toBeNull();
    expect(nextRunAt("not a cron", at(2026, 3, 1, 9, 0))).toBeNull();
  });

  it("returns null for out-of-range and unsatisfiable fields", () => {
    expect(nextRunAt("99 * * * *", at(2026, 3, 1, 9, 0))).toBeNull();
    expect(nextRunAt("* 25 * * *", at(2026, 3, 1, 9, 0))).toBeNull();
    // February 30th never arrives.
    expect(nextRunAt("0 0 30 2 *", at(2026, 3, 1, 9, 0))).toBeNull();
  });

  it("tolerates extra whitespace", () => {
    expect(nextRunAt("  0   3  *  *  * ", at(2026, 3, 1, 1, 0))).toEqual(at(2026, 3, 1, 3, 0));
  });
});
