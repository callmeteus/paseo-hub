import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { SlackChannelListError, type SlackChannelChoice } from "../providers/slack/channels.js";
import { getApplication } from "../server/runtime.js";
import type { TriggerDashboard } from "./dashboard.js";
import type { RunDetail } from "./run-detail.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const runScopeSchema = scopeSchema.extend({ runId: z.string().uuid() });
const slackChannelsSchema = scopeSchema.extend({
  connectionSlug: z.string().trim().min(1).max(100),
});
const saveSchema = scopeSchema.extend({
  triggerId: z.string().uuid().optional(),
  yaml: z.string().min(1),
});
const deleteSchema = scopeSchema.extend({ triggerId: z.string().uuid() });

export const triggerSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<TriggerSnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.list", data.organizationSlug), {
        fallback: "Hub couldn't load this organization's triggers. Reload the page.",
      });
    }
  });

export const triggerRunSnapshot = createServerFn({ method: "GET" })
  .validator(runScopeSchema)
  .handler(async ({ data }): Promise<Result<RunDetail>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(
        await dashboard.activityRun(getRequest(), data.organizationSlug, data.runId),
      );
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.run", data.organizationSlug), {
        fallback: "Hub couldn't load this run.",
        notFound: "This run is not in this organization.",
        forbidden: "You don't have permission to view this run.",
      });
    }
  });

export const saveTrigger = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.save(getRequest(), data.organizationSlug, {
        ...(data.triggerId === undefined ? {} : { triggerId: data.triggerId }),
        yaml: data.yaml,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.save", data.organizationSlug), {
        fallback: error instanceof Error ? error.message : "Hub couldn't save this trigger.",
        forbidden: "You don't have permission to manage triggers.",
        validation: error instanceof Error ? error.message : "This trigger is invalid.",
        conflict: "A trigger with this name already exists.",
      });
    }
  });

export const deleteTrigger = createServerFn({ method: "POST" })
  .validator(deleteSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.delete(getRequest(), data.organizationSlug, data.triggerId);
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.delete", data.organizationSlug), {
        fallback: "Hub couldn't delete this automation.",
        forbidden: "You don't have permission to manage automations.",
        notFound: "This automation is no longer in this organization.",
      });
    }
  });

export const slackChannels = createServerFn({ method: "GET" })
  .validator(slackChannelsSchema)
  .handler(async ({ data }): Promise<Result<SlackChannelChoice[]>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(
        await dashboard.slackChannels(getRequest(), data.organizationSlug, data.connectionSlug),
      );
    } catch (error) {
      // The bot token predates the channel-list scopes. Say so, instead of Slack's error code.
      if (SlackChannelListError.read(error) === "missing_scope") {
        return respondError({ message: "Reconnect Slack to choose channels." });
      }

      return respondWithFailure(
        error,
        triggerContext("trigger.slack-channels", data.organizationSlug),
        {
          fallback: "Hub couldn't load Slack channels.",
          notFound: "That Slack connection is not in this organization.",
          forbidden: "You don't have permission to view these channels.",
        },
      );
    }
  });

export type TriggerSnapshot = Awaited<ReturnType<TriggerDashboard["snapshot"]>>;

function triggerContext(operation: string, organizationSlug: string) {
  return { operation, component: "triggers", organizationSlug } as const;
}
