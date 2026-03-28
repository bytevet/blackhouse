/**
 * Seed script — creates initial admin user and default agent configs.
 * Usage: npx tsx scripts/seed.ts
 */
import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";

async function seed() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool, { schema });

  // Seed default agent configs
  const agentConfigs = [
    {
      agentType: "claude-code",
      displayName: "Claude Code",
      dockerImage: "blackhouse-session:latest",
      yoloMode: true,
      defaultModel: "claude-sonnet-4-20250514",
    },
    {
      agentType: "codex",
      displayName: "OpenAI Codex CLI",
      dockerImage: "blackhouse-session:latest",
      yoloMode: true,
    },
    {
      agentType: "gemini",
      displayName: "Gemini CLI",
      dockerImage: "blackhouse-session:latest",
      yoloMode: true,
    },
  ];

  for (const config of agentConfigs) {
    await db
      .insert(schema.agentConfigs)
      .values(config)
      .onConflictDoNothing({ target: schema.agentConfigs.agentType });
  }

  // Seed default docker config
  await db
    .insert(schema.dockerConfigs)
    .values({ id: 1, socketPath: "/var/run/docker.sock" })
    .onConflictDoNothing({ target: schema.dockerConfigs.id });

  console.log("Seed completed successfully.");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
