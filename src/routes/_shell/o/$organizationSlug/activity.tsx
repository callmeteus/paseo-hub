import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity")({
  staticData: { breadcrumb: "Activity", projectSection: "activity" },
  component: Outlet,
});
