import { createMiddleware } from "hono/factory";
import { auth } from "../lib/auth.js";

type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export type AuthEnv = {
  Variables: {
    session: NonNullable<AuthSession>;
  };
};

export type AdminEnv = AuthEnv;

/**
 * Auth middleware - validates session via Better Auth, injects into context.
 */
export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("session", session);
  await next();
});

/**
 * Admin middleware - requires admin role.
 */
export const adminMiddleware = createMiddleware<AdminEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (session.user.role !== "admin") {
    return c.json({ error: "Forbidden: admin access required" }, 403);
  }
  c.set("session", session);
  await next();
});
