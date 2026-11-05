/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- a row's name is the link that opens this run */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { runDetailPath } from "../navigation/detail-paths.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerSnapshot } from "./functions.js";

const ACTIVITY_COLUMNS = [
  { header: "Trigger", fill: true },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status" },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
  });
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader title="Activity" />
        <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load trigger activity."
      />
    );
  }
  const activity = snapshot.data.activity;
  return (
    <>
      <PageHeader title="Activity" />
      <DataTable
        label="Trigger activity"
        columns={ACTIVITY_COLUMNS}
        isEmpty={activity.length === 0}
        empty={EMPTY_ACTIVITY}
      >
        {activity.map((run) => (
          <DataRow key={run.id} navigates>
            <DataCell>
              <TwoLine
                primary={
                  <Link
                    to={runDetailPath(organizationSlug, run.id) as never}
                    className="text-inherit no-underline"
                  >
                    {run.triggerName}
                  </Link>
                }
                {...(run.repo === null ? {} : { secondary: run.repo })}
              />
            </DataCell>
            <DataCell>{run.provider}</DataCell>
            <DataCell>{run.source}</DataCell>
            <DataCell>
              <StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>
            </DataCell>
            <DataCell muted>
              <RelativeTime value={run.receivedAt} />
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
    </>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
