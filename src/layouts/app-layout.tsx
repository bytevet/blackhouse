import { Outlet } from "react-router";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { InboxEventsProvider } from "@/contexts/inbox-events-provider";

/**
 * Sidebar app shell. Wraps every authed route (AuthLayout still does the
 * auth gate; AppLayout adds the chrome). The thin top bar inside
 * `SidebarInset` carries the collapse trigger and leaves room for future
 * page breadcrumbs / titles.
 *
 * `InboxEventsProvider` wraps both sidebar and content so they share one
 * `/api/inbox-events` EventSource per tab.
 */
export function AppLayout() {
  return (
    <InboxEventsProvider>
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
    </InboxEventsProvider>
  );
}
