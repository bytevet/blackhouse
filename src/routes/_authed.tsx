import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
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
    <TooltipProvider>
      <SidebarProvider className="h-dvh">
        <AppSidebar />
        <main className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-10 shrink-0 items-center border-b px-4">
            <SidebarTrigger />
          </header>
          <div className="flex-1 overflow-auto p-4">
            <Outlet />
          </div>
        </main>
      </SidebarProvider>
    </TooltipProvider>
  );
}
