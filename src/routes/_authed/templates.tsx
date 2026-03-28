import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/templates")({
  component: TemplatesLayout,
});

const tabs = [
  { to: "/templates/mine" as const, label: "My Templates" },
  { to: "/templates/public" as const, label: "Public Templates" },
];

function TemplatesLayout() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Templates</h1>
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
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
