import { describe, expect, it } from "vitest";
import { createTelegramBotApi } from "./client.js";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    return Response.json(handler(url, init));
  };
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") return {};
  const parsed: unknown = JSON.parse(raw);
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

describe("telegram bot api", () => {
  it("reads the bot identity from getMe", async () => {
    const api = createTelegramBotApi({
      token: "token",
      fetch: fakeFetch(() => ({
        ok: true,
        result: { id: 42, is_bot: true, first_name: "Kevin", username: "kevin_bot" },
      })),
    });
    expect(await api.getMe()).toEqual({ id: 42, username: "kevin_bot", firstName: "Kevin" });
  });

  it("registers a webhook with allowed updates", async () => {
    let body: Record<string, unknown> = {};
    const api = createTelegramBotApi({
      token: "token",
      fetch: fakeFetch((_url, init) => {
        body = readBody(init);
        return { ok: true, result: true };
      }),
    });
    await api.setWebhook("https://hub.example/api/integrations/telegram/events", "secret");
    expect(body["url"]).toBe("https://hub.example/api/integrations/telegram/events");
    expect(body["secret_token"]).toBe("secret");
    expect(body["allowed_updates"]).toEqual(["message", "callback_query"]);
  });

  it("sends a message with an inline keyboard", async () => {
    let body: Record<string, unknown> = {};
    const api = createTelegramBotApi({
      token: "token",
      fetch: fakeFetch((_url, init) => {
        body = readBody(init);
        return { ok: true, result: { message_id: 7, chat: { id: -100 } } };
      }),
    });
    const result = await api.sendMessage({
      chatId: -100,
      text: "Escolha",
      replyMarkup: {
        inline_keyboard: [[{ text: "Sim", callback_data: "yes" }]],
      },
    });
    expect(result).toEqual({ messageId: 7, chatId: -100 });
    expect(body["reply_markup"]).toEqual({
      inline_keyboard: [[{ text: "Sim", callback_data: "yes" }]],
    });
  });

  it("throws when telegram reports an error", async () => {
    const api = createTelegramBotApi({
      token: "token",
      fetch: fakeFetch(() => ({ ok: false, description: "Bad Request: chat not found" })),
    });
    await expect(api.sendMessage({ chatId: 1, text: "oi" })).rejects.toThrow(/chat not found/u);
  });
});
