import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "./auth";
import { db } from "@/db";
import { codingSessions } from "@/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Internal helper (only used inside createServerFn handlers)
// ---------------------------------------------------------------------------

async function _getSession() {
  const request = getRequest();
  return auth.api.getSession({ headers: request.headers });
}

// ---------------------------------------------------------------------------
// Shared auth helpers (all wrapped in createServerFn for TanStack Start)
// ---------------------------------------------------------------------------

export const getServerSession = createServerFn({ method: "GET" }).handler(async () => {
  return _getSession();
});

export const requireSession = createServerFn({ method: "GET" }).handler(async () => {
  const session = await _getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
});

export const requireSessionOwnership = createServerFn({ method: "GET" })
  .inputValidator((input: { sessionId: string }) => input)
  .handler(async ({ data }) => {
    const session = await _getSession();
    if (!session) throw new Error("Unauthorized");

    const [codingSession] = await db
      .select()
      .from(codingSessions)
      .where(eq(codingSessions.id, data.sessionId))
      .limit(1);

    if (!codingSession) throw new Error("Session not found");

    if (codingSession.userId !== session.user.id && session.user.role !== "admin") {
      throw new Error("Forbidden");
    }

    return { session, codingSession };
  });

export function requireAdmin(session: { user: { role?: string | null } }) {
  if (session.user.role !== "admin") {
    throw new Error("Forbidden: admin access required");
  }
}
