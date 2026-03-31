import { Link, useLocation } from "react-router";
import { useState } from "react";
import { LayoutDashboard, FileText, Settings, LogOut, Sun, Moon, Menu, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth-client";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const navItems = [
  { title: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { title: "Templates", to: "/templates", icon: FileText },
  { title: "Settings", to: "/settings", icon: Settings },
];

export function AppHeader() {
  const { data: session } = useSession();
  const location = useLocation();
  const { resolved, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const user = session?.user;

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
      <div className="flex h-12 items-center gap-2 px-4 md:px-6">
        {/* Logo */}
        <Link to="/dashboard" className="flex shrink-0 items-center gap-2">
          <div className="flex size-7 items-center justify-center bg-primary text-primary-foreground text-xs font-bold">
            BH
          </div>
          <span className="text-sm font-semibold">Blackhouse</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => {
            const active = location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.title}
                to={item.to}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="size-3.5" />
                {item.title}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        {/* Theme toggle */}
        <Button variant="ghost" size="icon-sm" onClick={toggle}>
          {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-md p-0.5 outline-hidden hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30">
            <Avatar className="size-6">
              <AvatarImage src={user?.image ?? undefined} />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{user?.name ?? "User"}</div>
            <DropdownMenuItem
              onClick={() =>
                signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      window.location.href = "/login";
                    },
                  },
                })
              }
            >
              <LogOut className="mr-2 size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mobile hamburger */}
        <Button variant="ghost" className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
        </Button>
      </div>

      {/* Mobile nav drawer */}
      {mobileOpen && (
        <nav className="border-t px-4 py-2 md:hidden">
          {navItems.map((item) => {
            const active = location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.title}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="size-4" />
                {item.title}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
