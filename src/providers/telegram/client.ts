import { z } from "zod";

const TELEGRAM_API_BASE = "https://api.telegram.org";

const TelegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    username: z.string().optional(),
  })
  .passthrough();

export interface TelegramBotIdentity {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramMessageInput {
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
  parseMode?: "HTML" | "MarkdownV2" | "Markdown";
  replyMarkup?: ReplyMarkup;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface ReplyMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramMessageResult {
  messageId: number;
  chatId: number;
}

/** A Telegram Bot API client. All calls use the bot token issued by BotFather. */
export interface TelegramBotApi {
  getMe(): Promise<TelegramBotIdentity>;
  setWebhook(url: string, secretToken?: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  sendMessage(input: TelegramMessageInput): Promise<TelegramMessageResult>;
  editMessageText(input: {
    chatId: string | number;
    messageId: number;
    text: string;
    parseMode?: "HTML" | "MarkdownV2" | "Markdown";
    replyMarkup?: ReplyMarkup;
  }): Promise<void>;
  sendChatAction(chatId: string | number, action: "typing"): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<string | undefined>;
}

const EnvelopeSchema = z
  .object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional() })
  .passthrough();
const SendResultSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int() }),
});
const FileResultSchema = z.object({ file_path: z.string().optional() });

export interface CreateTelegramBotApiOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/**
 * Builds a Telegram Bot API client around Node fetch.
 *
 * @param options - Bot token and optional fetch injection for tests
 * @returns The client used by the provider and its triggers
 */
export function createTelegramBotApi(options: CreateTelegramBotApiOptions): TelegramBotApi {
  const request = options.fetch ?? fetch;
  const base = options.baseUrl ?? TELEGRAM_API_BASE;

  async function post<T>(
    method: string,
    body: Record<string, unknown>,
    resultSchema: z.ZodType<T>,
  ): Promise<T> {
    const url = `${base}/bot${options.token}/${method}`;
    let response: Response;
    try {
      response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`telegram ${method} request failed`, { cause: error });
    }
    const envelope = EnvelopeSchema.parse(await response.json());
    if (!response.ok || !envelope.ok) {
      throw new Error(`telegram ${method} failed: ${envelope.description ?? response.status}`);
    }
    return resultSchema.parse(envelope.result);
  }

  return {
    async getMe() {
      const result = await post("getMe", {}, TelegramUserSchema);
      return {
        id: result.id,
        username: result.username ?? `bot${result.id}`,
        firstName: result.first_name,
      };
    },
    async setWebhook(url, secretToken) {
      await post(
        "setWebhook",
        {
          url,
          ...(secretToken === undefined ? {} : { secret_token: secretToken }),
          allowed_updates: ["message", "callback_query"],
        },
        z.unknown(),
      );
    },
    async deleteWebhook() {
      await post("deleteWebhook", {}, z.unknown());
    },
    async sendMessage(input) {
      const result = await post(
        "sendMessage",
        {
          chat_id: input.chatId,
          text: input.text,
          ...(input.replyToMessageId === undefined
            ? {}
            : { reply_to_message_id: input.replyToMessageId }),
          ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
          ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup }),
        },
        SendResultSchema,
      );
      return { messageId: result.message_id, chatId: result.chat.id };
    },
    async editMessageText(input) {
      await post(
        "editMessageText",
        {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: input.text,
          ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
          ...(input.replyMarkup === undefined ? {} : { reply_markup: input.replyMarkup }),
        },
        z.unknown(),
      );
    },
    async sendChatAction(chatId, action) {
      await post("sendChatAction", { chat_id: chatId, action }, z.unknown());
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await post(
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
          ...(text === undefined ? {} : { text }),
        },
        z.unknown(),
      );
    },
    async getFile(fileId) {
      try {
        const result = await post("getFile", { file_id: fileId }, FileResultSchema);
        return result.file_path === undefined
          ? undefined
          : `${base}/file/bot${options.token}/${result.file_path}`;
      } catch {
        return undefined;
      }
    },
  };
}
