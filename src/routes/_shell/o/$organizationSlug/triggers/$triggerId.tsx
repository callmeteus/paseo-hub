import { createFileRoute } from "@tanstack/react-router";
import { TriggerEditorPanel } from "../../../../../triggers/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers/$triggerId")({
  staticData: { breadcrumb: "Automation" },
  validateSearch: (search: Record<string, unknown>) => {
    const template = search["template"];
    return typeof template === "string" ? { template } : {};
  },
  component: TriggerEditorRoute,
});

function TriggerEditorRoute() {
  const { triggerId } = Route.useParams();
  return <TriggerEditorPanel triggerId={triggerId} />;
}
