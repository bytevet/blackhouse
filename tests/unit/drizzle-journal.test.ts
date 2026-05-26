import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard against the migration-skip footgun seen with 0005_session_messages:
 * drizzle-kit timestamps each journal entry with Date.now() at gen time,
 * and Drizzle's migrator orders by `when`. If a generator's clock drifts
 * backwards (fresh clone in a stale-clock container, system clock changed,
 * etc.) the new entry can land with a `when` older than the previous one
 * — Drizzle then treats the new migration as already-applied and silently
 * skips it. Fresh DBs miss the migration entirely; production DBs are
 * fine only because they already have the previous max in their tracking
 * table.
 *
 * Enforce strict monotonicity at unit-test time so a bad journal can
 * never reach main.
 */
describe("drizzle migration journal", () => {
  it("has strictly-increasing `when` timestamps across entries", () => {
    const journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json");
    const raw = readFileSync(journalPath, "utf-8");
    const journal = JSON.parse(raw) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };

    expect(journal.entries.length).toBeGreaterThan(0);

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1];
      const curr = journal.entries[i];
      expect(
        curr.when,
        `entry ${curr.tag} (idx ${curr.idx}) has when=${curr.when} which is not > previous ${prev.tag}.when=${prev.when} — Drizzle would silently skip this migration on fresh DBs.`,
      ).toBeGreaterThan(prev.when);
    }
  });

  it("has strictly-increasing `idx` values starting from 0", () => {
    const journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json");
    const raw = readFileSync(journalPath, "utf-8");
    const journal = JSON.parse(raw) as {
      entries: Array<{ idx: number; tag: string }>;
    };

    for (let i = 0; i < journal.entries.length; i++) {
      expect(journal.entries[i].idx).toBe(i);
    }
  });
});
