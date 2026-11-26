import type { AuthServer } from "../../auth/server.js";
import type { Database, TelegramConnectionRecord } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  connectionAccess,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import { createTelegramBotApi, type TelegramBotApi } from "./client.js";
import { createTelegramSource, telegramWebhookUrl } from "../../triggers/telegram/source.js";
import { createTelegramTriggerProvider } from "../../triggers/telegram/provider.js";
import {
  createTelegramOutputExecutor,
  telegramAgentTool,
  type TelegramOutputType,
} from "../../triggers/telegram/reply.js";
import { outputContextProvider } from "../../execution-capabilities/outputs.js";

export interface TelegramRegistrationConfiguration {
  botToken: string;
  /** Optional secret token used to protect the webhook. */
  secretToken?: string;
}

export interface CreateTelegramRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: TelegramRegistrationConfiguration | null;
  api?: TelegramBotApi;
  fetch?: typeof fetch;
  configurationVersion?: number;
  /** In-memory store of the label for each callback value from the last finish. */
  choiceLabels?: Map<string, string>;
}

interface TelegramConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: TelegramRegistrationConfiguration;
}

export const OUTPUT_TYPES: readonly TelegramOutputType[] = [
  "telegram.reply",
  "telegram.agent.stage",
  "telegram.agent.tool",
  "telegram.agent.say",
  "telegram.agent.finish",
  "telegram.agent.prompts",
  "telegram.typing",
];

/**
 * Builds the Telegram provider registration. Telegram is configured with a bot token rather
 * than an OAuth app: `getMe` verifies the token and supplies the bot identity used for mentions.
 */
export function createTelegramRegistration(
  options: CreateTelegramRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyTelegramRegistration(options);
  }
  if (options.database === null) return unavailableTelegramRegistration();

  const database = options.database;
  const api =
    options.api ??
    createTelegramBotApi({
      token: configuration.botToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const choiceLabels = options.choiceLabels ?? new Map<string, string>();
  const connection =
    options.auth === null
      ? telegramConnectionStatus(true)
      : createTelegramConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.publicBaseUrl,
            configurationVersion: options.configurationVersion ?? 0,
            configuration,
          },
          api,
        );

  let botUsername = "";
  void (async () => {
    try {
      botUsername = (await api.getMe()).username;
    } catch (error) {
      reportFailure(
        error,
        { operation: "telegram.getMe", component: "providers", provider: "telegram" },
        { scrubValues: [configuration.botToken] },
      );
    }
  })();

  const webhookUrl = telegramWebhookUrl(options.publicBaseUrl);
  const source = createTelegramSource({
    getBotUsername: () => botUsername,
    ...(configuration.secretToken === undefined ? {} : { secretToken: configuration.secretToken }),
    webhookUrl,
    api,
    accept: (input) => database.acceptTelegramEvent(input),
    choiceLabel: (value) => choiceLabels.get(value),
    localeFor: async (receiptId) => {
      const runs = await database.findTriggerRunsByProviderEventReceiptId(receiptId);
      // Telegram keeps the trigger locale on the trigger context; Slack also
      // copies it onto the output context.
      const context = runs[0]?.triggerContext ?? runs[0]?.outputContext;
      if (typeof context !== "object" || context === null) return undefined;
      if (!("locale" in context)) return undefined;
      const locale: unknown = context.locale;
      return typeof locale === "string" ? locale : undefined;
    },
  });

  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.publicBaseUrl,
    },
    connection,
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createTelegramTriggerProvider({
          configurationStoreForProject,
          getBotUsername: () => botUsername,
        }),
    ],
    sources: [source],
    outputs: OUTPUT_TYPES.map((type) => ({
      type,
      tool: telegramAgentTool(type),
      available: outputContextProvider("telegram"),
      execute: createTelegramOutputExecutor(api, type),
    })),
    requests: [
      {
        name: "telegram.events",
        handle: (request) => source.handle(request),
      },
    ],
  };
}

function emptyTelegramRegistration(
  options: Pick<CreateTelegramRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const connection =
    options.database === null || options.auth === null
      ? telegramConnectionStatus(false)
      : createTelegramConnection(
          {
            database: options.database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.applicationBaseUrl,
            configurationVersion: 0,
            configuration: { botToken: "unconfigured" },
          },
          undefined,
        );
  return { connection, triggerProviders: [], sources: [], outputs: [], requests: [] };
}

function unavailableTelegramRegistration(): ProviderRegistration {
  return {
    connection: telegramConnectionStatus(true),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function telegramConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "telegram",
    status: (connections) => telegramStatus(configured, connections.telegram ?? []),
    actions: {},
  };
}

function createTelegramConnection(
  options: TelegramConnectionOptions,
  api: TelegramBotApi | undefined,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = connectionAccess(
        await manageConnectionAccess(options.auth, options.database, request),
      );
      if (api === undefined)
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      // The Telegram bot is already configured with a token. Binding calls getMe and stores the
      // identity as the connected account, so no OAuth state exchange is needed.
      return Response.json({ url: clientSetupUrl(options.callbackOrigin, access) });
    } catch {
      return Response.json({ error: "connection_unavailable" }, { status: 503 });
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = connectionAccess(
        await manageConnectionAccess(options.auth, options.database, request),
      );
      await options.database.disconnectTelegramConnection(requiredConnectionId(request), access);
      return Response.json({ disconnected: true });
    } catch {
      return Response.json({ error: "connection_unavailable" }, { status: 503 });
    }
  };

  return {
    name: "telegram",
    status: (connections) => telegramStatus(api !== undefined, connections.telegram ?? []),
    actions: {
      start,
      disconnect,
      callback: (request) => completeConnection(options, api, request),
    },
  };
}

function clientSetupUrl(
  callbackOrigin: string,
  access: { organizationId: string; membershipId: string },
): string {
  const url = new URL("/api/integrations/telegram/callback", callbackOrigin);
  url.searchParams.set("organization", access.organizationId);
  url.searchParams.set("membership", access.membershipId);
  return url.toString();
}

async function completeConnection(
  options: TelegramConnectionOptions,
  api: TelegramBotApi | undefined,
  request: Request,
): Promise<Response> {
  if (api === undefined)
    return Response.json({ error: "provider_not_configured" }, { status: 409 });
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organization");
  const membershipId = url.searchParams.get("membership");
  if (organizationId === null || membershipId === null) {
    return Response.json({ error: "invalid_callback" }, { status: 400 });
  }
  try {
    const identity = await api.getMe();
    await options.database.bindTelegramConnection({
      organizationId,
      membershipId,
      chatId: String(identity.id),
      chatName: `@${identity.username}`,
      providerApplicationId: String(identity.id),
    });
    return Response.redirect(
      new URL("/connections?provider=telegram&result=connected", options.callbackOrigin),
      303,
    );
  } catch {
    return Response.json({ error: "connection_unavailable" }, { status: 503 });
  }
}

function telegramStatus(configured: boolean, bindings: readonly TelegramConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}
