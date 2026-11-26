import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";
import type { ProviderApplicationConfiguration, Provider } from "../provider-applications/index.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { readSlackBotGrant } from "../providers/slack/installation.js";
import { createTelegramBotApi } from "../providers/telegram/client.js";
import type { ConfiguredConnection } from "./environment.js";

export interface ProviderConnectionActivationFailure {
  provider: ConfiguredConnection["provider"];
  organization: string;
  /** Chat id for Telegram, workspace id for Slack, or the declaration itself when it never resolved. */
  resource: string;
  error: unknown;
}

export interface ActivateProviderConnectionsOptions {
  database: DatabaseRuntime;
  connections: readonly ConfiguredConnection[];
  /** Applications read from the environment. A connection cannot be created without its app. */
  applications: Partial<Record<Provider, ProviderApplicationConfiguration>>;
  /** HTTP stand-in used by tests. */
  fetch?: typeof fetch;
  /** Slack API base used by tests. */
  slackApiBaseUrl?: string;
}

/**
 * Creates or refreshes the connections an operator declared for this instance.
 *
 * Runs on every boot and is idempotent: the external identity of each connection (Slack
 * workspace, Telegram chat) decides whether the row is inserted or updated. Nothing is deleted
 * when a declaration disappears, so removing a connection stays an explicit operator action.
 *
 * A failure is reported per connection and never stops the Hub: one unreachable workspace must
 * not take the instance down.
 *
 * @param options - Database, declarations, environment applications and test doubles
 * @returns One failure entry per connection that could not be created or refreshed
 */
export async function activateProviderConnectionsAtStartup(
  options: ActivateProviderConnectionsOptions,
): Promise<readonly ProviderConnectionActivationFailure[]> {
  const failures: ProviderConnectionActivationFailure[] = [];
  for (const connection of options.connections) {
    let organizationId: string | undefined;
    let lookupError: unknown;
    try {
      organizationId = await organizationIdForReference(options.database, connection.organization);
    } catch (error) {
      lookupError = error;
    }
    if (organizationId === undefined) {
      failures.push({
        provider: connection.provider,
        organization: connection.organization,
        resource: connection.provider === "slack" ? "slack" : connection.chats.join(","),
        error: lookupError ?? new Error(`organization ${connection.organization} does not exist`),
      });
      continue;
    }
    if (connection.provider === "slack") {
      const failure = await activateSlackConnection(options, connection, organizationId);
      if (failure !== undefined) failures.push(failure);
      continue;
    }
    failures.push(...(await activateTelegramConnection(options, connection, organizationId)));
  }
  return failures;
}

async function activateSlackConnection(
  options: ActivateProviderConnectionsOptions,
  connection: Extract<ConfiguredConnection, { provider: "slack" }>,
  organizationId: string,
): Promise<ProviderConnectionActivationFailure | undefined> {
  const application = options.applications.slack;
  const fail = (error: unknown): ProviderConnectionActivationFailure => ({
    provider: "slack",
    organization: connection.organization,
    resource: "slack",
    error,
  });
  if (application === undefined || application.provider !== "slack") {
    return fail(new Error("the Slack application is not configured on this instance"));
  }
  const grant = await readSlackBotGrant(connection.botToken, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.slackApiBaseUrl === undefined ? {} : { apiBaseUrl: options.slackApiBaseUrl }),
  });
  if (!grant.ok) {
    return fail(new Error(`Slack rejected the declared bot token (${grant.reason})`));
  }
  if (!hasRequiredSlackScopes(grant.scopes)) {
    return fail(new Error("the declared Slack bot token is missing a required scope"));
  }
  try {
    await options.database.query(
      `insert into slack_connections
         (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token, scopes,
          provider_application_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
       on conflict (team_id) do update set
         team_name = excluded.team_name,
         bot_user_id = excluded.bot_user_id,
         bot_access_token = excluded.bot_access_token,
         scopes = excluded.scopes,
         provider_application_id = excluded.provider_application_id,
         updated_at = now()`,
      [
        organizationId,
        grant.teamId,
        connectionSlug(grant.teamName, grant.teamId),
        grant.teamName,
        grant.botUserId,
        connection.botToken,
        JSON.stringify(grant.scopes),
        application.appId,
      ],
    );
    return undefined;
  } catch (error) {
    return fail(error);
  }
}

async function activateTelegramConnection(
  options: ActivateProviderConnectionsOptions,
  connection: Extract<ConfiguredConnection, { provider: "telegram" }>,
  organizationId: string,
): Promise<readonly ProviderConnectionActivationFailure[]> {
  const application = options.applications.telegram;
  if (application === undefined || application.provider !== "telegram") {
    return connection.chats.map((chat) => ({
      provider: "telegram" as const,
      organization: connection.organization,
      resource: chat,
      error: new Error("the Telegram application is not configured on this instance"),
    }));
  }
  const api = createTelegramBotApi({
    token: application.botToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // The connection binds the bot identity, exactly like the provider application, so the row
  // cannot look like it belongs to another app on the next boot.
  let bot: Awaited<ReturnType<typeof api.getMe>>;
  try {
    bot = await api.getMe();
  } catch (error) {
    return connection.chats.map((chat) => ({
      provider: "telegram" as const,
      organization: connection.organization,
      resource: chat,
      error,
    }));
  }
  const failures: ProviderConnectionActivationFailure[] = [];
  for (const chat of connection.chats) {
    try {
      const identity = await api.getChat(chat);
      const chatName =
        identity.title ??
        (identity.username === undefined ? String(identity.id) : `@${identity.username}`);
      await options.database.query(
        `insert into telegram_connections
           (organization_id, chat_id, slug, chat_name, provider_application_id, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (chat_id) do update set
           chat_name = excluded.chat_name,
           provider_application_id = excluded.provider_application_id,
           updated_at = now()`,
        [
          organizationId,
          String(identity.id),
          connectionSlug(chatName, String(identity.id)),
          chatName,
          String(bot.id),
        ],
      );
    } catch (error) {
      failures.push({
        provider: "telegram",
        organization: connection.organization,
        resource: chat,
        error,
      });
    }
  }
  return failures;
}

/**
 * Resolves a declaration to the organization it names.
 *
 * A slug is what links and the panel use, but a provisioned organization carries an id suffix, so
 * an operator who only knows the configured name would have to open the panel to learn it. The
 * reference therefore accepts the slug, the id, or a name that matches exactly one organization.
 */
async function organizationIdForReference(
  database: DatabaseRuntime,
  reference: string,
): Promise<string | undefined> {
  for (const column of ["slug", "id"] as const) {
    const result = await database.query<QueryRow & { id: string }>(
      `select id from organization where ${column} = $1`,
      [reference],
    );
    if (result.rows[0] !== undefined) return result.rows[0].id;
  }
  const byName = await database.query<QueryRow & { id: string }>(
    "select id from organization where lower(name) = lower($1) limit 2",
    [reference],
  );
  if (byName.rows.length > 1) {
    throw new Error(`organization ${reference} is ambiguous; declare its slug or id`);
  }
  return byName.rows[0]?.id;
}

function connectionSlug(name: string, externalId: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "connection";
  return `${base}-${externalId}`.slice(0, 120);
}
