/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one run binds one record; its status and a step's stored value are that record's own slots */
import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { CardSkeleton } from "../components/app/card.js";
import { CodeBlock } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { formatAbsolute } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { queryState } from "../projects/panel-state.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerRunSnapshot } from "./functions.js";
import type { RunDetail, StoredJson } from "./run-detail.js";

const STEP_COLUMNS = [
  { header: "Step", fill: true },
  { header: "Status" },
  { header: "Started" },
  { header: "Finished" },
  { header: "Output", fill: true },
  { header: "Failure", fill: true },
];

export function TriggerRunPanel({ runId }: { runId: string }) {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerRunSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["trigger-run", tenant.organization.id, runId],
    queryFn: () => load({ data: { organizationSlug, runId } }),
  });
  const run = queryState<RunDetail>(snapshot, "Run unavailable", <RunLoading />);
  if (!run.ok) return run.element;
  return <RunDetailBody detail={run.data} />;
}

/** The run, from the record. Rendered on its own so a test can show a failure and a success. */
export function RunDetailBody({ detail }: { detail: RunDetail }) {
  return (
    <>
      <PageHeader
        title={detail.triggerName}
        description={`${detail.provider} · ${detail.source}`}
        status={{ label: statusLabel(detail.status), tone: runTone(detail.status) }}
      />
      <Section title="Run">
        <SummaryPanel label="Run" rows={runRows(detail)} />
      </Section>
      {detail.steps.length === 0 ? null : (
        <Section title="Steps">
          <DataTable
            label="Run steps"
            columns={STEP_COLUMNS}
            isEmpty={false}
            empty={{ title: "No steps" }}
          >
            {detail.steps.map((step) => (
              <DataRow key={step.id}>
                <DataCell>
                  {step.ordinal + 1}. {step.stepId}
                </DataCell>
                <DataCell>
                  <StatusPill tone={runTone(step.status)}>{statusLabel(step.status)}</StatusPill>
                </DataCell>
                <DataCell muted>
                  <Instant value={step.startedAt} />
                </DataCell>
                <DataCell muted>
                  <Instant value={step.completedAt} />
                </DataCell>
                <DataCell>
                  <StoredValue value={step.output ?? step.result} />
                </DataCell>
                <DataCell muted>{step.failureReason}</DataCell>
              </DataRow>
            ))}
          </DataTable>
        </Section>
      )}
    </>
  );
}

function RunLoading() {
  return (
    <div aria-busy="true" aria-label="Loading run">
      <PageHeaderSkeleton />
      <CardSkeleton lines={4} />
    </div>
  );
}

function runRows(detail: RunDetail): readonly SummaryRow[] {
  const rows: SummaryRow[] = [
    { label: "Trigger", value: detail.triggerName },
    { label: "Provider", value: detail.provider },
    { label: "Source", value: detail.source },
    {
      label: "Status",
      value: <StatusPill tone={runTone(detail.status)}>{statusLabel(detail.status)}</StatusPill>,
    },
    { label: "Received", value: <Instant value={detail.receivedAt} /> },
    {
      label: "Finished",
      value: detail.finishedAt === null ? "Still running" : <Instant value={detail.finishedAt} />,
    },
  ];
  if (detail.repo !== null) rows.push({ label: "Repository", value: detail.repo });
  if (detail.agent !== null) {
    rows.push({
      label: "Agent",
      value:
        detail.agent.model === null
          ? detail.agent.provider
          : `${detail.agent.provider}/${detail.agent.model}`,
    });
  }
  if (detail.duration !== null) rows.push({ label: "Duration", value: detail.duration });
  if (detail.failureReason !== null) {
    rows.push({
      label: "Failure",
      value: <span className="font-mono text-xs break-all">{detail.failureReason}</span>,
    });
  }
  if (detail.prompt !== null) {
    rows.push({
      label: "Prompt",
      value: <CodeBlock label="Prompt">{detail.prompt}</CodeBlock>,
    });
  }
  for (const result of detail.results) {
    rows.push({
      label: `Result · ${result.stepId}`,
      value: <StoredValue value={result.value} />,
    });
  }
  if (detail.outputContext !== null) {
    rows.push({
      label: "Recorded output",
      value: <StoredValue value={detail.outputContext} />,
    });
  }
  return rows;
}

function Instant({ value }: { value: string | null }) {
  if (value === null) return null;
  return <time dateTime={value}>{formatAbsolute(value)}</time>;
}

function StoredValue({ value }: { value: StoredJson | null }) {
  if (value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <CodeBlock label="Stored value">{text}</CodeBlock>;
}

function runTone(status: string): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  if (status === "skipped") return "warning";
  return "neutral";
}
