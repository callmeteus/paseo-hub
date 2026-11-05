import { createFileRoute } from "@tanstack/react-router";
import { DaemonDetailPanel } from "../../../../../daemons/detail-panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/daemons/$daemonId")({
  staticData: { breadcrumb: "Daemon" },
  component: DaemonRoute,
});

function DaemonRoute() {
  const { daemonId } = Route.useParams();
  return <DaemonDetailPanel daemonId={daemonId} />;
}
