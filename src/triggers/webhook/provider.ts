import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { parseInvocation } from "../invocation.js";
import type { TriggerProvider, TriggerProviderMatch } from "../index.js";

export interface WebhookTriggerContext {
  provider: "webhook";
  deliveryId: string;
  body: unknown;
}

export function createWebhookProvider(
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore,
): TriggerProvider<"webhook", WebhookTriggerContext, WebhookTriggerContext> {
  return {
    name: "webhook",
    eventNames: ["webhook.received"],
    async match(external) {
      const stored = await configurationStoreForProject(external.projectId).getRevision(
        external.configurationRevisionId,
      );
      if (stored === undefined) return "configuration_unavailable";
      const payload = isRecord(external.payload) ? external.payload : {};
      const triggerName = payload["trigger"];
      if (typeof triggerName !== "string" || triggerName.length === 0) {
        return "no_trigger_for_source";
      }
      const trigger = stored.configuration.triggers.find(
        (candidate) => candidate.name === triggerName && candidate.on === "webhook.received",
      );
      if (trigger === undefined) return "no_trigger_for_source";
      const body = payload["body"];
      const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
      const invocation = parseInvocation(text, trigger.inputs);
      const triggerContext: WebhookTriggerContext = {
        provider: "webhook",
        deliveryId: external.deliveryId,
        body,
      };
      const shared = {
        triggerName: trigger.name,
        triggerContext,
        outputContext: triggerContext,
        configurationRevisionId: stored.revision.id,
        hubConfig: stored.configuration,
      };
      if (invocation.status === "rejected") {
        const rejected: TriggerProviderMatch<WebhookTriggerContext, WebhookTriggerContext> = {
          ...shared,
          invocation,
        };
        return [rejected];
      }
      const accepted: TriggerProviderMatch<WebhookTriggerContext, WebhookTriggerContext> = {
        ...shared,
        conversation: null,
        invocation,
      };
      return [accepted];
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
