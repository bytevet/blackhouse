import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { getServerSession } from "@/lib/auth-server";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await getServerSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }
    return { session };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <main className="flex-1 overflow-auto p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
