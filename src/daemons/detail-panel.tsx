/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-object-as-prop -- one daemon binds one registration; its connection is that registration's own slot */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery } from "../queries/index.js";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CardSkeleton } from "../components/app/card.js";
import { CopyField } from "../components/app/copy-field.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { formatAbsolute } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { queryState } from "../projects/panel-state.js";
import { useRouteTenant } from "../projects/context.js";
import { GRANT_EXECUTE_COMMAND } from "./handoff.js";
import { daemonList, type BrowserDaemonList } from "./functions.js";
import { daemonsQueryKey } from "./status.js";

export function DaemonDetailPanel({ daemonId }: { daemonId: string }) {
  const tenant = useRouteTenant();
  const load = useServerFn(daemonList);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: daemonsQueryKey(tenant.account.id, tenant.organization.id),
    queryFn: () => load({ data: { organizationSlug } }),
  });
  const list = queryState<BrowserDaemonList>(snapshot, "Daemon unavailable", <DaemonLoading />);
  if (!list.ok) return list.element;
  const daemon = list.data.daemons.find((candidate) => candidate.id === daemonId);
  if (daemon === undefined) {
    return (
      <FailureAlert
        title="Daemon unavailable"
        error="This daemon is not in this organization."
        fallback="This daemon is not in this organization."
      />
    );
  }
  const connection = connectionState(daemon);
  return (
    <>
      <PageHeader
        title={daemon.slug}
        description={
          daemon.permissions.includes("hub.execute") ? "Runs Hub automations." : "Connected only."
        }
        status={{ label: connection.label, tone: connection.tone }}
      >
        <Button variant="outline" size="sm" asChild>
          <Link to={`/o/${organizationSlug}/daemons` as never}>Manage</Link>
        </Button>
      </PageHeader>
      <Section title="Daemon">
        <DaemonDetailBody daemon={daemon} />
      </Section>
    </>
  );
}

/** The registration the daemon list already returns. Nothing here revokes it. */
export function DaemonDetailBody({ daemon }: { daemon: BrowserDaemonList["daemons"][number] }) {
  return (
    <div className="grid gap-4">
      <SummaryPanel label="Daemon" rows={daemonRows(daemon)} />
      {daemon.permissions.includes("hub.execute") ? null : (
        <CopyField label="Grant command" value={GRANT_EXECUTE_COMMAND} />
      )}
    </div>
  );
}

function DaemonLoading() {
  return (
    <div aria-busy="true" aria-label="Loading daemon">
      <PageHeaderSkeleton />
      <CardSkeleton lines={4} />
    </div>
  );
}

function daemonRows(daemon: BrowserDaemonList["daemons"][number]): readonly SummaryRow[] {
  const connection = connectionState(daemon);
  const rows: SummaryRow[] = [
    { label: "Name", value: daemon.slug },
    {
      label: "Connection",
      value: <StatusPill tone={connection.tone}>{connection.label}</StatusPill>,
    },
    {
      label: "Runs",
      value: daemon.permissions.includes("hub.execute") ? "Hub automations" : "Connected only",
    },
    {
      label: "Permissions",
      value: daemon.permissions.length === 0 ? "None" : daemon.permissions.join(", "),
    },
    { label: "Status", value: statusLabel(daemon.status) },
    { label: "ID", value: <span className="font-mono text-xs break-all">{daemon.id}</span> },
    {
      label: "Last seen",
      value: <time dateTime={daemon.lastSeenAt}>{formatAbsolute(daemon.lastSeenAt)}</time>,
    },
    {
      label: "Registered",
      value: <time dateTime={daemon.registeredAt}>{formatAbsolute(daemon.registeredAt)}</time>,
    },
  ];
  if (daemon.connectedAt !== null) {
    rows.push({
      label: "Connected at",
      value: <time dateTime={daemon.connectedAt}>{formatAbsolute(daemon.connectedAt)}</time>,
    });
  }
  return rows;
}

function connectionState(daemon: BrowserDaemonList["daemons"][number]): {
  label: string;
  tone: StatusTone;
} {
  if (daemon.status === "revoked") return { label: "Revoked", tone: "danger" };
  if (daemon.presence === "connected") return { label: "Connected", tone: "success" };
  return { label: "Offline", tone: "neutral" };
}
