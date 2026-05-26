import { and, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "./index.js";
import * as schema from "./schema.js";

export async function runSeed() {
  const { hashPassword } = await import("better-auth/crypto");

  // Seed default admin user
  const existingAdmin = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.username, "admin"))
    .limit(1);

  if (existingAdmin.length === 0) {
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
  } else if (process.env.ADMIN_PASSWORD) {
    // Admin exists AND operator pinned ADMIN_PASSWORD — reconcile the credential.
    // This is the "idempotent admin password" semantic: re-running the seed
    // with a different ADMIN_PASSWORD updates the existing admin's hash.
    // No-op when ADMIN_PASSWORD is unset (otherwise we'd lock the user out
    // of their existing chosen password on every restart).
    const adminUser = existingAdmin[0];
    const hashedPassword = await hashPassword(process.env.ADMIN_PASSWORD);
    const updated = await db
      .update(schema.account)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(
        and(eq(schema.account.userId, adminUser.id), eq(schema.account.providerId, "credential")),
      )
      .returning({ id: schema.account.id });

    if (updated.length > 0) {
      console.log("[blackhouse] Admin password reconciled from ADMIN_PASSWORD env.");
    }
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
        preset: "antigravity",
        displayName: "Antigravity",
        agentCommand: "agy --dangerously-skip-permissions",
        // `agy` writes config to `~/.gemini` (inherits Gemini's layout) —
        // see agent-presets.ts comment and 0004 migration.
        volumeMounts: [{ name: "antigravity-config", mountPath: "/home/workspace/.gemini" }],
      },
      {
        preset: "codex",
        displayName: "Codex",
        agentCommand: "codex --sandbox workspace-write --ask-for-approval on-request",
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
