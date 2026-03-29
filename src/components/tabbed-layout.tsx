import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface TabItem {
  to: string;
  label: string;
  icon?: LucideIcon;
}

interface TabbedLayoutProps {
  title: string;
  tabs: TabItem[];
  actions?: ReactNode;
}

export function TabbedLayout({ title, tabs, actions }: TabbedLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const activeTab = tabs.find((t) => location.pathname.startsWith(t.to))?.to ?? tabs[0].to;

  return (
    <div className="flex flex-1 flex-col overflow-auto p-4 md:p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <Tabs value={activeTab} onValueChange={(val) => navigate(val)}>
          <TabsList variant="line">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.to} value={tab.to}>
                {tab.icon && <tab.icon className="size-3" />}
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-4 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
