import type { AutomationGitSyncInterval, AutomationGitSyncRecord } from "../db/types.js";

/** What a commit says when the form leaves the message blank. */
export const DEFAULT_AUTOMATION_COMMIT_MESSAGE = "Sync Hub automations";

export interface AutomationGitSyncView {
  githubConfigured: boolean;
  canManage: boolean;
  repositories: {
    repositoryId: number;
    fullName: string;
    defaultBranch: string;
  }[];
  settings: {
    enabled: boolean;
    repositoryId: number | null;
    branch: string;
    commitMessage: string;
    automationsDirectory: string;
    intervalMinutes: AutomationGitSyncInterval;
    lastCheckedAt: string | null;
    lastSyncedAt: string | null;
    lastCommitSha: string | null;
    lastStatus: AutomationGitSyncRecord["lastStatus"];
    lastError: string | null;
  };
}

export function unconfiguredAutomationGitSyncView(): AutomationGitSyncView {
  return {
    githubConfigured: false,
    canManage: false,
    repositories: [],
    settings: {
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
    },
  };
}

/** The methods the Automations page calls. The worker stays on the GitHub registration. */
export interface AutomationGitSyncPort {
  view(request: Request, organizationSlug: string): Promise<AutomationGitSyncView>;
  save(
    request: Request,
    organizationSlug: string,
    input: SaveAutomationGitSyncRequest,
  ): Promise<AutomationGitSyncView>;
  syncNow(
    request: Request,
    organizationSlug: string,
  ): Promise<{ status: "unchanged" | "committed"; commitSha: string }>;
}

export interface SaveAutomationGitSyncRequest {
  enabled: boolean;
  repositoryId: number | null;
  branch: string;
  commitMessage: string;
  automationsDirectory: string;
  intervalMinutes: AutomationGitSyncInterval;
}

export class AutomationSyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutomationSyncError";
  }
}

/** Server functions live in another bundle, so `instanceof` is not reliable across that boundary. */
export function automationSyncErrorMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "AutomationSyncError") return undefined;
  return error.message;
}
