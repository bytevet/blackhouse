import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents, session as authSession, user } from "../db/schema.js";

/**
 * Authenticate a WebSocket / proxy request that targets a specific agent's
 * container. Used by the routes whose upstream is the container itself —
 * terminal, browser-service, and the IDE proxy — where `authMiddleware`
 * cookies may not be available (e.g. a WS upgrade carrying a query-string
 * token).
 *
 * Authorizes if:
 *   - the agent exists, is `running`, and has a containerId, AND
 *   - if `token` is provided, it maps to a valid Better Auth session.
 *
 * Agents are workspace-shared (see `agent-access.ts`), so any signed-in user
 * may attach to any agent's terminal — that is the point of a shared harness,
 * and it matches the roster in the UI, which lists every agent to everyone.
 * The token check therefore establishes *authentication*, not ownership.
 *
 * Returns `{ containerId }` on success, `null` otherwise.
 */
export async function validateAgentForContainer(
  agentId: string,
  token?: string,
): Promise<{ containerId: string } | null> {
  let agent: typeof agents.$inferSelect | undefined;
  try {
    [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  } catch {
    // Malformed UUID — treat as not found rather than surfacing a 500.
    return null;
  }

  if (!agent || !agent.containerId) return null;
  if (agent.status !== "running") return null;

  if (token) {
    const [authSess] = await db
      .select()
      .from(authSession)
      .where(eq(authSession.token, token))
      .limit(1);

    if (!authSess) return null;
    if (authSess.expiresAt && authSess.expiresAt.getTime() < Date.now()) return null;

    // Confirm the session still maps to a live, unbanned user.
    const [usr] = await db.select().from(user).where(eq(user.id, authSess.userId)).limit(1);
    if (!usr || usr.banned) return null;
  }

  return { containerId: agent.containerId };
}
