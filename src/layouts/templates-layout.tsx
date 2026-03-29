import { User, Globe } from "lucide-react";
import { TabbedLayout } from "@/components/tabbed-layout";

const tabs = [
  { to: "/templates/mine", label: "My Templates", icon: User },
  { to: "/templates/public", label: "Public Templates", icon: Globe },
];

export function TemplatesLayout() {
  return <TabbedLayout title="Templates" tabs={tabs} />;
}
