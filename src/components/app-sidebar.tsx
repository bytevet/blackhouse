import { Link, useLocation } from "@tanstack/react-router";
import {
  LayoutDashboard,
  FileText,
  Settings,
  LogOut,
  ChevronsUpDown,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signOut, useSession } from "@/lib/auth-client";
import { useTheme } from "@/hooks/use-theme";

const navItems = [
  { title: "Dashboard", to: "/dashboard" as const, icon: LayoutDashboard },
  { title: "Templates", to: "/templates" as const, icon: FileText },
  { title: "Settings", to: "/settings" as const, icon: Settings },
];

const themeOptions = [
  { value: "light" as const, label: "Light", icon: Sun },
  { value: "dark" as const, label: "Dark", icon: Moon },
  { value: "system" as const, label: "System", icon: Monitor },
];

export function AppSidebar() {
  const { data: session } = useSession();
  const location = useLocation();
  const { theme, setTheme } = useTheme();
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
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <Link to="/dashboard" className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center bg-primary text-primary-foreground text-sm font-bold">
            BH
          </div>
          <span className="text-sm font-semibold text-sidebar-foreground">Blackhouse</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={location.pathname.startsWith(item.to)}
                    render={<Link to={item.to} />}
                  >
                    <item.icon className="shrink-0" />
                    <span className="truncate">{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground outline-hidden focus-visible:ring-2 ring-sidebar-ring">
            <Avatar className="size-6 shrink-0">
              <AvatarImage src={user?.image ?? undefined} />
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-left text-sm">{user?.name ?? "User"}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">Theme</p>
              <div className="mt-1 flex gap-1">
                {themeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTheme(opt.value)}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-sm px-2 py-1 text-[10px] transition-colors ${
                      theme === opt.value
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <opt.icon className="size-3" />
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <Separator />
            <DropdownMenuItem
              onClick={() =>
                signOut({ fetchOptions: { onSuccess: () => (window.location.href = "/login") } })
              }
            >
              <LogOut className="mr-2 size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
