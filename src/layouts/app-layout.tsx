import { Outlet } from "react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";

/**
 * Sidebar app shell. Wraps every authed route (AuthLayout still does the
 * auth gate; AppLayout adds the chrome). The thin top bar inside
 * `SidebarInset` carries the collapse trigger and leaves room for future
 * page breadcrumbs / titles.
 */
export function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="flex min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-6">
          <SidebarTrigger />
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
