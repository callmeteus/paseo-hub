import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CircleCheck, GitCommitHorizontal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Card } from "../components/app/card.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { PageHeader } from "../components/app/page.js";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { LoadingLine, Spinner } from "../components/app/loading.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { StatTile } from "../components/app/stat-tile.js";
import { Button } from "../components/ui/button.js";
/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- the git card binds one settings document, and each control updates that document */
import { useSnapshotQuery } from "../queries/index.js";
import { useRouteTenant } from "../projects/context.js";
import type { AutomationGitSyncInterval } from "../db/types.js";
import {
  automationGitSyncSnapshot,
  saveAutomationGitSync,
  syncAutomationGitNow,
} from "./functions.js";
import { DEFAULT_AUTOMATION_COMMIT_MESSAGE, type AutomationGitSyncView } from "./contract.js";

const INTERVALS: readonly { value: AutomationGitSyncInterval; label: string }[] = [
  { value: 5, label: "5 min" },
  { value: 15, label: "15 min" },
  { value: 60, label: "60 min" },
];

const PAGE_DESCRIPTION =
  "Copies automations into a GitHub repository on a schedule. Hub does not pull those changes back. The agent machine receives the prompt files when a run starts.";

export function AutomationGitSettings() {
  return (
    <>
      <PageHeader title="Version in Git" description={PAGE_DESCRIPTION} />
      <AutomationGitCard />
    </>
  );
}

function AutomationGitCard() {
  const tenant = useRouteTenant();
  const load = useServerFn(automationGitSyncSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["automation-git-sync", tenant.organization.slug],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });
  if (snapshot.status === "pending") return null;
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Git sync unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load git sync."
      />
    );
  }
  if (!snapshot.data.githubConfigured) {
    return (
      <Card description="This Hub has no GitHub App, so automations are not copied to a repository." />
    );
  }
  return <AutomationGitForm organizationSlug={tenant.organization.slug} view={snapshot.data} />;
}

function AutomationGitForm({
  organizationSlug,
  view,
}: {
  organizationSlug: string;
  view: AutomationGitSyncView;
}) {
  const save = useServerFn(saveAutomationGitSync);
  const syncNow = useServerFn(syncAutomationGitNow);
  const queryClient = useQueryClient();
  const reload = () =>
    queryClient.invalidateQueries({ queryKey: ["automation-git-sync", organizationSlug] });
  const [settings, setSettings] = useState(view.settings);
  const [saved, setSaved] = useState(view.settings);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setSettings(view.settings);
    setSaved(view.settings);
  }, [view]);
  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await save({
        data: {
          organizationSlug,
          enabled: settings.enabled,
          repositoryId: settings.repositoryId,
          branch: settings.branch,
          commitMessage: settings.commitMessage,
          automationsDirectory: settings.automationsDirectory,
          intervalMinutes: settings.intervalMinutes,
        },
      });
      if (result.status === "error") throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (data) => {
      setSettings(data.settings);
      setSaved(data.settings);
      setMessage("Saved.");
      void reload();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const syncMutation = useMutation({
    mutationFn: async () => {
      const result = await syncNow({ data: { organizationSlug } });
      if (result.status === "error") throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: (data) => {
      setMessage(data.status === "committed" ? "Committed." : "Already up to date.");
      void reload();
    },
    onError: (error: Error) => setMessage(error.message),
  });
  const busy = saveMutation.isPending || syncMutation.isPending;
  const canSync =
    view.canManage &&
    saved.enabled &&
    saved.repositoryId !== null &&
    sameGitSettings(settings, saved);
  const repositories: ComboboxOption[] = view.repositories.map((repository) => ({
    value: String(repository.repositoryId),
    label: repository.fullName,
    keywords: [repository.fullName],
  }));
  return (
    <div className="grid gap-6">
      <GitSyncNotice pending={syncMutation.isPending} message={message} settings={saved} />
      <Card>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage(null);
            saveMutation.mutate();
          }}
        >
          <CheckboxField
            id="automation-git-enabled"
            label="Send automations to GitHub"
            description="Off leaves the repository alone. Sync now shows up after you save."
            checked={settings.enabled}
            disabled={!view.canManage || busy}
            onChange={(enabled) => setSettings((current) => ({ ...current, enabled }))}
          />
          <FormField id="automation-git-repository" label="Repository">
            {(control) => (
              <Combobox
                {...control}
                value={settings.repositoryId === null ? "" : String(settings.repositoryId)}
                options={repositories}
                placeholder="Choose a repository"
                searchPlaceholder="Search repositories…"
                empty="No repositories found."
                disabled={!view.canManage || busy}
                onChange={(option) => {
                  const repositoryId = Number(option.value);
                  if (!Number.isInteger(repositoryId)) return;
                  const repository = view.repositories.find(
                    (item) => item.repositoryId === repositoryId,
                  );
                  setSettings((current) => ({
                    ...current,
                    repositoryId,
                    branch:
                      current.branch.length > 0
                        ? current.branch
                        : (repository?.defaultBranch ?? ""),
                  }));
                }}
              />
            )}
          </FormField>
          <FormField
            id="automation-git-branch"
            label="Branch"
            kind="text"
            name="branch"
            value={settings.branch}
            disabled={!view.canManage || busy}
            onChange={(branch) => setSettings((current) => ({ ...current, branch }))}
          />
          <FormField
            id="automation-git-directory"
            label="Directory in the repository"
            description="Path inside the repository. Prompt files are written here. Hub reads them from the paths already in the automations."
            kind="text"
            name="automationsDirectory"
            placeholder=".paseo/automations"
            value={settings.automationsDirectory}
            disabled={!view.canManage || busy}
            onChange={(automationsDirectory) =>
              setSettings((current) => ({ ...current, automationsDirectory }))
            }
          />
          <FormField
            id="automation-git-message"
            label="Commit message"
            description={`Blank commits as ${DEFAULT_AUTOMATION_COMMIT_MESSAGE}.`}
            kind="text"
            name="commitMessage"
            placeholder={DEFAULT_AUTOMATION_COMMIT_MESSAGE}
            maxLength={500}
            value={settings.commitMessage}
            disabled={!view.canManage || busy}
            onChange={(commitMessage) => setSettings((current) => ({ ...current, commitMessage }))}
          />
          <SegmentedControl
            label="Check every"
            value={String(settings.intervalMinutes)}
            options={INTERVALS.map((interval) => ({
              value: String(interval.value),
              label: interval.label,
              disabled: busy,
            }))}
            onChange={(value) => {
              const interval = Number(value);
              if (interval !== 5 && interval !== 15 && interval !== 60) return;
              setSettings((current) => ({ ...current, intervalMinutes: interval }));
            }}
          />
          <FormActions>
            {canSync ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                aria-busy={syncMutation.isPending}
                onClick={() => {
                  setMessage(null);
                  syncMutation.mutate();
                }}
              >
                {syncMutation.isPending ? <Spinner /> : null}
                {syncMutation.isPending ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
            <Button type="submit" disabled={!view.canManage || busy}>
              Save
            </Button>
          </FormActions>
        </form>
      </Card>
    </div>
  );
}

const SAVED_MESSAGE = "Saved.";
const COMMITTED_MESSAGE = "Committed.";
const CURRENT_MESSAGE = "Already up to date.";

function GitSyncNotice({
  pending,
  message,
  settings,
}: {
  pending: boolean;
  message: string | null;
  settings: AutomationGitSyncView["settings"];
}) {
  const shown = pending ? null : message;
  const error = syncError(shown, settings.lastError);
  const tiles = gitSyncTiles(settings, shown);
  return (
    <>
      {pending ? <LoadingLine>Syncing automations to GitHub.</LoadingLine> : null}
      {error === null ? null : (
        <FailureAlert title="Git sync failed" error={error} fallback="Git sync failed." />
      )}
      <GitSyncTiles tiles={tiles} />
    </>
  );
}

function GitSyncTiles({ tiles }: { tiles: readonly ReactNode[] }) {
  const [only] = tiles;
  if (only === undefined) return null;
  if (tiles.length === 1) return only;
  return <div className="grid gap-4 sm:grid-cols-2">{tiles}</div>;
}

function syncError(message: string | null, lastError: string | null): string | null {
  if (message !== null && !isSyncSuccess(message)) return message;
  if (message !== null) return null;
  return lastError;
}

function sameGitSettings(
  left: AutomationGitSyncView["settings"],
  right: AutomationGitSyncView["settings"],
): boolean {
  return (
    left.enabled === right.enabled &&
    left.repositoryId === right.repositoryId &&
    left.branch === right.branch &&
    left.commitMessage === right.commitMessage &&
    left.automationsDirectory === right.automationsDirectory &&
    left.intervalMinutes === right.intervalMinutes
  );
}

function isSyncSuccess(message: string): boolean {
  return message === SAVED_MESSAGE || message === COMMITTED_MESSAGE || message === CURRENT_MESSAGE;
}

function gitSyncTiles(
  settings: AutomationGitSyncView["settings"],
  message: string | null,
): ReactNode[] {
  const tiles: ReactNode[] = [];
  const result = resultTile(message);
  if (result !== null) tiles.push(result);
  const check = checkTile(settings);
  if (check !== null) tiles.push(check);
  return tiles;
}

function resultTile(message: string | null): ReactNode | null {
  if (message === SAVED_MESSAGE) {
    return (
      <StatTile
        key="result"
        icon={CircleCheck}
        label="Settings"
        value="Saved"
        detail="Sync now uses these settings."
      />
    );
  }
  if (message === COMMITTED_MESSAGE) {
    return (
      <StatTile
        key="result"
        icon={CircleCheck}
        label="Sync"
        value="Committed"
        detail="GitHub has the latest automations."
      />
    );
  }
  if (message === CURRENT_MESSAGE) {
    return (
      <StatTile
        key="result"
        icon={CircleCheck}
        label="Sync"
        value="Up to date"
        detail="GitHub already matches Hub."
      />
    );
  }
  return null;
}

function checkTile(settings: AutomationGitSyncView["settings"]): ReactNode | null {
  if (
    settings.lastStatus === null &&
    settings.lastCheckedAt === null &&
    settings.lastCommitSha === null &&
    settings.lastError === null
  ) {
    return null;
  }
  return (
    <StatTile
      key="check"
      icon={GitCommitHorizontal}
      label="Last check"
      value={settings.lastStatus === null ? "Waiting" : checkLabel(settings.lastStatus)}
    >
      <LastCheckDetail settings={settings} />
    </StatTile>
  );
}

function LastCheckDetail({ settings }: { settings: AutomationGitSyncView["settings"] }) {
  const sha = settings.lastCommitSha?.slice(0, 7) ?? null;
  if (settings.lastCheckedAt === null && sha === null) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {settings.lastCheckedAt === null ? null : <RelativeTime value={settings.lastCheckedAt} />}
      {sha === null ? null : <span>{sha}</span>}
    </span>
  );
}

function checkLabel(status: NonNullable<AutomationGitSyncView["settings"]["lastStatus"]>): string {
  if (status === "failed") return "Failed";
  if (status === "unchanged") return "Up to date";
  return "Committed";
}
