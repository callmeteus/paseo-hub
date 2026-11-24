import { describe, expect, it } from "vitest";
import type { OutputExecutionInput } from "../../execution-capabilities/outputs.js";
import type { TelegramBotApi } from "../../providers/telegram/client.js";
import { createTelegramOutputExecutor, telegramAgentTool } from "./reply.js";

function fakeApi(): {
  api: TelegramBotApi;
  sent: Array<Record<string, unknown>>;
  actions: Array<{ chatId: string | number; action: string }>;
} {
  const sent: Array<Record<string, unknown>> = [];
  const actions: Array<{ chatId: string | number; action: string }> = [];
  const api: TelegramBotApi = {
    getMe: async () => ({ id: 1, username: "bot", firstName: "Bot" }),
    setWebhook: async () => undefined,
    deleteWebhook: async () => undefined,
    sendChatAction: async (chatId, action) => {
      actions.push({ chatId, action });
    },
    sendMessage: async (message) => {
      sent.push({
        chatId: message.chatId,
        text: message.text,
        ...(message.replyMarkup === undefined ? {} : { replyMarkup: message.replyMarkup }),
      });
      return { messageId: 1, chatId: -100 };
    },
    answerCallbackQuery: async () => undefined,
    getFile: async () => undefined,
  };
  return { api, sent, actions };
}

function input(args: Record<string, unknown>): OutputExecutionInput {
  return {
    agentExecutionId: "exec-1",
    toolType: "reply",
    args,
    outputContext: { provider: "telegram", chatId: -100, messageId: 1 },
  };
}

describe("telegram outputs", () => {
  it("exposes the reply tool under the name the automation prompts use", () => {
    expect(telegramAgentTool("telegram.reply").name).toBe("telegram_reply");
  });

  it("shows typing without posting a message for the internal typing output", async () => {
    const { api, sent, actions } = fakeApi();
    await createTelegramOutputExecutor(api, "telegram.typing")(input({}));
    expect(actions).toEqual([{ chatId: -100, action: "typing" }]);
    expect(sent).toEqual([]);
  });

  it("sends telegram.reply to the chat", async () => {
    const { api, sent } = fakeApi();
    await createTelegramOutputExecutor(api, "telegram.reply")(input({ content: "oi" }));
    expect(sent[0]).toMatchObject({ chatId: -100, text: "oi" });
  });

  it("renders finish choices as an inline keyboard", async () => {
    const { api, sent } = fakeApi();
    await createTelegramOutputExecutor(
      api,
      "telegram.agent.finish",
    )(input({ session: "suspended", text: "Escolha", choices: [{ label: "Sim", value: "yes" }] }));
    expect(sent[0]?.["replyMarkup"]).toEqual({
      inline_keyboard: [[{ text: "Sim", callback_data: "yes" }]],
    });
  });

  it("omits the keyboard when finish has no choices", async () => {
    const { api, sent } = fakeApi();
    await createTelegramOutputExecutor(
      api,
      "telegram.agent.finish",
    )(input({ session: "closed", text: "Pronto" }));
    expect(sent[0]?.["replyMarkup"]).toBeUndefined();
  });
});
