import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/lib/auth-client";
import { User, Bot, Container, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsLayout,
});

const allTabs = [
  { to: "/settings/profile" as const, label: "Profile", icon: User, adminOnly: false },
  { to: "/settings/agents" as const, label: "Coding Agents", icon: Bot, adminOnly: true },
  { to: "/settings/docker" as const, label: "Docker", icon: Container, adminOnly: true },
  { to: "/settings/users" as const, label: "Users", icon: Users, adminOnly: true },
];

function SettingsLayout() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";

  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div className="space-y-4 overflow-auto p-4 md:p-6">
      <h1 className="text-lg font-semibold text-foreground">Settings</h1>
      <nav className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            )}
            activeProps={{
              className: "bg-background text-foreground shadow",
            }}
            inactiveProps={{
              className: "text-muted-foreground hover:text-foreground",
            }}
          >
            <tab.icon className="size-3" />
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
