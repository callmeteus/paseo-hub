import { createFileRoute } from "@tanstack/react-router";
import { TriggerRunPanel } from "../../../../../triggers/run-panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/$runId")({
  staticData: { breadcrumb: "Run" },
  component: RunRoute,
});

function RunRoute() {
  const { runId } = Route.useParams();
  return <TriggerRunPanel runId={runId} />;
}
