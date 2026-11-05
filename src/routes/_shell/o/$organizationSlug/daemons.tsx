import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/o/$organizationSlug/daemons")({
  staticData: { breadcrumb: "Daemons" },
  component: Outlet,
});
