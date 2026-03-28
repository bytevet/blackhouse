import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/templates/")({
  beforeLoad: () => {
    throw redirect({ to: "/templates/mine" });
  },
});
