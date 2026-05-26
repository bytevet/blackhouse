import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { codingSessions } from "../db/schema.js";

type CodingSessionRow = typeof codingSessions.$inferSelect;

export type AuthResult<T> = T | { error: string; status: 403 | 404 };

/**
 * Authenticate a request that carries a per-session token (`SESSION_TOKEN`
 * env var inside the container). Used by container-originated calls where
 * the Better Auth cookie isn't available — result submission, title updates,
 * and the messaging endpoints called by the in-container skill scripts.
 *
 * Returns `{ session }` on success, or `{ error, status }` with 404 if the
 * session doesn't exist and 403 if the token doesn't match. Wrapped in a
 * try/catch so a malformed UUID parameter (which Postgres rejects at parse
 * time) surfaces as a 404 rather than a 500.
 */
export async function authSessionToken(
  sessionId: string,
  token: string | undefined | null,
): Promise<AuthResult<{ session: CodingSessionRow }>> {
  if (!token) return { error: "Invalid token", status: 403 };
  try {
    const [session] = await db
      .select()
      .from(codingSessions)
      .where(eq(codingSessions.id, sessionId))
      .limit(1);
    if (!session) return { error: "Session not found", status: 404 };
    if (!session.sessionToken || session.sessionToken !== token) {
      return { error: "Invalid token", status: 403 };
    }
    return { session };
  } catch {
    return { error: "Session not found", status: 404 };
  }
}

/**
 * Authenticate a messaging call from one session to another. The caller
 * authenticates with the FROM session's token; we then load the TO session
 * and verify it belongs to the same user. 404 if either session is missing,
 * 403 if the token is bad OR the two sessions don't share a user.
 *
 * Both sessions are loaded in parallel — one wall-clock round trip.
 */
export async function authMessagingFromTo(
  fromSessionId: string,
  token: string | undefined | null,
  toSessionId: string,
): Promise<AuthResult<{ from: CodingSessionRow; to: CodingSessionRow }>> {
  if (!token) return { error: "Invalid token", status: 403 };
  try {
    const [[from], [to]] = await Promise.all([
      db.select().from(codingSessions).where(eq(codingSessions.id, fromSessionId)).limit(1),
      db.select().from(codingSessions).where(eq(codingSessions.id, toSessionId)).limit(1),
    ]);
    if (!from) return { error: "Session not found", status: 404 };
    if (!from.sessionToken || from.sessionToken !== token) {
      return { error: "Invalid token", status: 403 };
    }
    if (!to) return { error: "Target session not found", status: 404 };
    if (from.userId !== to.userId) {
      return { error: "Forbidden: target session belongs to a different user", status: 403 };
    }
    return { from, to };
  } catch {
    return { error: "Session not found", status: 404 };
  }
}
