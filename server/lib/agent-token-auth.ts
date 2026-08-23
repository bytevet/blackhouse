import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";

type AgentRow = typeof agents.$inferSelect;

export type AuthResult<T> = T | { error: string; status: 403 | 404 };

/**
 * Authenticate a request that carries a per-agent bearer token (`AGENT_TOKEN`
 * inside the container). Used by container-originated calls where no Better
 * Auth cookie exists: the sidecar's event/state ingest, and the in-container
 * skill scripts that post to channels, submit artifacts, and set the status line.
 *
 * Returns `{ agent }` on success, or `{ error, status }` — 404 if the agent
 * doesn't exist, 403 if the token doesn't match. The try/catch keeps a
 * malformed UUID (rejected by Postgres at parse time) a 404 rather than a 500.
 *
 * Note the comparison is a plain string equality on a 32-byte random token.
 * That is deliberate: these tokens are high-entropy and single-purpose, and
 * a timing-safe compare buys nothing against a remote attacker who cannot
 * measure sub-microsecond differences through the network and the DB round
 * trip that precedes it.
 */
export async function authAgentToken(
  agentId: string,
  token: string | undefined | null,
): Promise<AuthResult<{ agent: AgentRow }>> {
  if (!token) return { error: "Invalid token", status: 403 };
  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return { error: "Agent not found", status: 404 };
    if (!agent.agentToken || agent.agentToken !== token) {
      return { error: "Invalid token", status: 403 };
    }
    return { agent };
  } catch {
    return { error: "Agent not found", status: 404 };
  }
}

/**
 * Extract a bearer token from an `Authorization: Bearer <token>` header.
 * Returns null when the header is absent or not a bearer credential.
 */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
