import * as React from "react";
import { Link, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LogOut,
  Sun,
  Moon,
  LayoutDashboard,
  User,
  Globe,
  UserCog,
  Bot,
  Container,
  Users,
  type LucideIcon,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { LanguageSwitcher } from "@/components/language-switcher";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useInboxEventsContext } from "@/contexts/inbox-events-context";
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

// Translation-key unions so `t(item.titleKey)` stays tsc-checked against
// the en.json shape (via the Resources augmentation in `src/i18n`).
type NavItemKey =
  | "nav.roster"
  | "nav.myBriefings"
  | "nav.publicBriefings"
  | "nav.profile"
  | "nav.roles"
  | "nav.docker"
  | "nav.team";
type NavGroupKey = "nav.briefings" | "nav.settings";

interface NavSubItem {
  titleKey: NavItemKey;
  url: string;
  icon: LucideIcon;
  /** When true, only admins see this item. */
  adminOnly?: boolean;
}
interface NavGroup {
  /** Optional — when omitted, the group renders unlabeled (used for the
   *  single Dashboard entry so we don't show a one-item labeled group). */
  titleKey?: NavGroupKey;
  items: NavSubItem[];
}

const navMain: NavGroup[] = [
  {
    items: [{ titleKey: "nav.roster", url: "/dashboard", icon: LayoutDashboard }],
  },
  {
    titleKey: "nav.briefings",
    items: [
      { titleKey: "nav.myBriefings", url: "/templates/mine", icon: User },
      { titleKey: "nav.publicBriefings", url: "/templates/public", icon: Globe },
    ],
  },
  {
    titleKey: "nav.settings",
    items: [
      { titleKey: "nav.profile", url: "/settings/profile", icon: UserCog },
      { titleKey: "nav.roles", url: "/settings/agents", icon: Bot, adminOnly: true },
      { titleKey: "nav.docker", url: "/settings/docker", icon: Container, adminOnly: true },
      { titleKey: "nav.team", url: "/settings/users", icon: Users, adminOnly: true },
    ],
  },
];

function isItemActive(pathname: string, url: string): boolean {
  return pathname === url || pathname.startsWith(url + "/");
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation();
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { resolved, toggle } = useTheme();
  const { totalUnread } = useInboxEventsContext();
  const user = session?.user;
  const isAdmin = user?.role === "admin";

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <Sidebar variant="floating" collapsible="icon" {...props}>
      <SidebarHeader>
        <Link
          to="/dashboard"
          className="flex items-center gap-3 rounded-lg p-1 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0"
        >
          <LogoMark className="size-9 shrink-0 group-data-[collapsible=icon]:size-8" />
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-base font-semibold tracking-tight">
              {t("brand.title")}
            </span>
            <span className="truncate text-xs text-muted-foreground">{t("brand.subtitle")}</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {navMain.map((group) => {
          const visible = group.items.filter((it) => !it.adminOnly || isAdmin);
          if (visible.length === 0) return null;
          // Stable key — group titles may be absent (single-item unlabeled
          // groups like Dashboard), so fall back to the first item URL.
          const groupReactKey = group.titleKey ?? visible[0].url;
          return (
            <SidebarGroup key={groupReactKey}>
              {group.titleKey && <SidebarGroupLabel>{t(group.titleKey)}</SidebarGroupLabel>}
              <SidebarMenu>
                {visible.map((item) => {
                  const title = t(item.titleKey);
                  const showRosterBadge = item.titleKey === "nav.roster" && totalUnread > 0;
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton
                        isActive={isItemActive(location.pathname, item.url)}
                        tooltip={title}
                        render={<Link to={item.url} />}
                      >
                        <item.icon className="size-4" />
                        <span>{title}</span>
                      </SidebarMenuButton>
                      {showRosterBadge && (
                        <SidebarMenuBadge
                          aria-label={t("messaging.aggregateUnread", { count: totalUnread })}
                        >
                          {totalUnread}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center gap-1 px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0">
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={t("nav.toggleTheme")}>
            {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger className="ml-auto flex items-center gap-2 rounded-md p-1 outline-hidden hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:p-0">
              <Avatar className="size-6">
                <AvatarImage src={user?.image ?? undefined} />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="max-w-[10ch] truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                {user?.name ?? t("nav.userFallback")}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto">
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {user?.email ?? user?.name ?? t("nav.userFallback")}
              </div>
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
                {t("nav.signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
