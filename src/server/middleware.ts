import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth";

/**
 * Auth middleware — validates session, injects into context.
 * Use with `.middleware([authMiddleware])` on server functions.
 */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Error("Unauthorized");
  return next({ context: { session } });
});

/**
 * Admin middleware — requires admin role. Chains authMiddleware.
 * Use with `.middleware([adminMiddleware])` on admin-only server functions.
 */
export const adminMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new Error("Unauthorized");
  if (session.user.role !== "admin") {
    throw new Error("Forbidden: admin access required");
  }
  return next({ context: { session } });
});
