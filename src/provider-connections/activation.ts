import { z } from "zod";
import { createGitHubAuth } from "../auth/github.js";
import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";
import { resolveOrganizationId } from "../organizations/resolution.js";
import type { ProviderApplicationConfiguration, Provider } from "../provider-applications/index.js";
import { slugify } from "../slug.js";
import { hasRequiredSlackScopes, slackConnectionSlug } from "../providers/slack/client.js";
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
      organizationId = await resolveOrganizationId(options.database, connection.organization);
    } catch (error) {
      lookupError = error;
    }
    if (organizationId === undefined) {
      failures.push({
        provider: connection.provider,
        organization: connection.organization,
        resource: declarationResource(connection),
        error: lookupError ?? new Error(`organization ${connection.organization} does not exist`),
      });
      continue;
    }
    if (connection.provider === "github") {
      const failure = await activateGitHubConnection(options, connection, organizationId);
      if (failure !== undefined) failures.push(failure);
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

/** Label a failure carries: the provider resource, or the declaration when it never resolved. */
function declarationResource(connection: ConfiguredConnection): string {
  if (connection.provider === "slack") return "slack";
  if (connection.provider === "github") return connection.installationId;
  return connection.chats.join(",");
}

/**
 * Shape of the installation answer the App credential can read.
 *
 * `GitHubInstallationSchema` keeps only the identity the event pipeline needs, so the fields the
 * connection row stores are read here instead of widening that schema for one caller.
 */
const githubInstallationDetailSchema = z
  .object({
    account: z
      .object({
        id: z.number().int().positive(),
        login: z.string().min(1),
        type: z.string().min(1),
      })
      .passthrough(),
    suspended_at: z.string().nullish(),
  })
  .passthrough();

async function activateGitHubConnection(
  options: ActivateProviderConnectionsOptions,
  connection: Extract<ConfiguredConnection, { provider: "github" }>,
  organizationId: string,
): Promise<ProviderConnectionActivationFailure | undefined> {
  const application = options.applications.github;
  const fail = (error: unknown): ProviderConnectionActivationFailure => ({
    provider: "github",
    organization: connection.organization,
    resource: connection.installationId,
    error,
  });
  if (application === undefined || application.provider !== "github") {
    return fail(new Error("the GitHub application is not configured on this instance"));
  }
  const installationId = Number(connection.installationId);
  const auth = createGitHubAuth({
    appId: application.appId,
    privateKey: application.privateKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  // The installation is the external identity of the connection, so it is read from GitHub
  // instead of trusted from the declaration: a suspended or revoked installation must not keep
  // looking connected.
  let installation: Awaited<ReturnType<typeof auth.getInstallation>>;
  try {
    installation = await auth.getInstallation(installationId);
  } catch (error) {
    return fail(error);
  }
  if (installation === undefined) {
    return fail(
      new Error(`GitHub installation ${connection.installationId} is not visible to this App`),
    );
  }
  const detail = githubInstallationDetailSchema.safeParse(installation);
  if (!detail.success) return fail(new Error("GitHub answered without the installation account"));
  const account = detail.data.account;
  try {
    await options.database.query(
      `insert into github_connections
         (organization_id, installation_id, provider_application_id, slug, account_id, account_login,
          account_type, status, suspended_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (installation_id) do update set
         provider_application_id = excluded.provider_application_id,
         account_id = excluded.account_id,
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         status = excluded.status,
         suspended_at = excluded.suspended_at,
         updated_at = now()`,
      [
        organizationId,
        connection.installationId,
        application.appId,
        connection.slug ??
          (await availableGitHubSlug(options.database, organizationId, account.login)),
        String(account.id),
        account.login,
        account.type.toLowerCase(),
        detail.data.suspended_at == null ? "active" : "suspended",
        detail.data.suspended_at == null ? null : new Date(detail.data.suspended_at).toISOString(),
      ],
    );
    return undefined;
  } catch (error) {
    return fail(error);
  }
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
        slackConnectionSlug(grant.teamId),
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
 * Slug for a declared GitHub connection when the declaration does not name one.
 *
 * It mirrors what the panel saves (`<account>-github`), and a second installation on the same
 * account gets a numeric suffix instead of colliding with the first.
 */
async function availableGitHubSlug(
  database: DatabaseRuntime,
  organizationId: string,
  accountLogin: string,
): Promise<string> {
  const base = `${slugify(accountLogin, "connection")}-github`.slice(0, 120);
  const result = await database.query<QueryRow & { slug: string }>(
    "select slug from github_connections where organization_id = $1 and (slug = $2 or slug like $3)",
    [organizationId, base, `${base}-%`],
  );
  const used = new Set(result.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function connectionSlug(name: string, externalId: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "connection";
  return `${base}-${externalId}`.slice(0, 120);
}
