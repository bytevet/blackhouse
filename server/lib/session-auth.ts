import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { codingSessions, session as authSession, user } from "../db/schema.js";

/**
 * Authenticate a WebSocket / proxy request that targets a specific coding
 * session. Used by routes where the upstream is the container — terminal,
 * browser-service, and the IDE proxy — and where `authMiddleware` cookies
 * may not be available (e.g. WS upgrade with a query-string token).
 *
 * Authorizes if:
 *   - the coding session exists and is `running` with a containerId, AND
 *   - if `token` is provided, it maps to a valid Better Auth session whose
 *     user owns this coding session OR has the `admin` role.
 *
 * Returns `{ containerId }` on success, `null` otherwise.
 */
export async function validateSessionForContainer(
  sessionId: string,
  token?: string,
): Promise<{ containerId: string } | null> {
  const [codingSession] = await db
    .select()
    .from(codingSessions)
    .where(eq(codingSessions.id, sessionId))
    .limit(1);

  if (!codingSession || !codingSession.containerId) return null;
  if (codingSession.status !== "running") return null;

  if (token) {
    const [authSess] = await db
      .select()
      .from(authSession)
      .where(eq(authSession.token, token))
      .limit(1);

    if (!authSess) return null;

    if (codingSession.userId !== authSess.userId) {
      const [usr] = await db.select().from(user).where(eq(user.id, authSess.userId)).limit(1);
      if (!usr || usr.role !== "admin") return null;
    }
  }

  return { containerId: codingSession.containerId };
}
