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
  type TelegramUpdate,
} from "./events.js";
import { localeFromLanguageCode } from "../../i18n/messages.js";
import {
  settleTelegramChoice,
  telegramChoiceArrival,
  telegramChoiceLabelFromMarkup,
} from "./feedback.js";

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
  /** Read at message time: getMe resolves asynchronously after the source starts. */
  getBotUsername(): string;
  secretToken?: string;
  webhookUrl?: string;
  api: TelegramBotApi;
  accept(input: TelegramAcceptInput): Promise<ProviderEventAcceptance>;
  /** Chooses the label for a callback value, from the choices the last finish offered. */
  choiceLabel?(value: string): string | undefined;
  /** Locale of the run that offered the buttons, read from its stored receipt. */
  localeFor?(receiptId: string): Promise<string | undefined>;
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
    await handleTelegramCallback(update.callback_query, handlers, options);
    return new Response("OK", { status: 200 });
  }

  const message = update.message ?? update.edited_message;
  if (message !== undefined) {
    const normalized = normalizeMessage(message, options.getBotUsername());
    if (normalized !== undefined) await dispatch(normalized, handlers, options);
  }
  return new Response("OK", { status: 200 });
}

/** One button tap: acknowledge, enqueue the choice, then settle the card. */
async function handleTelegramCallback(
  callback: NonNullable<TelegramUpdate["callback_query"]>,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  if (callback.data === undefined) return;
  const choiceLabel = telegramChoiceLabelFromMarkup(
    callback.message?.reply_markup,
    callback.data,
  );
  const arrival = telegramChoiceArrival({ label: choiceLabel, value: callback.data });
  // Acknowledging the tap is cosmetic. A stale or replayed callback id must not
  // stop the choice from reaching the agent, but a real failure goes to the log.
  await options.api.answerCallbackQuery(callback.id).catch((error: unknown) => {
    reportCodeFailure(error, "telegram.callback_ack", `callback ${callback.id}`);
  });
  const receiptId = await dispatch(
    {
      type: "message",
      // Keyed by the card and the choice, never by the tap id: a repeated or
      // delayed tap on the same card must reuse the same durable receipt.
      id: `callback-${callback.message?.message_id ?? 0}-${callback.data}`,
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
  if (receiptId === undefined) return;
  await settleCallbackCard(callback, choiceLabel, receiptId, options);
}

async function settleCallbackCard(
  callback: NonNullable<TelegramUpdate["callback_query"]>,
  choiceLabel: string,
  receiptId: string,
  options: CreateTelegramSourceOptions,
): Promise<void> {
  // Trigger locale first, then the language the clicker set on their client.
  const configured = await options.localeFor?.(receiptId).catch(() => undefined);
  const locale = configured ?? localeFromLanguageCode(callback.from.language_code);
  const user =
    callback.from.username === undefined ? callback.from.first_name : `@${callback.from.username}`;
  try {
    await settleTelegramChoice(options.api, {
      chatId: String(callback.message?.chat.id ?? callback.from.id),
      messageId: callback.message?.message_id ?? 0,
      text: callback.message?.text ?? choiceLabel,
      label: choiceLabel,
      user,
      locale,
    });
  } catch (error) {
    reportCodeFailure(error, "telegram.choice_edit", "card edit");
  }
}

function reportCodeFailure(error: unknown, operation: string, detail: string): void {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  reportFailure(new Error(`${operation} failed for ${detail}: ${code ?? "unknown"}`, { cause: error }), {
    operation,
    component: "triggers",
    provider: "telegram",
  });
}

async function dispatch(
  event: NormalizedTelegramMessageEvent,
  handlers: Set<TriggerHandler>,
  options: CreateTelegramSourceOptions,
): Promise<string | undefined> {
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
    return undefined;
  }
  logProviderEventIntake({
    provider: "telegram",
    source: `telegram.${event.type}`,
    deliveryId,
    resourceId: event.chatId,
    acceptance,
  });
  if (acceptance.status !== "accepted") return undefined;
  for (const accepted of acceptance.events) {
    for (const handler of handlers) await handler(accepted);
  }
  return acceptance.receiptId;
}

/** Converts a raw Telegram message into a normalized event. */
export function normalizeMessage(
  message: TelegramMessage,
  botUsername: string,
): NormalizedTelegramMessageEvent | undefined {
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  // A group message can mention any bot. Whether only a mention of this Hub's
  // bot opens a run is decided per trigger by `self_mention_only`.
  const mentionedBot =
    text.toLowerCase().includes(`@${botUsername.replace(/^@/u, "").toLowerCase()}`) ||
    entities.some((entity) => entity.type === "mention" || entity.type === "text_mention");
  const type: "message" | "mention" =
    message.chat.type !== "private" && mentionedBot ? "mention" : "message";
  const repliedContent = readRepliedContent(message);
  const replyTo =
    message.reply_to_message === undefined || repliedContent === undefined
      ? undefined
      : {
          messageId: message.reply_to_message.message_id,
          content: repliedContent,
          ...(message.reply_to_message.from === undefined
            ? {}
            : { author: message.reply_to_message.from }),
        };
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
    ...(replyTo === undefined ? {} : { replyTo }),
    createdAt: new Date(message.date * 1000).toISOString(),
    attachments: normalizeAttachments(message),
  });
}

/** Text and links of the message this update replied to, for the agent's prompt. */
function readRepliedContent(message: TelegramMessage): string | undefined {
  const replied = message.reply_to_message;
  if (replied === undefined) return undefined;
  const text = replied.text ?? replied.caption ?? "";
  const urls = (replied.entities ?? replied.caption_entities ?? [])
    .filter((entity) => entity.type === "url" || entity.type === "text_link")
    // text_link carries the address in `url`, not in `text`.
    .map((entity) =>
      entity.type === "text_link" ? (entity.url ?? "") : (entity.text ?? sliceEntity(text, entity)),
    )
    .filter((url) => url.length > 0 && !text.includes(url));
  const content = [text, ...urls].filter((part) => part.length > 0).join("\n");
  return content.length > 0 ? content : undefined;
}

function sliceEntity(text: string, entity: { offset: number; length: number }): string {
  return text.slice(entity.offset, entity.offset + entity.length);
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
