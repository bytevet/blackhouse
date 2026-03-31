import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "./index.js";
import * as schema from "./schema.js";

export async function runSeed() {
  // Seed default admin user
  const existingAdmin = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.username, "admin"))
    .limit(1);

  if (existingAdmin.length === 0) {
    const { hashPassword } = await import("better-auth/crypto");

    const password = process.env.ADMIN_PASSWORD || randomBytes(16).toString("base64url");
    const userId = crypto.randomUUID();
    const hashedPassword = await hashPassword(password);

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

    console.log(`[blackhouse] Default admin user created (username: admin, password: ${password})`);
  }

  // Seed default agent configs
  const existingConfigs = await db.select().from(schema.agentConfigs).limit(1);

  if (existingConfigs.length === 0) {
    await db.insert(schema.agentConfigs).values([
      {
        preset: "claude-code",
        displayName: "Claude Code",
        agentCommand: "claude --dangerously-skip-permissions",
        volumeMounts: [
          { name: "claude-config", mountPath: "/home/workspace/.claude" },
          { name: "claude-auth", mountPath: "/home/workspace/.config/claude-auth" },
        ],
      },
      {
        preset: "gemini",
        displayName: "Gemini",
        agentCommand: "gemini --yolo",
        volumeMounts: [{ name: "gemini-config", mountPath: "/home/workspace/.gemini" }],
      },
      {
        preset: "codex",
        displayName: "Codex",
        agentCommand: "codex --full-auto",
        volumeMounts: [{ name: "codex-config", mountPath: "/home/workspace/.codex" }],
      },
    ]);
    console.log("[blackhouse] Default agent configs created.");
  }

  // Seed default docker config
  await db
    .insert(schema.dockerConfigs)
    .values({ id: 1, socketPath: "/var/run/docker.sock" })
    .onConflictDoNothing({ target: schema.dockerConfigs.id });
}
