import type { ProviderEventAcceptance } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { TelegramBotApi } from "../../providers/telegram/client.js";
import {
  NormalizedTelegramMessageEventSchema,
  TelegramUpdateSchema,
  type NormalizedTelegramMessageEvent,
  type TelegramAttachment,
  type TelegramMessage,
} from "./events.js";
import { telegramChoiceArrival } from "./feedback.js";

const MAX_BODY_BYTES = 1_048_576;

export interface TelegramAcceptInput {
  chatId: string;
  deliveryId: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
  dropReason?: ProviderEventDropReasonCode;
}

export interface CreateTelegramSourceOptions {
  botUsername: string;
  secretToken?: string;
  webhookUrl?: string;
  api: TelegramBotApi;
  accept(input: TelegramAcceptInput): Promise<ProviderEventAcceptance>;
  /** Chooses the label for a callback value, from the choices the last finish offered. */
  choiceLabel?(value: string): string | undefined;
}

export interface TelegramSource extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

/**
 * A Telegram webhook intake. The bot token is not accepted as a query parameter: the webhook
 * is protected by Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
 */
export function createTelegramSource(options: CreateTelegramSourceOptions): TelegramSource {
  const handlers = new Set<TriggerHandler>();
  return {
    async start(handler) {
      handlers.add(handler);
      if (options.webhookUrl !== undefined) {
        await options.api.setWebhook(options.webhookUrl, options.secretToken);
      }
    },
    async stop() {
      handlers.clear();
    },
    async handle(request) {
      return handleUpdate(request, handlers, options);
    },
  };
}

/** The path the Hub must route Telegram updates to. */
export const TELEGRAM_WEBHOOK_PATH = "/api/integrations/telegram/events";

export function telegramWebhookUrl(baseUrl: string): string {
  return new URL(TELEGRAM_WEBHOOK_PATH, baseUrl).toString();
}

async function handleUpdate(
  request: Request,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<Response> {
  if (
    options.secretToken !== undefined &&
    request.headers.get("x-telegram-bot-api-secret-token") !== options.secretToken
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return Response.json({ error: "invalid update" }, { status: 400 });
  }
  const parsed = TelegramUpdateSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "invalid update" }, { status: 400 });

  const update = parsed.data;
  // A callback query is the click of an inline-keyboard button. Turn it into a normal message
  // so the next run sees the same arrival sentence Slack uses for a choice.
  if (update.callback_query !== undefined) {
    const callback = update.callback_query;
    if (callback.data !== undefined) {
      const label = options.choiceLabel?.(callback.data) ?? callback.data;
      const arrival = telegramChoiceArrival({ label, value: callback.data });
      await options.api.answerCallbackQuery(callback.id);
      await dispatch(
        {
          type: "message",
          id: `callback-${callback.id}`,
          chatId: String(callback.message?.chat.id ?? callback.from.id),
          chatType: callback.message?.chat.type ?? "private",
          messageId: callback.message?.message_id ?? 0,
          content: arrival,
          author: {
            id: String(callback.from.id),
            username: callback.from.username,
            firstName: callback.from.first_name,
            isBot: callback.from.is_bot ?? false,
          },
          mentionedBot: false,
          createdAt: new Date().toISOString(),
          attachments: [],
        },
        handlers,
        options,
      );
    }
    return new Response("OK", { status: 200 });
  }

  const message = update.message ?? update.edited_message;
  if (message !== undefined) {
    const normalized = normalizeMessage(message, options.botUsername);
    if (normalized !== undefined) await dispatch(normalized, handlers, options);
  }
  return new Response("OK", { status: 200 });
}

async function dispatch(
  event: NormalizedTelegramMessageEvent,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  const deliveryId = `telegram-${event.chatId}-${event.messageId}-${event.id}`;
  let acceptance: ProviderEventAcceptance;
  try {
    acceptance = await options.accept({
      chatId: event.chatId,
      source: `telegram.${event.type}`,
      deliveryId,
      payload: event,
      receivedAt: new Date(event.createdAt),
      ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" as const } : {}),
    });
  } catch (error) {
    reportFailure(error, {
      operation: "telegram.source.accept",
      component: "triggers",
      provider: "telegram",
    });
    return;
  }
  logProviderEventIntake({
    provider: "telegram",
    source: `telegram.${event.type}`,
    deliveryId,
    resourceId: event.chatId,
    acceptance,
  });
  if (acceptance.status !== "accepted") return;
  for (const accepted of acceptance.events) {
    for (const handler of handlers) await handler(accepted);
  }
}

/** Converts a raw Telegram message into a normalized event. */
export function normalizeMessage(
  message: TelegramMessage,
  botUsername: string,
): NormalizedTelegramMessageEvent | undefined {
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = botUsername.replace(/^@/u, "").toLowerCase();
  // A group message can mention another bot. Only a mention of this Hub's bot
  // opens a run; otherwise Kevin answers when someone calls FOLFABOT.
  const mentionedBot =
    text.toLowerCase().includes(`@${handle}`) ||
    entities.some((entity) => {
      if (entity.type === "text_mention") return true;
      if (entity.type !== "mention") return false;
      const mentioned = entity.text ?? text.slice(entity.offset, entity.offset + entity.length);
      return mentioned.toLowerCase().replace(/^@/u, "") === handle;
    });
  const type: "message" | "mention" =
    message.chat.type !== "private" && mentionedBot ? "mention" : "message";
  return NormalizedTelegramMessageEventSchema.parse({
    type,
    id: `${message.chat.id}:${message.message_id}`,
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    messageId: message.message_id,
    content: text,
    author: {
      id: String(message.from?.id ?? message.chat.id),
      username: message.from?.username,
      firstName: message.from?.first_name ?? message.chat.title ?? "Telegram",
      isBot: message.from?.is_bot ?? false,
    },
    mentionedBot,
    createdAt: new Date(message.date * 1000).toISOString(),
    attachments: normalizeAttachments(message),
  });
}

function normalizeAttachments(message: TelegramMessage): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];
  if (message.photo !== undefined && message.photo.length > 0) {
    const largest = message.photo.at(-1)!;
    attachments.push({
      fileId: largest.file_id,
      filename: `photo-${largest.file_id}.jpg`,
      contentType: "image/jpeg",
      size: 0,
    });
  }
  for (const item of [message.document, message.video]) {
    if (item === undefined) continue;
    attachments.push({
      fileId: item.file_id,
      filename: item.file_name ?? item.file_id,
      contentType: item.mime_type ?? null,
      size: item.file_size ?? 0,
    });
  }
  return attachments;
}
