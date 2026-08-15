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

  // Seed default non-admin user for e2e + dev convenience. Known
  // credential (`user` / `test1234`) so qa's cross-user 403 test has a
  // deterministic non-admin identity to sign in as. Created only when
  // missing — re-running the seed never overwrites an existing user's
  // password, so an operator who renames/recustomizes this account
  // keeps their changes. Blast radius is low: role=user means no admin
  // surface; the account has no sessions or templates until they're
  // explicitly created.
  const existingTestUser = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.username, "user"))
    .limit(1);

  if (existingTestUser.length === 0) {
    const userId = crypto.randomUUID();
    const hashedPassword = await hashPassword("test1234");
    await db
      .insert(schema.user)
      .values({
        id: userId,
        name: "Test User",
        email: "user@blackhouse.local",
        emailVerified: true,
        role: "user",
        username: "user",
      })
      .onConflictDoNothing({ target: schema.user.email });

    await db
      .insert(schema.account)
      .values({
        id: crypto.randomUUID(),
        accountId: userId,
        providerId: "credential",
        userId,
        password: hashedPassword,
      })
      .onConflictDoNothing();

    console.log("[blackhouse] Default non-admin user created (username: user, password: test1234)");
  }

  // Seed default agent blueprints.
  //
  // Note what is deliberately NOT here: a shared `claude-config` volume mounted
  // at `~/.claude`. Every agent gets its own state volume (see
  // `server/agents/lifecycle.ts`), because the sidecar tails
  // `~/.claude/projects` for the channel transcript — one shared volume would
  // let every agent read every other agent's conversation.
  //
  // `*-auth` volumes ARE shared: they hold provider credentials, which is the
  // one thing agents legitimately have in common.
  const existingBlueprints = await db.select().from(schema.agentBlueprints).limit(1);

  if (existingBlueprints.length === 0) {
    await db.insert(schema.agentBlueprints).values([
      {
        cli: "claude-code",
        name: "Claude Code",
        description: "Anthropic's CLI. Rich structured transcripts via session JSONL.",
        agentCommand: "claude --dangerously-skip-permissions",
        stateMountPath: "/home/workspace",
        volumeMounts: [{ name: "claude-auth", mountPath: "/home/workspace/.config/claude-auth" }],
      },
      {
        cli: "antigravity",
        name: "Antigravity",
        description: "Transcript is PTY-scraped server-side; no in-container adapter.",
        agentCommand: "agy --dangerously-skip-permissions",
        stateMountPath: "/home/workspace",
        // `agy` writes config to `~/.gemini` (it inherits Gemini's layout).
        volumeMounts: [{ name: "antigravity-auth", mountPath: "/home/workspace/.gemini-auth" }],
      },
      {
        cli: "codex",
        name: "Codex",
        description: "Transcript is PTY-scraped server-side; no in-container adapter.",
        agentCommand: "codex --sandbox workspace-write --ask-for-approval on-request",
        stateMountPath: "/home/workspace",
        volumeMounts: [{ name: "codex-auth", mountPath: "/home/workspace/.codex-auth" }],
      },
    ]);
    console.log("[blackhouse] Default agent blueprints created.");
  }

  // Seed a default channel so a fresh install has somewhere to talk.
  const existingChannels = await db.select().from(schema.channels).limit(1);
  if (existingChannels.length === 0) {
    await db.insert(schema.channels).values({
      slug: "general",
      name: "general",
      topic: "Everything, until it needs its own room.",
    });
    console.log("[blackhouse] Default #general channel created.");
  }

  // Seed default docker config
  await db
    .insert(schema.dockerConfigs)
    .values({ id: 1, socketPath: "/var/run/docker.sock" })
    .onConflictDoNothing({ target: schema.dockerConfigs.id });
}
