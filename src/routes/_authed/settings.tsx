import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/lib/auth-client";
import { User, Bot, Container, Users } from "lucide-react";
import { TabbedLayout, type TabItem } from "@/components/tabbed-layout";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsLayout,
});

const allTabs: (TabItem & { adminOnly: boolean })[] = [
  { to: "/settings/profile", label: "Profile", icon: User, adminOnly: false },
  { to: "/settings/agents", label: "Coding Agents", icon: Bot, adminOnly: true },
  { to: "/settings/docker", label: "Docker", icon: Container, adminOnly: true },
  { to: "/settings/users", label: "Users", icon: Users, adminOnly: true },
];

function SettingsLayout() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

  return <TabbedLayout title="Settings" tabs={tabs} />;
}
