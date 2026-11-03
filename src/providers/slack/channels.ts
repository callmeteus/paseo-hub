import { z } from "zod";

/** A channel the bot can receive, named for the picker and identified for the filter. */
export interface SlackChannelChoice {
  id: string;
  name: string;
  isPrivate: boolean;
}

/**
 * Slack refused or could not answer a channel list.
 *
 * The message is Slack's error code. Callers map `missing_scope` to operator copy.
 */
export class SlackChannelListError extends Error {
  /**
   * Reads Slack's error code when the failure is a channel list, including across a server-function chunk.
   *
   * @param error - Whatever the list call threw
   * @returns Slack's error code, or undefined when this is a different failure
   */
  static read(error: unknown): string | undefined {
    if (!(error instanceof Error) || error.name !== "SlackChannelListError") {
      return undefined;
    }

    if (!("slackError" in error)) {
      return undefined;
    }

    const slackError = error.slackError;
    if (typeof slackError !== "string") {
      return undefined;
    }

    return slackError;
  }

  /**
   * @param slackError - Slack's `error` field, or `invalid_response` when the body is not that API
   * @param options - Optional cause, when the body was not JSON
   */
  constructor(
    readonly slackError: string,
    options?: { cause?: unknown },
  ) {
    super(slackError, options);
    this.name = "SlackChannelListError";
  }
}

const SlackConversationsSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    channels: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            is_private: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    response_metadata: z
      .object({
        next_cursor: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const PAGE_LIMIT = 20;

/**
 * Lists public and private channels the bot is a member of.
 *
 * Names are what the editor shows. The trigger filter still stores channel ids, and an empty
 * selection means every channel, so this list is the membership the bot can actually see.
 *
 * @param token - Bot token of the selected Slack connection
 * @param request - HTTP client. Tests pass a fake; the server uses `fetch`
 * @returns Channels sorted by name
 */
export async function listSlackMemberChannels(
  token: string,
  request: typeof fetch = fetch,
): Promise<SlackChannelChoice[]> {
  const byId = new Map<string, SlackChannelChoice>();
  let cursor = "";

  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const url = new URL("https://slack.com/api/users.conversations");
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");

    if (cursor !== "") {
      url.searchParams.set("cursor", cursor);
    }

    const response = await request(url, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    // A transport failure is not a Slack error payload
    if (!response.ok) {
      throw new SlackChannelListError("invalid_response");
    }

    const body = await readConversations(response);

    if (!body.ok) {
      throw new SlackChannelListError(body.error ?? "unknown_error");
    }

    for (const channel of body.channels ?? []) {
      // A conversation without a name cannot be picked
      if (channel.name === undefined || channel.name.length === 0) {
        continue;
      }

      byId.set(channel.id, {
        id: channel.id,
        name: channel.name,
        isPrivate: channel.is_private === true,
      });
    }

    cursor = body.response_metadata?.next_cursor ?? "";

    if (cursor === "") {
      break;
    }
  }

  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Keeps channels whose name or id matches a picker query.
 *
 * An empty query returns every channel. A leading # is ignored. An exact name or id wins over a substring.
 *
 * @param channels - Channels the bot can see
 * @param query - Name, #name, or channel id. Undefined returns the full list
 * @returns Matching channels, still sorted by name
 */
export function selectSlackChannels(
  channels: readonly SlackChannelChoice[],
  query: string | undefined,
): SlackChannelChoice[] {
  const normalized = normalizeChannelQuery(query);

  if (normalized === undefined) {
    return [...channels];
  }

  const trimmed = query?.trim() ?? "";
  const exact = channels.filter((channel) => {
    if (channel.id === trimmed || channel.id.toLowerCase() === normalized) {
      return true;
    }

    return channel.name.toLowerCase() === normalized;
  });

  if (exact.length > 0) {
    return exact;
  }

  return channels.filter((channel) => channel.name.toLowerCase().includes(normalized));
}

/**
 * Resolves one channel from a name or id.
 *
 * @param channels - Channels the bot can see
 * @param channel - Name, #name, or channel id
 * @returns The only match, or why it could not be chosen
 */
export function resolveSlackChannel(
  channels: readonly SlackChannelChoice[],
  channel: string,
):
  | { status: "resolved"; channel: SlackChannelChoice }
  | { status: "missing" }
  | { status: "ambiguous"; channels: SlackChannelChoice[] } {
  const normalized = normalizeChannelQuery(channel);

  if (normalized === undefined) {
    return { status: "missing" };
  }

  const matches = selectSlackChannels(channels, channel);
  const first = matches[0];

  if (first === undefined) {
    return { status: "missing" };
  }

  if (matches.length > 1) {
    return { status: "ambiguous", channels: matches };
  }

  return { status: "resolved", channel: first };
}

/**
 * Strips one leading # and ignores a blank query.
 *
 * @param query - Raw channel text
 * @returns Lowercase name, or undefined when there is nothing to match
 */
function normalizeChannelQuery(query: string | undefined): string | undefined {
  if (query === undefined) {
    return undefined;
  }

  const trimmed = query.trim();
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1).trim() : trimmed;
  const normalized = withoutHash.toLowerCase();

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

/**
 * Parses one `users.conversations` page.
 *
 * @param response - A successful HTTP response whose body should be Slack's JSON
 * @returns The parsed page
 */
async function readConversations(
  response: Response,
): Promise<z.infer<typeof SlackConversationsSchema>> {
  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    throw new SlackChannelListError("invalid_response", { cause: error });
  }

  const parsed = SlackConversationsSchema.safeParse(body);

  if (!parsed.success) {
    throw new SlackChannelListError("invalid_response");
  }

  return parsed.data;
}
