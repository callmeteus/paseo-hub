/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- the daemon name is the link that opens this registration; the empty state's action is this page's connect hint */
import { useSnapshotQuery } from "../queries/index.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { CopyField } from "../components/app/copy-field.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { RowActions } from "../components/app/row-actions.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  daemonList,
  renameDaemon,
  revokeDaemon,
  type BrowserDaemon,
  type DaemonCommand,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { DAEMON_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { CONNECT_COMMAND, daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "./handoff.js";
import {
  addressOptionLabel,
  defaultListenOrigin,
  groupListenOrigins,
  type HubListenOrigin,
} from "./listen-origins.js";
import { daemonDetailPath } from "../navigation/detail-paths.js";
import { daemonsQueryKey, refreshDaemons } from "./status.js";

const DAEMON_COLUMNS: readonly DataColumn[] = [
  { header: "Slug", fill: true },
  { header: "ID" },
  { header: "Status" },
  { header: "Access", fill: true },
  { header: "Last seen" },
  { header: "Registered" },
  { header: "", align: "end" },
];
const DAEMONS_DESCRIPTION = "Stable daemon identities registered to this organization.";
const DAEMON_DOCS_URL = "https://paseo.sh/docs/hub/daemons";
const ADD_DAEMON_DESCRIPTION =
  "Hub runs your workflows on machines you own. Run this on the machine you want to add.";
const DAEMONS_EMPTY_TITLE = "No daemons connected";
const DAEMONS_EMPTY_DESCRIPTION =
  "Hub runs your workflows on machines you own. Log in from the machine where your code lives and the CLI offers to connect it.";
const NO_LISTEN_ORIGINS: readonly HubListenOrigin[] = [];

/**
 * The address this page was opened at, which is the address a daemon has to be told.
 * Read after mount so a server render and the first client paint agree: the login command
 * appears once the window is known, instead of mismatching the HTML the server sent.
 */
function usePageOrigin(): string | undefined {
  const [origin, setOrigin] = useState<string | undefined>();
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

function DaemonDocsLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={DAEMON_DOCS_URL} target="_blank" rel="noreferrer">
        <BookOpen aria-hidden="true" />
        How to connect a daemon
      </a>
    </Button>
  );
}

/**
 * The commands a machine needs to enroll. Login is the usual path; connect is the path when that
 * machine already has a Hub login. When this Hub is reachable on more than one address, the
 * operator picks the network the daemon can actually use.
 */
export function AddDaemonInstructions({
  pageOrigin,
  origins,
}: {
  pageOrigin?: string | undefined;
  origins?: readonly HubListenOrigin[] | undefined;
}) {
  const list = origins ?? NO_LISTEN_ORIGINS;
  const groups = useMemo(() => groupListenOrigins(list), [list]);
  const initial = defaultListenOrigin(list, pageOrigin);
  const [kind, setKind] = useState(initial?.kind ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  useEffect(() => {
    if (list.length === 0) return;
    const current = list.find((item) => item.kind === kind && item.address === address);
    if (current !== undefined) return;
    const next = defaultListenOrigin(list, pageOrigin);
    if (next === undefined) return;
    setKind(next.kind);
    setAddress(next.address);
  }, [address, kind, list, pageOrigin]);
  const selectedGroup = groups.find((group) => group.kind === kind);
  const selected =
    selectedGroup?.origins.find((item) => item.address === address) ?? selectedGroup?.origins[0];
  const commandOrigin = selected?.origin ?? pageOrigin;
  const kindOptions = useMemo((): readonly SegmentedOption[] => {
    return groups.map((group) => {
      const only = group.origins.length === 1 ? group.origins[0] : undefined;
      return only === undefined
        ? { value: group.kind, label: group.label }
        : { value: group.kind, label: group.label, hint: only.address };
    });
  }, [groups]);
  const addressOptions = useMemo(
    (): readonly SegmentedOption[] =>
      (selectedGroup?.origins ?? []).map((item) => ({
        value: item.address,
        label: addressOptionLabel(selectedGroup?.origins ?? [], item),
      })),
    [selectedGroup],
  );
  const selectKind = useCallback(
    (value: string) => {
      setKind(value);
      const group = list.filter((item) => item.kind === value);
      const preferred = group.find((item) => !item.address.includes(":")) ?? group[0];
      if (preferred !== undefined) setAddress(preferred.address);
    },
    [list],
  );
  const selectAddress = useCallback((value: string) => {
    setAddress(value);
  }, []);

  return (
    <div className="grid gap-4">
      {groups.length > 1 ? (
        <SegmentedControl
          label="Network"
          description="The network the daemon can reach this Hub on."
          value={kind}
          options={kindOptions}
          onChange={selectKind}
        />
      ) : null}
      {addressOptions.length > 1 ? (
        <SegmentedControl
          label="Address"
          value={address}
          options={addressOptions}
          onChange={selectAddress}
        />
      ) : null}
      {commandOrigin === undefined ? null : (
        <CopyField label="Login command" value={daemonLoginCommand(commandOrigin)} />
      )}
      <CopyField label="Already logged in" value={CONNECT_COMMAND} />
      <DaemonDocsLink />
    </div>
  );
}

function AddDaemonButton({ origins }: { origins?: readonly HubListenOrigin[] | undefined }) {
  const pageOrigin = usePageOrigin();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button">
          <Plus aria-hidden="true" />
          Add daemon
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add daemon</DialogTitle>
          <DialogDescription>{ADD_DAEMON_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <AddDaemonInstructions pageOrigin={pageOrigin} origins={origins} />
      </DialogContent>
    </Dialog>
  );
}

function DaemonsHeader({ origins }: { origins?: readonly HubListenOrigin[] | undefined }) {
  return (
    <PageHeader id="daemons-heading" title="Daemons" description={DAEMONS_DESCRIPTION}>
      <AddDaemonButton origins={origins} />
    </PageHeader>
  );
}

export function DaemonsPanel({
  accountId,
  organizationId,
  organizationSlug,
}: {
  accountId: string;
  organizationId: string;
  organizationSlug: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = daemonsQueryKey(accountId, organizationId);
  const loadDaemons = useServerFn(daemonList);
  const pageOrigin = usePageOrigin();
  const snapshot = useSnapshotQuery({
    queryKey,
    queryFn: () => loadDaemons({ data: { organizationSlug } }),
  });
  const rename = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(renameDaemon) as (
      input: Parameters<typeof renameDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const revoke = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(revokeDaemon) as (
      input: Parameters<typeof revokeDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const renameSelected = useCallback(
    async (daemonId: string, slug: string) => {
      try {
        const result = await rename.mutateAsync({
          data: { organizationSlug, daemonId, slug },
        });
        if (result.status === "error") return result.error.message;
        return result.data.state === "complete"
          ? undefined
          : "The daemon is no longer available in the current organization. Reload the daemon list.";
      } catch {
        return "Hub did not receive the daemon rename result. Check your connection and reload its current name.";
      }
    },
    [organizationSlug, rename],
  );
  const revokeSelected = useCallback(
    (daemonId: string) => revoke.mutate({ data: { organizationSlug, daemonId } }),
    [organizationSlug, revoke],
  );
  if (snapshot.status === "pending") return <DaemonLoading />;
  if (snapshot.status === "error") {
    return (
      <>
        <DaemonsHeader />
        <FailureAlert
          title="Daemons unavailable"
          error={snapshot.error}
          fallback="Hub did not receive the daemon list. Check your connection and reload the page."
        />
      </>
    );
  }
  const daemons = snapshot.data;
  const revokeFailed = revoke.isError || revoke.data?.status === "error";
  const busy = rename.isPending || revoke.isPending;
  return (
    <>
      <DaemonsHeader origins={daemons.listenOrigins} />
      {revokeFailed ? (
        <FailureAlert
          standalone
          title="The daemon wasn't revoked"
          error={revoke.data}
          fallback="Hub did not receive the daemon revocation result. Check your connection and reload its current status."
        />
      ) : null}
      <DataTable
        label="Daemons"
        columns={DAEMON_COLUMNS}
        isEmpty={daemons.daemons.length === 0}
        empty={{
          title: DAEMONS_EMPTY_TITLE,
          description: DAEMONS_EMPTY_DESCRIPTION,
          action: <AddDaemonInstructions pageOrigin={pageOrigin} origins={daemons.listenOrigins} />,
        }}
      >
        {daemons.daemons.map((daemon) => (
          <DaemonRow
            key={daemon.id}
            daemon={daemon}
            organizationSlug={organizationSlug}
            canManage={daemons.canManage}
            busy={busy}
            onRename={renameSelected}
            onRevoke={revokeSelected}
          />
        ))}
      </DataTable>
    </>
  );
}

function DaemonRow({
  daemon,
  organizationSlug,
  canManage,
  busy,
  onRename,
  onRevoke,
}: {
  daemon: BrowserDaemon;
  organizationSlug: string;
  canManage: boolean;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  onRevoke: (daemonId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const requestRename = useCallback((event: Event) => {
    event.preventDefault();
    setRenaming(true);
  }, []);
  const revoke = useCallback(() => onRevoke(daemon.id), [daemon.id, onRevoke]);

  return (
    <DataRow navigates>
      <DataCell>
        <TwoLine
          primary={
            <Link
              to={daemonDetailPath(organizationSlug, daemon.id) as never}
              className="text-inherit no-underline"
            >
              {daemon.slug}
            </Link>
          }
        />
      </DataCell>
      <DataCell muted>
        <span className="font-mono text-xs">{daemon.id.slice(0, 8)}</span>
      </DataCell>
      <DataCell>
        <DaemonStatus daemon={daemon} />
      </DataCell>
      <DataCell muted>
        {daemon.permissions.includes("hub.execute") ? (
          "Hub automations"
        ) : (
          <TwoLine primary="Connected only" secondary={GRANT_EXECUTE_COMMAND} mono />
        )}
      </DataCell>
      <DataCell muted>
        <RelativeTime value={daemon.lastSeenAt} />
      </DataCell>
      <DataCell muted>
        <RelativeTime value={daemon.registeredAt} />
      </DataCell>
      <DataCell>
        {canManage ? (
          <>
            <RowActions label={`Actions for ${daemon.slug}`}>
              <DropdownMenuItem disabled={busy} onSelect={requestRename}>
                Rename
              </DropdownMenuItem>
              {daemon.status === "revoked" ? null : (
                <ConfirmMenuItem
                  busy={busy}
                  destructive
                  label="Revoke"
                  title={`Revoke ${daemon.slug}?`}
                  description="The daemon will disconnect and its credential cannot reconnect."
                  cancelLabel="Cancel"
                  confirmLabel="Revoke daemon"
                  onConfirm={revoke}
                />
              )}
            </RowActions>
            <RenameDaemonDialog
              daemon={daemon}
              busy={busy}
              onRename={onRename}
              open={renaming}
              onOpenChange={setRenaming}
            />
          </>
        ) : null}
      </DataCell>
    </DataRow>
  );
}

function RenameDaemonDialog({
  daemon,
  busy,
  onRename,
  open,
  onOpenChange,
}: {
  daemon: BrowserDaemon;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string>();
  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setError(undefined);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const completeRename = useCallback(
    async (slug: string) => {
      const failure = await onRename(daemon.id, slug);
      setError(failure);
      if (failure === undefined) changeOpen(false);
    },
    [changeOpen, daemon.id, onRename],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const slug = new FormData(event.currentTarget).get("slug");
      if (typeof slug !== "string") return;
      void completeRename(slug);
    },
    [completeRename],
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={changeOpen}
      title="Rename daemon"
      label={`Rename ${daemon.slug}`}
      submitLabel="Rename"
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        id={`daemon-slug-${daemon.id}`}
        label="Daemon slug"
        kind="text"
        name="slug"
        defaultValue={daemon.slug}
        maxLength={100}
        required
        {...(error === undefined ? {} : { error })}
      />
    </FormDialog>
  );
}

function DaemonStatus({ daemon }: { daemon: BrowserDaemon }) {
  if (daemon.status === "revoked") return <StatusPill tone="danger">Revoked</StatusPill>;
  if (daemon.presence === "connected") return <StatusPill tone="success">Connected</StatusPill>;
  return <StatusPill tone="neutral">Offline</StatusPill>;
}

function DaemonLoading() {
  return (
    <>
      <DaemonsHeader />
      <DataTableSkeleton label="Daemons" columns={DAEMON_COLUMNS} />
    </>
  );
}
