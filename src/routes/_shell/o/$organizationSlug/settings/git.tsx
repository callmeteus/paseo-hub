import { createFileRoute } from "@tanstack/react-router";
import { AutomationGitSettings } from "../../../../../automation-sync/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/git")({
  staticData: { breadcrumb: "Git" },
  component: AutomationGitSettings,
});
