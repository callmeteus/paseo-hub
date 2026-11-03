import { SlackChannelListSchema, SlackMessageListSchema } from "./contracts.js";
import type {
  ListSlackChannelsResult,
  ReadSlackMessagesResult,
} from "../public-operations/index.js";
import { assertNever, infrastructureProblem, problem, success } from "./problem-response.js";

const CHANNEL_STATUSES = [
  "channels",
  "not_connected",
  "connection_not_found",
  "connection_required",
  "slack_rejected",
  "infrastructure_unavailable",
] as const;

const MESSAGE_STATUSES = [
  "messages",
  "not_connected",
  "connection_not_found",
  "connection_required",
  "channel_not_found",
  "channel_ambiguous",
  "slack_rejected",
  "infrastructure_unavailable",
] as const;

/**
 * @param result - Operation result
 * @returns Whether this is a channel-list result
 */
export function isSlackChannelsResult(result: {
  status: string;
}): result is ListSlackChannelsResult {
  return (CHANNEL_STATUSES as readonly string[]).includes(result.status);
}

/**
 * @param result - Operation result
 * @returns Whether this is a message-read result
 */
export function isSlackMessagesResult(result: {
  status: string;
}): result is ReadSlackMessagesResult {
  return (MESSAGE_STATUSES as readonly string[]).includes(result.status);
}

/**
 * HTTP response for the Slack channel list.
 *
 * @param requestId - Caller or generated request id
 * @param result - Channel list outcome
 * @returns The HTTP response
 */
export function slackChannelsResponse(
  requestId: string,
  result: ListSlackChannelsResult,
): Response {
  if (result.status === "channels") {
    return success(requestId, 200, SlackChannelListSchema, {
      connection: result.connection,
      channels: result.channels,
      truncated: result.truncated,
    });
  }

  return slackFailureResponse(requestId, result);
}

/**
 * HTTP response for a Slack history read.
 *
 * @param requestId - Caller or generated request id
 * @param result - History outcome
 * @returns The HTTP response
 */
export function slackMessagesResponse(
  requestId: string,
  result: ReadSlackMessagesResult,
): Response {
  if (result.status === "messages") {
    return success(requestId, 200, SlackMessageListSchema, {
      connection: result.connection,
      channel: result.channel,
      messages: result.messages,
    });
  }

  return slackFailureResponse(requestId, result);
}

/**
 * Shared Slack failures. The bot token is never one of these fields.
 *
 * @param requestId - Caller or generated request id
 * @param result - Failure outcome
 * @returns The problem response
 */
function slackFailureResponse(
  requestId: string,
  result:
    | Exclude<ListSlackChannelsResult, { status: "channels" }>
    | Exclude<ReadSlackMessagesResult, { status: "messages" }>,
): Response {
  switch (result.status) {
    case "not_connected":
      return problem(
        requestId,
        404,
        "slack_not_connected",
        "Slack is not connected",
        "Connect Slack in Hub before listing channels.",
      );
    case "connection_not_found":
      return problem(
        requestId,
        404,
        "connection_not_found",
        "Slack connection not found",
        connectionNotFoundDetail(result.connection),
      );
    case "connection_required":
      return problem(
        requestId,
        409,
        "connection_required",
        "Slack connection required",
        connectionDetail(result.connections),
      );
    case "channel_not_found":
      return problem(
        requestId,
        404,
        "channel_not_found",
        "Slack channel not found",
        "No Slack channel matches that name.",
      );
    case "channel_ambiguous":
      return problem(
        requestId,
        409,
        "channel_ambiguous",
        "Several Slack channels match",
        channelDetail(result.channels),
      );
    case "slack_rejected":
      if (result.slackError === "missing_scope") {
        return problem(
          requestId,
          403,
          "missing_scope",
          "Slack needs a reconnect",
          "Reconnect Slack so the bot can list channels and read history.",
        );
      }

      return problem(
        requestId,
        403,
        "slack_rejected",
        "Slack refused the request",
        `Slack returned ${result.slackError}.`,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }

  return assertNever(result);
}

/**
 * @param connection - Slug the caller asked for
 * @returns The problem detail
 */
function connectionNotFoundDetail(connection: string): string {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(connection)) {
    return `No Slack connection is named ${connection}.`;
  }

  return "No Slack connection matches that slug.";
}

/**
 * @param connections - Slack connections the caller can choose
 * @returns The problem detail
 */
function connectionDetail(connections: readonly { slug: string; teamName: string }[]): string {
  const shown = connections.slice(0, 20);
  const names = shown.map((item) => `${item.slug} (${item.teamName})`).join(", ");
  const extra = connections.length - shown.length;

  if (extra > 0) {
    return `Pass connection. Available Slack connections: ${names}, and ${extra} more.`;
  }

  return `Pass connection. Available Slack connections: ${names}.`;
}

/**
 * @param channels - Matches the caller has to narrow
 * @returns The problem detail
 */
function channelDetail(channels: readonly { id: string; name: string }[]): string {
  const shown = channels.slice(0, 20);
  const names = shown.map((item) => `${item.name} (${item.id})`).join(", ");
  const extra = channels.length - shown.length;

  if (extra > 0) {
    return `Several channels match. Use a channel id: ${names}, and ${extra} more.`;
  }

  return `Several channels match. Use a channel id: ${names}.`;
}
