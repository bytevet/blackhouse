import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export async function runMigrations() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } catch (err) {
    // Migration may fail if DB already has the schema (e.g., from db:push).
    // Log and continue — the app will fail on first query if schema is actually wrong.
    console.warn("[blackhouse] Migration warning:", (err as Error).message);
  }
  await pool.end();
}
