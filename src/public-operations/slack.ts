import { isDatabaseUnavailableError } from "../db/errors.js";
import {
  listSlackMemberChannels,
  resolveSlackChannel,
  selectSlackChannels,
  SlackChannelListError,
  type SlackChannelChoice,
} from "../providers/slack/channels.js";
import { readSlackChannelHistory, type SlackChannelMessage } from "../providers/slack/history.js";
import type {
  ListSlackChannelsResult,
  PublicOperationRepository,
  ReadSlackMessagesResult,
} from "./types.js";

const MATCH_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 50;

interface SlackReadClient {
  listChannels(token: string): Promise<readonly SlackChannelChoice[]>;
  readHistory(
    token: string,
    channelId: string,
    limit: number,
  ): Promise<readonly SlackChannelMessage[]>;
}

/**
 * Lists Slack channels for a public API caller.
 *
 * The bot token is used here and is not part of the result.
 *
 * @param input - Organization, optional connection slug, and optional name query
 * @returns Channel ids the caller can store on a trigger
 */
export async function listPublicSlackChannels(input: {
  repository: Pick<PublicOperationRepository, "slackConnection">;
  organizationId: string;
  connection: string | undefined;
  query: string | undefined;
  client?: SlackReadClient | undefined;
}): Promise<ListSlackChannelsResult> {
  const ready = await readyConnection(input.repository, input.organizationId, input.connection);

  if (ready.status !== "ready") {
    return ready;
  }

  try {
    const channels = await slackClient(input.client).listChannels(ready.token);
    const matches = selectSlackChannels(channels, input.query);
    const visible = matches.slice(0, MATCH_LIMIT);

    return {
      status: "channels",
      connection: ready.slug,
      channels: visible,
      truncated: matches.length > visible.length,
    };
  } catch (error) {
    return slackFailure(error);
  }
}

/**
 * Reads recent messages once the channel name has been resolved to an id.
 *
 * @param input - Organization, channel name or id, and page size
 * @returns The channel id and the newest messages
 */
export async function readPublicSlackMessages(input: {
  repository: Pick<PublicOperationRepository, "slackConnection">;
  organizationId: string;
  connection: string | undefined;
  channel: string;
  limit: number | undefined;
  client?: SlackReadClient | undefined;
}): Promise<ReadSlackMessagesResult> {
  const ready = await readyConnection(input.repository, input.organizationId, input.connection);

  if (ready.status !== "ready") {
    return ready;
  }

  try {
    const client = slackClient(input.client);
    const channels = await client.listChannels(ready.token);
    const resolved = resolveSlackChannel(channels, input.channel);

    if (resolved.status === "missing") {
      return { status: "channel_not_found", query: input.channel };
    }

    if (resolved.status === "ambiguous") {
      return { status: "channel_ambiguous", channels: resolved.channels };
    }

    const messages = await client.readHistory(
      ready.token,
      resolved.channel.id,
      clampMessageLimit(input.limit),
    );

    return {
      status: "messages",
      connection: ready.slug,
      channel: {
        id: resolved.channel.id,
        name: resolved.channel.name,
      },
      messages,
    };
  } catch (error) {
    return slackFailure(error);
  }
}

/**
 * @param client - Test double, or the live Slack Web API
 * @returns Channel list and history calls
 */
function slackClient(client: SlackReadClient | undefined): SlackReadClient {
  if (client !== undefined) {
    return client;
  }

  return {
    listChannels(token) {
      return listSlackMemberChannels(token);
    },
    readHistory(token, channelId, limit) {
      return readSlackChannelHistory(token, channelId, limit);
    },
  };
}

/**
 * Picks the only Slack connection, or the slug the caller named.
 *
 * @param repository - Connection lookup
 * @param organizationId - Organization that owns the connection
 * @param connection - Slug, when the organization has more than one
 * @returns The bot token for this request, or why a token was not chosen
 */
async function readyConnection(
  repository: Pick<PublicOperationRepository, "slackConnection">,
  organizationId: string,
  connection: string | undefined,
): Promise<
  | { status: "ready"; slug: string; token: string }
  | { status: "not_connected" }
  | { status: "connection_not_found"; connection: string }
  | {
      status: "connection_required";
      connections: readonly { slug: string; teamName: string }[];
    }
  | { status: "infrastructure_unavailable" }
> {
  try {
    const found = await repository.slackConnection(organizationId, connection);

    if (found.status === "missing") {
      if (connection !== undefined) {
        return { status: "connection_not_found", connection };
      }

      return { status: "not_connected" };
    }

    if (found.status === "ambiguous") {
      return { status: "connection_required", connections: found.connections };
    }

    return found;
  } catch (error) {
    return storageOrThrow(error);
  }
}

/**
 * Maps a Slack Web API failure. Anything else is storage, or a bug.
 *
 * @param error - Failure from the channel list or the history read
 * @returns A public result that does not include the bot token
 */
function slackFailure(
  error: unknown,
): { status: "slack_rejected"; slackError: string } | { status: "infrastructure_unavailable" } {
  const slackError = SlackChannelListError.read(error);

  if (slackError !== undefined) {
    return { status: "slack_rejected", slackError: publicSlackError(slackError) };
  }

  return storageOrThrow(error);
}

/**
 * Keeps Slack's error code when it is a short token. A stray payload becomes unknown_error.
 *
 * @param code - Slack's `error` field
 * @returns A code safe to put in a problem response
 */
function publicSlackError(code: string): string {
  if (/^[a-z0-9_]{1,80}$/u.test(code)) {
    return code;
  }

  return "unknown_error";
}

/**
 * @param limit - Requested page size
 * @returns A limit from 1 to 50
 */
function clampMessageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return DEFAULT_MESSAGE_LIMIT;
  }

  if (limit > MAX_MESSAGE_LIMIT) {
    return MAX_MESSAGE_LIMIT;
  }

  return limit;
}

/**
 * @param error - Failure from the connection lookup
 * @returns The infrastructure result, or rethrows a programming error
 */
function storageOrThrow(error: unknown): { status: "infrastructure_unavailable" } {
  if (isDatabaseUnavailableError(error)) {
    return { status: "infrastructure_unavailable" };
  }

  throw error;
}
