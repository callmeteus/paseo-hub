import type { ProjectConfigurationStore } from "../../configuration/store.js";
import {
  type TriggerEventName,
  type TriggerProvider,
  type TriggerProviderMatch,
} from "../index.js";
import {
  NormalizedTelegramMessageEventSchema,
  type NormalizedTelegramMessageEvent,
} from "./events.js";
import { matchTelegramTriggers, readTelegramPromptBody } from "./match.js";
import { parseInvocation, matchesInputFilters } from "../invocation.js";

export interface TelegramTriggerContext {
  provider: "telegram";
  organizationId: string;
  target: TelegramOutputContext;
  event: TelegramMergeData;
  locale?: string;
}

export interface TelegramOutputContext {
  provider: "telegram";
  chatId: string;
  messageId: number;
}

export interface TelegramMergeData {
  telegram: {
    event_type: "message" | "mention";
    connection_id: string | null;
    chat: { id: string; type: string; title?: string };
    trigger_message: {
      id: string;
      text: string;
      body: string;
      author: { id: string; username?: string; first_name: string; is_bot: boolean };
      created_at: string;
      chat: { id: string };
    };
    trigger_thread_context: { status: "not_applicable" };
  };
}

export interface CreateTelegramTriggerProviderOptions {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  /** Read at match time: getMe resolves asynchronously after startup. */
  getBotUsername(): string;
}

/**
 * The Telegram trigger provider. Matches normalized updates against the project's compiled
 * triggers and builds the trigger/output contexts the workflow engine expects.
 */
export function createTelegramTriggerProvider(
  options: CreateTelegramTriggerProviderOptions,
): TriggerProvider<"telegram", TelegramTriggerContext, TelegramOutputContext, TelegramMergeData> {
  return {
    name: "telegram",
    eventNames: ["telegram.message", "telegram.mention"] as readonly TriggerEventName[],
    async match(external) {
      const event = NormalizedTelegramMessageEventSchema.parse(external.payload);
      const stored = await options
        .configurationStoreForProject(external.projectId)
        .getRevision(external.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!stored.configuration.triggers.some((candidate) => candidate.on === external.source)) {
        return "no_trigger_for_source";
      }
      const matches: TriggerProviderMatch<TelegramTriggerContext, TelegramOutputContext>[] = [];
      for (const match of matchTelegramTriggers(
        stored.configuration,
        event,
        options.getBotUsername(),
        external.connectionId,
      )) {
        const compiled = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiled === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const outputContext: TelegramOutputContext = {
          provider: "telegram",
          chatId: event.chatId,
          messageId: event.messageId,
        };
        const triggerContext: TelegramTriggerContext = {
          provider: "telegram",
          organizationId: external.organizationId,
          target: outputContext,
          event: buildMergeData(event, external.connectionId, options.getBotUsername()),
          ...(compiled.locale === undefined ? {} : { locale: compiled.locale }),
        };
        const invocation = parseInvocation(
          event.content,
          compiled.inputs,
          undefined,
          readTelegramPromptBody(event, options.getBotUsername()),
        );
        const base = {
          conversation: {
            key: JSON.stringify(["telegram", event.chatId]),
            label: "Telegram chat",
          },
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
        };
        if (invocation.status === "rejected") {
          matches.push({ ...base, invocation });
          continue;
        }
        if (!matchesInputFilters(invocation.inputs, compiled.filters?.inputs)) continue;
        matches.push({ ...base, invocation });
      }
      return matches.length === 0 ? "trigger_filters_rejected" : matches;
    },
    async materializeLaunch() {
      return {};
    },
    async materializeContext(launch): Promise<TelegramMergeData> {
      // The prompt reads `${{ paseo.context }}`. Expose the trigger message here
      // so the agent can resolve the author (telegram.trigger_message.author.id)
      // against team_member_platform_links before acting.
      return launch.triggerContext.event;
    },
  };
}

function buildMergeData(
  event: NormalizedTelegramMessageEvent,
  connectionId: string | null | undefined,
  botUsername: string,
): TelegramMergeData {
  return {
    telegram: {
      event_type: event.type,
      connection_id: connectionId ?? null,
      chat: { id: event.chatId, type: event.chatType },
      trigger_message: {
        id: event.id,
        text: event.content,
        body: readTelegramPromptBody(event, botUsername),
        author: {
          id: event.author.id,
          ...(event.author.username === undefined ? {} : { username: event.author.username }),
          first_name: event.author.firstName,
          is_bot: event.author.isBot,
        },
        created_at: event.createdAt,
        chat: { id: event.chatId },
      },
      trigger_thread_context: { status: "not_applicable" },
    },
  };
}
