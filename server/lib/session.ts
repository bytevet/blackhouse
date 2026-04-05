import type { Context } from "hono";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

type AuthUser = { id: string; role?: string | null };

/**
 * Fetch a coding session by ID and verify the requesting user
 * is either the owner or an admin. Returns the full session row.
 */
export async function requireSessionAccess(sessionId: string, user: AuthUser) {
  const [row] = await db
    .select()
    .from(schema.codingSessions)
    .where(eq(schema.codingSessions.id, sessionId))
    .limit(1);

  if (!row) throw new SessionAccessError("Session not found", 404);
  if (row.userId !== user.id && user.role !== "admin") {
    throw new SessionAccessError("Forbidden", 403);
  }
  return row;
}

type ErrorStatus = 400 | 403 | 404;

export class SessionAccessError extends Error {
  constructor(
    message: string,
    public status: ErrorStatus,
  ) {
    super(message);
    this.name = "SessionAccessError";
  }
}

/** Shared Hono onError handler for SessionAccessError. */
export function handleSessionAccessError(err: Error, c: Context) {
  if (err instanceof SessionAccessError) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}
