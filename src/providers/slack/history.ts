import { z } from "zod";
import { readSlackMessageText } from "../../triggers/slack/forwarded-message.js";
import { SlackChannelListError } from "./channels.js";

/** One recent Slack message, small enough to show a chat how the channel writes. */
export interface SlackChannelMessage {
  ts: string;
  author: string | null;
  text: string;
  threadTs: string | null;
  isReply: boolean;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const TEXT_LIMIT = 1500;

const SlackHistorySchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    messages: z
      .array(
        z
          .object({
            ts: z.string().optional(),
            text: z.string().optional(),
            user: z.string().optional(),
            bot_id: z.string().optional(),
            thread_ts: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Reads the newest messages in a channel the bot already belongs to.
 *
 * The text is truncated and includes forwarded layers. The bot token stays on Slack's side.
 *
 * @param token - Bot token of the selected Slack connection
 * @param channelId - Slack channel id
 * @param limit - How many messages to ask for. Clamped to 1..50
 * @param request - HTTP client. Tests pass a fake; the server uses `fetch`
 * @returns Newest messages first
 */
export async function readSlackChannelHistory(
  token: string,
  channelId: string,
  limit: number = DEFAULT_LIMIT,
  request: typeof fetch = fetch,
): Promise<SlackChannelMessage[]> {
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", channelId);
  url.searchParams.set("limit", clampHistoryLimit(limit).toString());

  const response = await request(url, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  // A transport failure is not a Slack error payload
  if (!response.ok) {
    throw new SlackChannelListError("invalid_response");
  }

  const body = await readHistory(response);

  if (!body.ok) {
    throw new SlackChannelListError(body.error ?? "unknown_error");
  }

  const messages: SlackChannelMessage[] = [];

  for (const message of body.messages ?? []) {
    const readable = toMessage(message);

    if (readable !== undefined) {
      messages.push(readable);
    }
  }

  return messages;
}

/**
 * Keeps the history request inside Slack's page size.
 *
 * @param limit - Requested page size
 * @returns A limit from 1 to 50
 */
function clampHistoryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    return DEFAULT_LIMIT;
  }

  if (limit > MAX_LIMIT) {
    return MAX_LIMIT;
  }

  return limit;
}

/**
 * Parses one `conversations.history` body.
 *
 * @param response - A successful HTTP response whose body should be Slack's JSON
 * @returns The parsed history
 */
async function readHistory(response: Response): Promise<z.infer<typeof SlackHistorySchema>> {
  let body: unknown;

  try {
    body = await response.json();
  } catch (error) {
    throw new SlackChannelListError("invalid_response", { cause: error });
  }

  const parsed = SlackHistorySchema.safeParse(body);

  if (!parsed.success) {
    throw new SlackChannelListError("invalid_response");
  }

  return parsed.data;
}

/**
 * Drops joins and other empty events, and caps the text a chat will see.
 *
 * @param message - One Slack history item
 * @returns The readable message, or undefined when it has no text
 */
function toMessage(message: {
  ts?: string | undefined;
  text?: string | undefined;
  user?: string | undefined;
  bot_id?: string | undefined;
  thread_ts?: string | undefined;
}): SlackChannelMessage | undefined {
  if (message.ts === undefined) {
    return undefined;
  }

  // A forward leaves `text` empty and stores the original message on attachments.
  const trimmed = readSlackMessageText(message).trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  let text = trimmed;

  if (text.length > TEXT_LIMIT) {
    text = `${text.slice(0, TEXT_LIMIT)}...`;
  }

  let author: string | null = null;

  if (message.user !== undefined) {
    author = message.user;
  } else if (message.bot_id !== undefined) {
    author = message.bot_id;
  }

  const threadTs = message.thread_ts ?? null;

  return {
    ts: message.ts,
    author,
    text,
    threadTs,
    isReply: threadTs !== null && threadTs !== message.ts,
  };
}
