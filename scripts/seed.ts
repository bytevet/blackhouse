/**
 * Seed script — creates initial admin user and default agent configs.
 * Usage: npx tsx scripts/seed.ts
 */
import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";

async function seed() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool, { schema });

  // Seed default admin user (admin / admin123)
  const existingAdmin = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.role, "admin"))
    .limit(1);

  if (existingAdmin.length === 0) {
    // Use Better Auth's sign-up endpoint directly
    const authUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    try {
      const res = await fetch(`${authUrl}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Admin",
          email: "admin@blackhouse.local",
          password: "admin123",
          username: "admin",
        }),
      });
      if (res.ok) {
        // Promote to admin
        await db
          .update(schema.user)
          .set({ role: "admin" })
          .where(eq(schema.user.email, "admin@blackhouse.local"));
        console.log("Default admin user created (username: admin, password: admin123)");
      } else {
        // Server may not be running; create user directly in DB
        console.log("Auth server not reachable. Creating admin user directly in DB...");
        const { nanoid } = await import("nanoid").catch(() => ({
          nanoid: () => crypto.randomUUID(),
        }));
        const bcrypt = await import("bcryptjs").catch(() => null);

        const userId = nanoid();
        const hashedPassword = bcrypt ? await bcrypt.hash("admin123", 10) : "admin123";

        await db
          .insert(schema.user)
          .values({
            id: userId,
            name: "Admin",
            email: "admin@blackhouse.local",
            emailVerified: true,
            role: "admin",
            username: "admin",
          })
          .onConflictDoNothing({ target: schema.user.email });

        // Create account entry for password login
        await db
          .insert(schema.account)
          .values({
            id: crypto.randomUUID(),
            accountId: userId,
            providerId: "credential",
            userId: userId,
            password: hashedPassword,
          })
          .onConflictDoNothing();

        console.log("Admin user created directly (username: admin, password: admin123)");
      }
    } catch {
      console.log("Could not reach auth server. Skipping admin user creation.");
      console.log("Run the seed again after starting the app: npm run db:seed");
    }
  } else {
    console.log("Admin user already exists, skipping.");
  }

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
