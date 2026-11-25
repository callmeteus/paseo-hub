import { describe, expect, it } from "vitest";
import type { TelegramBotApi } from "../../providers/telegram/client.js";
import { settleTelegramChoice } from "./feedback.js";

function apiWithEdits(): {
  api: TelegramBotApi;
  edits: Record<string, unknown>[];
  acks: string[];
} {
  const edits: Record<string, unknown>[] = [];
  const acks: string[] = [];
  const base = {
    getMe: async () => ({ id: 1, username: "e7kevinbot", firstName: "Kevin" }),
    setWebhook: async () => undefined,
    deleteWebhook: async () => undefined,
    sendMessage: async () => ({ messageId: 1, chatId: -100 }),
    sendChatAction: async () => undefined,
    answerCallbackQuery: async (id: string) => {
      acks.push(id);
    },
    getFile: async () => undefined,
  };
  const api: TelegramBotApi = Object.assign({}, base, {
    editMessageText: async (input: Parameters<TelegramBotApi["editMessageText"]>[0]) => {
      edits.push({
        chatId: input.chatId,
        messageId: input.messageId,
        text: input.text,
        replyMarkup: input.replyMarkup,
      });
    },
  });
  return { api, edits, acks };
}

describe("telegram button settlement", () => {
  it("replaces the keyboard with the translated chooser line", async () => {
    const { api, edits } = apiWithEdits();
    await settleTelegramChoice(api, {
      chatId: -5160361212,
      messageId: 990130,
      text: "CVE-2026-99288 afeta 250 instâncias.",
      label: "Ver plano completo",
      user: "@giofoli",
      locale: "pt-BR",
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      chatId: -5160361212,
      messageId: 990130,
      text: "CVE-2026-99288 afeta 250 instâncias.\n\n@giofoli escolheu \"Ver plano completo\"",
      replyMarkup: { inline_keyboard: [] },
    });
  });

  it("uses the English catalog when the trigger has no locale", async () => {
    const { api, edits } = apiWithEdits();
    await settleTelegramChoice(api, {
      chatId: -1,
      messageId: 1,
      text: "Original",
      label: "Close",
      user: "Gio",
      locale: undefined,
    });
    expect(edits[0]?.["text"]).toBe('Original\n\nGio chose "Close"');
  });
});
