import { reportFailure } from "../../failures/index.js";
import type { TelegramBotApi, TelegramMessageInput } from "../../providers/telegram/client.js";

/**
 * Converts the lightweight markdown agents write into Telegram HTML.
 *
 * HTML is used instead of MarkdownV2 because version strings such as
 * `6.12.117-1` contain characters MarkdownV2 requires escaping. Everything the
 * model did not mark up is escaped, so a stray `<` cannot inject markup.
 */
export function toTelegramHtml(text: string): string {
  const tokens: string[] = [];
  const keep = (html: string) => {
    tokens.push(html);
    return `\uE000${String(tokens.length - 1)}\uE000`;
  };

  let out = text.replace(/```([\s\S]*?)```/gu, (_match, code: string) =>
    keep(`<pre>${escapeHtml(code.replace(/^\n/u, "").replace(/\n$/u, ""))}</pre>`),
  );
  out = out.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
    keep(`<code>${escapeHtml(code)}</code>`),
  );
  // Links before emphasis: the label may itself use markdown.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, (_match, label: string, url: string) =>
    keep(`<a href="${escapeAttribute(url)}">${toTelegramHtml(label)}</a>`),
  );
  out = out.replace(/([\p{L}\p{N}./-]+)\s+\((https?:\/\/[^\s)]+)\)/gu, (_match, label: string, url: string) =>
    keep(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`),
  );

  out = escapeHtml(out);
  out = out.replace(/\*\*([^*\n]+)\*\*/gu, "<b>$1</b>");
  out = out.replace(/\*([^*\n]+)\*/gu, "<b>$1</b>");
  out = out.replace(/_([^_\n]+)_/gu, "<i>$1</i>");

  return out.replace(/\uE000(\d+)\uE000/gu, (_match, index: string) => tokens[Number(index)] ?? "");
}

/** Sends formatted text; a parser refusal falls back to plain text, never losing the message. */
export async function sendTelegramText(
  api: TelegramBotApi,
  input: Omit<TelegramMessageInput, "parseMode">,
): Promise<void> {
  const html = toTelegramHtml(input.text);
  try {
    await api.sendMessage({ ...input, text: html, parseMode: "HTML" });
  } catch (error) {
    if (!isParseFailure(error)) throw error;
    reportFailure(error, {
      operation: "telegram.text.parse",
      component: "triggers",
      provider: "telegram",
    });
    await api.sendMessage(input);
  }
}

/** Same fallback as sendTelegramText, for a card that is being edited. */
export async function editTelegramText(
  api: TelegramBotApi,
  input: Parameters<TelegramBotApi["editMessageText"]>[0],
): Promise<void> {
  const html = toTelegramHtml(input.text);
  try {
    await api.editMessageText({ ...input, text: html, parseMode: "HTML" });
  } catch (error) {
    if (!isParseFailure(error)) throw error;
    reportFailure(error, {
      operation: "telegram.edit.parse",
      component: "triggers",
      provider: "telegram",
    });
    await api.editMessageText(input);
  }
}

function isParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /can't parse entities|parse entities|entity/u.test(error.message);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
