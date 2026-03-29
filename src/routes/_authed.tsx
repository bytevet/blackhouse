import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ location, context }) => {
    if (!context.user) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
    return { user: context.user };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <main className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
