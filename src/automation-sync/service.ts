import type { AuthServer } from "../auth/server.js";
import type { GitHubAuth } from "../auth/github.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { resolveRouteTenant } from "../projects/access.js";
import {
  AUTOMATION_GIT_SYNC_INTERVALS,
  type AutomationGitSyncRecord,
  type Database,
} from "../db/types.js";
import { reportFailure } from "../failures/index.js";
import {
  AutomationSyncError,
  DEFAULT_AUTOMATION_COMMIT_MESSAGE,
  type AutomationGitSyncView,
  type SaveAutomationGitSyncRequest,
} from "./contract.js";
import { gitTreeClient, publishAutomationTree, type GitTreeClient } from "./publish.js";
import { collectAutomationSnapshot, repositoryAutomationDirectory } from "./snapshot.js";

const ERROR_LIMIT = 500;
const BRANCH_NAME = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,250}$/u;

export class AutomationGitSync {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly options: {
      database: Database;
      auth: AuthServer | null;
      github?: GitHubAuth;
      now?: () => Date;
      trees?: (installationId: number) => Promise<GitTreeClient>;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = this.now()): Promise<void> {
    const rows = await this.options.database.listEnabledAutomationGitSyncs();
    await Promise.all(
      rows.map(async (row) => {
        if (!isDue(row, now) || this.running.has(row.organizationId)) return;
        try {
          await this.syncOrganization(row.organizationId);
        } catch (error) {
          reportFailure(error, {
            operation: "automation_git_sync.tick",
            component: "automation_sync",
            organizationId: row.organizationId,
          });
        }
      }),
    );
  }

  async view(request: Request, organizationSlug: string): Promise<AutomationGitSyncView> {
    const tenant = await this.tenant(request, organizationSlug);
    const [record, repositories] = await Promise.all([
      this.options.database.getAutomationGitSync(tenant.organization.id),
      this.options.database.listGitHubRepositories(tenant.organization.id),
    ]);
    return {
      githubConfigured: true,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      repositories: repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
      })),
      settings: settingsFrom(record),
    };
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: SaveAutomationGitSyncRequest,
  ): Promise<AutomationGitSyncView> {
    const tenant = await this.tenant(request, organizationSlug);
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    const saved = await this.settingsForSave(tenant.organization.id, input);
    await this.options.database.saveAutomationGitSync(saved);
    return this.view(request, organizationSlug);
  }

  async syncNow(
    request: Request,
    organizationSlug: string,
  ): Promise<{ status: "unchanged" | "committed"; commitSha: string }> {
    const tenant = await this.tenant(request, organizationSlug);
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return this.syncOrganization(tenant.organization.id);
  }

  async syncOrganization(
    organizationId: string,
  ): Promise<{ status: "unchanged" | "committed"; commitSha: string }> {
    if (this.running.has(organizationId)) {
      throw new AutomationSyncError("A sync is already running.");
    }
    this.running.add(organizationId);
    try {
      return await this.publish(organizationId);
    } finally {
      this.running.delete(organizationId);
    }
  }

  private async publish(
    organizationId: string,
  ): Promise<{ status: "unchanged" | "committed"; commitSha: string }> {
    const checkedAt = this.now();
    try {
      const record = await this.options.database.getAutomationGitSync(organizationId);
      if (record === undefined || !record.enabled) {
        throw new AutomationSyncError("Turn on git sync and choose a repository first.");
      }
      const target = repositoryTarget(record);
      const directory = repositoryAutomationDirectory(record.automationsDirectory);
      const usage = await this.options.database.organizationConnectionUsage(organizationId);
      const connection = usage.github.find((item) => item.id === record.githubConnectionId);
      if (connection === undefined || connection.status !== "active") {
        throw new AutomationSyncError("The GitHub connection for this repository is not active.");
      }
      const files = await collectAutomationSnapshot(
        this.options.database,
        organizationId,
        directory,
      );
      const github = this.options.github;
      const trees =
        this.options.trees ??
        (async (installationId: number) => {
          if (github === undefined) {
            throw new AutomationSyncError("GitHub is not configured on this Hub.");
          }
          return gitTreeClient(await github.createInstallationOctokit(installationId));
        });
      const result = await publishAutomationTree(await trees(connection.installationId), {
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        files,
        prefixes: [".paseo/triggers/", `${directory}/`],
        message: commitMessageFor(record),
      });
      await this.options.database.recordAutomationGitSyncResult({
        organizationId,
        checkedAt,
        status: result.status,
        error: null,
        commitSha: result.status === "committed" ? result.commitSha : null,
        syncedAt: result.status === "committed" ? checkedAt : null,
      });
      return result;
    } catch (error) {
      await this.options.database.recordAutomationGitSyncResult({
        organizationId,
        checkedAt,
        status: "failed",
        error: syncError(error),
        commitSha: null,
        syncedAt: null,
      });
      if (error instanceof AutomationSyncError) throw error;
      throw new AutomationSyncError(syncError(error), { cause: error });
    }
  }

  private async settingsForSave(organizationId: string, input: SaveAutomationGitSyncRequest) {
    const intervals: readonly number[] = AUTOMATION_GIT_SYNC_INTERVALS;
    if (!intervals.includes(input.intervalMinutes)) {
      throw new AutomationSyncError("Check every 5, 15, or 60 minutes.");
    }
    const directory = repositoryAutomationDirectory(input.automationsDirectory);
    if (!input.enabled && input.repositoryId === null) {
      return {
        organizationId,
        enabled: false,
        githubConnectionId: null,
        repositoryId: null,
        repositoryFullName: null,
        branch: blankToNull(input.branch),
        commitMessage: savedCommitMessage(input.commitMessage),
        automationsDirectory: directory,
        intervalMinutes: input.intervalMinutes,
      };
    }
    if (input.repositoryId === null) {
      throw new AutomationSyncError("Choose a repository before turning sync on.");
    }
    const repositories = await this.options.database.listGitHubRepositories(organizationId);
    const repository = repositories.find((item) => item.repositoryId === input.repositoryId);
    if (repository === undefined) {
      throw new AutomationSyncError(
        "That repository is not on a GitHub connection for this organization.",
      );
    }
    const branch = input.branch.trim() || repository.defaultBranch;
    if (!BRANCH_NAME.test(branch)) {
      throw new AutomationSyncError("The branch name is not valid.");
    }
    return {
      organizationId,
      enabled: input.enabled,
      githubConnectionId: repository.connectionId,
      repositoryId: repository.repositoryId,
      repositoryFullName: repository.fullName,
      branch,
      commitMessage: savedCommitMessage(input.commitMessage),
      automationsDirectory: directory,
      intervalMinutes: input.intervalMinutes,
    };
  }

  private async tenant(request: Request, organizationSlug: string) {
    if (this.options.auth === null) {
      throw new AutomationSyncError("GitHub sync is not available on this Hub.");
    }
    const { tenant } = await resolveRouteTenant(this.options.auth, this.options.database, request, {
      organizationSlug,
    });
    return tenant;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function settingsFrom(
  record: AutomationGitSyncRecord | undefined,
): AutomationGitSyncView["settings"] {
  if (record === undefined) {
    return {
      enabled: false,
      repositoryId: null,
      branch: "",
      commitMessage: "",
      automationsDirectory: "",
      intervalMinutes: 15,
      lastCheckedAt: null,
      lastSyncedAt: null,
      lastCommitSha: null,
      lastStatus: null,
      lastError: null,
    };
  }
  return {
    enabled: record.enabled,
    repositoryId: record.repositoryId,
    branch: text(record.branch),
    commitMessage: text(record.commitMessage),
    automationsDirectory: text(record.automationsDirectory),
    intervalMinutes: record.intervalMinutes,
    lastCheckedAt: instant(record.lastCheckedAt),
    lastSyncedAt: instant(record.lastSyncedAt),
    lastCommitSha: record.lastCommitSha,
    lastStatus: record.lastStatus,
    lastError: record.lastError,
  };
}

function text(value: string | null): string {
  return value === null ? "" : value;
}

function instant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function repositoryTarget(record: AutomationGitSyncRecord): {
  owner: string;
  repo: string;
  branch: string;
} {
  const fullName = record.repositoryFullName ?? "";
  const slash = fullName.indexOf("/");
  const owner = slash > 0 ? fullName.slice(0, slash) : "";
  const repo = slash > 0 ? fullName.slice(slash + 1) : "";
  const branch = record.branch ?? "";
  if (owner.length === 0 || repo.length === 0 || repo.includes("/") || !BRANCH_NAME.test(branch)) {
    throw new AutomationSyncError("The saved repository is not a valid GitHub target.");
  }
  return { owner, repo, branch };
}

function isDue(record: AutomationGitSyncRecord, now: Date): boolean {
  if (record.lastCheckedAt === null) return true;
  return now.getTime() - record.lastCheckedAt.getTime() >= record.intervalMinutes * 60_000;
}

const COMMIT_MESSAGE_LIMIT = 500;

function commitMessageFor(record: AutomationGitSyncRecord): string {
  const message = record.commitMessage?.trim() ?? "";
  return message.length === 0 ? DEFAULT_AUTOMATION_COMMIT_MESSAGE : message;
}

function savedCommitMessage(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > COMMIT_MESSAGE_LIMIT || trimmed.includes("\0")) {
    throw new AutomationSyncError("The commit message has to be 500 characters or fewer.");
  }
  return trimmed;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function syncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Sync failed.";
  return message.slice(0, ERROR_LIMIT);
}
