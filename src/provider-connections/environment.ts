import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Inline JSON that declares provider connections created on every boot. */
export const PROVIDER_CONNECTIONS_ENVIRONMENT_VARIABLE = "PASEO_HUB_CONNECTIONS";
/** Path of the JSON file that declares the same connections. Takes over when the inline value is absent. */
export const PROVIDER_CONNECTIONS_FILE_ENVIRONMENT_VARIABLE = "PASEO_HUB_CONNECTIONS_FILE";

export interface ConfiguredSlackConnection {
  provider: "slack";
  /** Organization slug, id, or a name that matches exactly one organization. */
  organization: string;
  botToken: string;
}

export interface ConfiguredTelegramConnection {
  provider: "telegram";
  /** Organization slug, id, or a name that matches exactly one organization. */
  organization: string;
  chats: readonly string[];
}

export type ConfiguredConnection = ConfiguredSlackConnection | ConfiguredTelegramConnection;

const slackSchema = z
  .object({
    provider: z.literal("slack"),
    organization: z.string().trim().min(1),
    botToken: z.string().trim().min(1),
  })
  .strict();

const telegramSchema = z
  .object({
    provider: z.literal("telegram"),
    organization: z.string().trim().min(1),
    chats: z.array(z.union([z.string(), z.number().int()])).min(1),
  })
  .strict();

const documentSchema = z.object({ connections: z.array(z.unknown()) }).strict();

export class ProviderConnectionConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderConnectionConfigurationError";
  }
}

/**
 * Reads the connections an operator declared for this instance.
 *
 * Both variables are optional: with neither set the feature is off and the Hub keeps managing
 * connections through its own flows. The inline value wins, and declaring both is an error so a
 * stale file cannot silently shadow what the environment says.
 *
 * @param environment - Process environment
 * @returns Declared connections, in declaration order
 */
export async function readConfiguredConnections(
  environment: Record<string, string | undefined>,
): Promise<readonly ConfiguredConnection[]> {
  const inline = nonEmpty(environment[PROVIDER_CONNECTIONS_ENVIRONMENT_VARIABLE]);
  const file = nonEmpty(environment[PROVIDER_CONNECTIONS_FILE_ENVIRONMENT_VARIABLE]);
  if (inline !== undefined && file !== undefined) {
    throw new ProviderConnectionConfigurationError(
      `${PROVIDER_CONNECTIONS_ENVIRONMENT_VARIABLE} and ${PROVIDER_CONNECTIONS_FILE_ENVIRONMENT_VARIABLE} cannot both be set`,
    );
  }
  const document =
    inline ??
    (file === undefined
      ? undefined
      : await readFile(file, "utf8").catch((error: unknown) => {
          throw new ProviderConnectionConfigurationError(
            `could not read ${PROVIDER_CONNECTIONS_FILE_ENVIRONMENT_VARIABLE}`,
            { cause: error },
          );
        }));
  if (document === undefined) return [];
  return parseConfiguredConnections(document);
}

/**
 * Parses the declaration document. A malformed entry rejects the whole document, so a typo is
 * reported at boot instead of looking like a connection that simply has not been created yet.
 *
 * @param document - JSON text or an already parsed value
 * @returns Declared connections
 */
export function parseConfiguredConnections(document: unknown): readonly ConfiguredConnection[] {
  const parsedDocument = typeof document === "string" ? safeJson(document) : document;
  const root = documentSchema.safeParse(parsedDocument);
  if (!root.success) {
    throw new ProviderConnectionConfigurationError(
      "provider connection declaration must be an object with a connections array",
    );
  }
  return root.data.connections.map((entry) => {
    const slack = slackSchema.safeParse(entry);
    if (slack.success) return slack.data;
    const telegram = telegramSchema.safeParse(entry);
    if (telegram.success) {
      return {
        provider: "telegram" as const,
        organization: telegram.data.organization,
        chats: [...new Set(telegram.data.chats.map((chat) => String(chat)))],
      };
    }
    throw new ProviderConnectionConfigurationError(
      "connection entry must declare provider slack with botToken, or provider telegram with chats",
    );
  });
}

function safeJson(document: string): unknown {
  try {
    return JSON.parse(document);
  } catch (error) {
    throw new ProviderConnectionConfigurationError("provider connection JSON is invalid", {
      cause: error,
    });
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
