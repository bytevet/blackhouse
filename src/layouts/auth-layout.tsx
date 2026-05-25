import { Outlet, Navigate, useLocation } from "react-router";
import { useSession } from "@/lib/auth-client";

/**
 * Authentication gate — redirects unauthenticated users to /login while
 * preserving the originally-requested URL via a `redirect` query param.
 * Renders nothing else; the chrome (sidebar + page shell) lives in
 * AppLayout, which mounts under this in the route tree.
 */
export function AuthLayout() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return null;
  }

  if (!session) {
    const redirectParam = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirectParam}`} replace />;
  }

  return <Outlet />;
}
