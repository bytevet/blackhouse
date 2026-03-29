import { createFileRoute } from "@tanstack/react-router";
import { User, Globe } from "lucide-react";
import { TabbedLayout } from "@/components/tabbed-layout";

export const Route = createFileRoute("/_authed/templates")({
  component: TemplatesLayout,
});

const tabs = [
  { to: "/templates/mine", label: "My Templates", icon: User },
  { to: "/templates/public", label: "Public Templates", icon: Globe },
];

function TemplatesLayout() {
  return <TabbedLayout title="Templates" tabs={tabs} />;
}
