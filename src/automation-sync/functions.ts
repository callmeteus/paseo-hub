import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import {
  AutomationSyncError,
  automationSyncErrorMessage,
  unconfiguredAutomationGitSyncView,
  type AutomationGitSyncView,
} from "./contract.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  enabled: z.boolean(),
  repositoryId: z.number().int().positive().nullable(),
  branch: z.string().max(250),
  commitMessage: z.string().max(500),
  automationsDirectory: z.string().max(1_000),
  intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
});

export const automationGitSyncSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<AutomationGitSyncView>> => {
    try {
      const sync = (await getApplication()).automationSync;
      if (sync === null) {
        return respondOk(unavailable());
      }
      return respondOk(await sync.view(getRequest(), data.organizationSlug));
    } catch (error) {
      return syncFailure(error, "automation_git_sync.view", data.organizationSlug);
    }
  });

export const saveAutomationGitSync = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<AutomationGitSyncView>> => {
    try {
      const sync = (await getApplication()).automationSync;
      if (sync === null) throw new AutomationSyncError("GitHub is not configured on this Hub.");
      return respondOk(
        await sync.save(getRequest(), data.organizationSlug, {
          enabled: data.enabled,
          repositoryId: data.repositoryId,
          branch: data.branch,
          commitMessage: data.commitMessage,
          automationsDirectory: data.automationsDirectory,
          intervalMinutes: data.intervalMinutes,
        }),
      );
    } catch (error) {
      return syncFailure(error, "automation_git_sync.save", data.organizationSlug);
    }
  });

export const syncAutomationGitNow = createServerFn({ method: "POST" })
  .validator(scopeSchema)
  .handler(
    async ({ data }): Promise<Result<{ status: "unchanged" | "committed"; commitSha: string }>> => {
      try {
        const sync = (await getApplication()).automationSync;
        if (sync === null) throw new AutomationSyncError("GitHub is not configured on this Hub.");
        return respondOk(await sync.syncNow(getRequest(), data.organizationSlug));
      } catch (error) {
        return syncFailure(error, "automation_git_sync.now", data.organizationSlug);
      }
    },
  );

function unavailable(): AutomationGitSyncView {
  return unconfiguredAutomationGitSyncView();
}

function syncFailure(error: unknown, operation: string, organizationSlug: string) {
  const message = automationSyncErrorMessage(error);
  if (message !== undefined) return respondError({ message });
  return respondWithFailure(
    error,
    { operation, component: "automation_sync", organizationSlug },
    {
      fallback: "Hub couldn't update git sync.",
      forbidden: "You don't have permission to manage automations.",
      validation: error instanceof Error ? error.message : "Git sync settings are invalid.",
    },
  );
}
