import type { Context } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

type AuthUser = { id: string; role?: string | null };

/**
 * Fetch an agent by ID for a requesting user.
 *
 * Unlike the coding sessions this replaces, agents are **workspace-shared**:
 * Blackhouse is a small-team harness where `@reviewer` is a teammate everyone
 * can talk to, not a private resource. `agents.ownerId` records who created
 * the agent for attribution and is nullable — it is deliberately NOT an
 * access-control boundary.
 *
 * Any authenticated user may therefore read and mention any agent. Destructive
 * lifecycle operations (destroy, blueprint edits) gate on `adminMiddleware`
 * at the route instead. This function is kept as the single lookup point so
 * that if per-agent ACLs are ever added, there is exactly one place to add them.
 */
export async function requireAgentAccess(agentId: string, _user: AuthUser) {
  let row: typeof schema.agents.$inferSelect | undefined;
  try {
    [row] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  } catch {
    // A malformed UUID is rejected by Postgres at parse time; surface it as a
    // 404 rather than letting it become a 500.
    throw new AgentAccessError("Agent not found", 404);
  }

  if (!row) throw new AgentAccessError("Agent not found", 404);
  if (row.status === "destroyed") throw new AgentAccessError("Agent not found", 404);
  return row;
}

/** Resolve an agent by its `@handle` (case-insensitive — handles are stored lowercased). */
export async function findAgentByHandle(handle: string) {
  const normalized = handle.replace(/^@/, "").toLowerCase();
  const [row] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.handle, normalized))
    .limit(1);
  return row ?? null;
}

type ErrorStatus = 400 | 403 | 404 | 409;

export class AgentAccessError extends Error {
  constructor(
    message: string,
    public status: ErrorStatus,
  ) {
    super(message);
    this.name = "AgentAccessError";
  }
}

/** Shared Hono onError handler for AgentAccessError. */
export function handleAgentAccessError(err: Error, c: Context) {
  if (err instanceof AgentAccessError) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}
