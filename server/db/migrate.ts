import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Applies pending migrations at boot, before the server accepts requests.
 *
 * This THROWS on failure. It used to `console.warn` and continue, which was
 * survivable while migrations were additive but is not survivable now: the
 * multi-agent baseline drops the legacy schema, so a partially-applied
 * migration leaves a process that boots, answers health checks, and fails
 * every query. Crashing on boot is the loud, recoverable failure; a
 * booting-but-broken app is the quiet, destructive one.
 *
 * `BLACKHOUSE_MIGRATE_LENIENT=1` restores the old warn-and-continue
 * behaviour. It exists for the one legitimate case — a database whose schema
 * was applied out-of-band (`db:push` against a dev box) so the migration
 * replays as already-applied. Never set it in production.
 */
export async function runMigrations() {
  const lenient = process.env.BLACKHOUSE_MIGRATE_LENIENT === "1";
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } catch (err) {
    if (!lenient) {
      console.error("[blackhouse] Migration failed — refusing to start:", err);
      throw err;
    }
    console.warn(
      "[blackhouse] Migration warning (BLACKHOUSE_MIGRATE_LENIENT=1, continuing anyway):",
      (err as Error).message,
    );
  } finally {
    // Always released: on the throwing path the process is about to exit,
    // but an unclosed pool keeps the event loop alive and turns a fast
    // crash into a hang.
    await pool.end();
  }
}
