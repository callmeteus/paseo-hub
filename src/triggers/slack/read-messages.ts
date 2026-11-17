import { z } from "zod";
import { resolveSlackChannel, type SlackChannelChoice } from "../../providers/slack/channels.js";
import type { SlackChannelMessage } from "../../providers/slack/history.js";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";

const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 50;
/** Each line is read by the model, so one long message never takes the whole result. */
const MESSAGE_TEXT_LIMIT = 500;

const ReadSlackMessagesArgsSchema = z
  .object({
    channel: z.string().trim().min(1),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
  })
  .strict();

const SlackReadOutputContextSchema = z.object({
  provider: z.literal("slack"),
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
});

/**
 * Reads the channels the bot belongs to and one page of history from one of them.
 *
 * The live adapter resolves the workspace's own bot token. Tests pass a double.
 */
export interface SlackMessageReader {
  listChannels(input: {
    organizationId: string;
    teamId: string;
  }): Promise<readonly SlackChannelChoice[]>;
  readHistory(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    limit: number;
  }): Promise<readonly SlackChannelMessage[]>;
}

/**
 * Tool the Slack agent calls to read what a channel already said.
 *
 * Nothing is posted. The channel may be a name or an id, and the bot only reads
 * channels it belongs to, so this adds no scope and reaches no conversation the
 * workspace never invited the bot into.
 */
export const readSlackMessagesTool: OutputToolDefinition = {
  name: "read_slack_messages",
  description:
    "Reads recent messages from a Slack channel the bot belongs to. Pass the channel name, with or without #, or its id. Returns one line per message, oldest first, as [ts] author: text. This does not post anything and does not require this run to have started in that channel.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        minLength: 1,
        description:
          "Channel name, such as tecnologia-triagem or #tecnologia-triagem, or a channel id.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_READ_LIMIT,
        description: "How many messages to read. Defaults to 20.",
      },
    },
    required: ["channel"],
    additionalProperties: false,
  },
};

/**
 * A Slack read the model can recover from. The capability server returns the
 * message as the tool failure, and the run keeps going so the model can still
 * call `reply`.
 */
export class SlackReadMessagesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackReadMessagesError";
  }
}

/**
 * Reads one channel and returns the text the model reads.
 *
 * @param options - Reader bound to the workspace the execution belongs to
 * @returns Executor for the `slack.read_messages` output
 */
export function createSlackReadMessagesExecutor(options: {
  reader: SlackMessageReader;
}): OutputExecutor {
  return async function executeSlackReadMessages(input) {
    const args = ReadSlackMessagesArgsSchema.parse(input.args);
    const context = SlackReadOutputContextSchema.parse(input.outputContext);
    const workspace = { organizationId: context.organizationId, teamId: context.teamId };
    const channels = await options.reader.listChannels(workspace);
    const resolved = resolveSlackChannel(channels, args.channel);

    if (resolved.status === "missing") {
      throw new SlackReadMessagesError(
        `Não encontrei o canal ${args.channel}. O bot só lê canais em que ele está, e o nome precisa ser exato.`,
      );
    }

    if (resolved.status === "ambiguous") {
      const names = resolved.channels
        .slice(0, 5)
        .map((channel) => channel.name)
        .join(", ");
      throw new SlackReadMessagesError(
        `Mais de um canal combina com ${args.channel}. Passe o id do canal. Opções: ${names}.`,
      );
    }

    const messages = await options.reader.readHistory({
      ...workspace,
      channelId: resolved.channel.id,
      limit: args.limit ?? DEFAULT_READ_LIMIT,
    });

    return formatSlackMessages(resolved.channel.name, messages);
  };
}

/**
 * The block the model reads: a header, then one line per message, oldest first.
 *
 * @param channelName - Channel the messages came from
 * @param messages - Recent messages, newest first as Slack returns them
 * @returns One block of text
 */
export function formatSlackMessages(
  channelName: string,
  messages: readonly SlackChannelMessage[],
): string {
  const header =
    messages.length === 0
      ? `#${channelName}: sem mensagens.`
      : `#${channelName}: ${String(messages.length)} mensagens.`;
  const lines = [header];

  for (const message of messages.toReversed()) {
    lines.push(`[${message.ts}] ${message.author ?? "desconhecido"}: ${truncate(message.text)}`);
  }

  return lines.join("\n");
}

/**
 * @param text - Message text, already trimmed
 * @returns The text, capped so one message cannot crowd out the rest
 */
function truncate(text: string): string {
  return text.length > MESSAGE_TEXT_LIMIT ? `${text.slice(0, MESSAGE_TEXT_LIMIT)}...` : text;
}
