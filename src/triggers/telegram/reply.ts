import { z } from "zod";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";
import type { TelegramBotApi } from "../../providers/telegram/client.js";
import {
  telegramChoiceArrival,
  telegramChoiceKeyboard,
  TELEGRAM_CHOICE_LIMIT,
  type TelegramChoice,
} from "./feedback.js";

const ReplyArgsSchema = z.object({ content: z.string().min(1) });
const TelegramOutputContextSchema = z.object({
  provider: z.literal("telegram"),
  chatId: z.union([z.string(), z.number()]),
  messageId: z.number().int().optional(),
});

const objectSchema = { type: "object" as const, additionalProperties: false };

export const telegramStageTool: OutputToolDefinition = {
  name: "telegram_stage",
  description:
    "Shows one stage of the work in the Telegram chat. Pass a stable id, a short title, and pending, in_progress, or complete.",
  inputSchema: {
    ...objectSchema,
    properties: {
      id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      status: { type: "string", enum: ["pending", "in_progress", "complete"] },
      details: { type: "string" },
      output: { type: "string" },
    },
    required: ["id", "title", "status"],
  },
};

export const telegramToolTool: OutputToolDefinition = {
  name: "telegram_tool",
  description:
    "Shows one action in the Telegram chat, the way a tool call appears. The title is a sentence a person can read, not a method name.",
  inputSchema: {
    ...objectSchema,
    properties: {
      id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
      status: { type: "string", enum: ["in_progress", "complete", "error"] },
      details: { type: "string" },
      output: { type: "string" },
    },
    required: ["id", "title", "status"],
  },
};

export const telegramSayTool: OutputToolDefinition = {
  name: "telegram_say",
  description: "Appends a line to the Telegram chat for this run.",
  inputSchema: {
    ...objectSchema,
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
  },
};

export const telegramFinishTool: OutputToolDefinition = {
  name: "telegram_finish",
  description:
    "Finishes the Telegram card. Pass session active, suspended, or closed. Pass choices to render an inline keyboard; each choice is a button whose callback data is its value.",
  inputSchema: {
    ...objectSchema,
    properties: {
      session: { type: "string", enum: ["active", "suspended", "closed"] },
      text: { type: "string", minLength: 1 },
      choices: {
        type: "array",
        minItems: 1,
        maxItems: TELEGRAM_CHOICE_LIMIT,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 75 },
            value: { type: "string", minLength: 1, maxLength: 200 },
          },
          required: ["label"],
        },
      },
    },
    required: ["session"],
  },
};

export const telegramPromptsTool: OutputToolDefinition = {
  name: "telegram_prompts",
  description: "Shows up to four suggested prompts in the Telegram chat.",
  inputSchema: {
    ...objectSchema,
    properties: {
      title: { type: "string", minLength: 1 },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            message: { type: "string", minLength: 1 },
          },
          required: ["title", "message"],
        },
      },
    },
    required: ["items"],
  },
};

const ChoiceSchema = z.object({
  label: z.string().min(1).max(75),
  value: z.string().min(1).max(200).optional(),
});
const FinishArgsSchema = z
  .object({
    session: z.enum(["active", "suspended", "closed"]),
    text: z.string().min(1).optional(),
    choices: z.array(ChoiceSchema).min(1).max(TELEGRAM_CHOICE_LIMIT).optional(),
  })
  .strict();

export type TelegramOutputType =
  | "telegram.reply"
  | "telegram.agent.stage"
  | "telegram.agent.tool"
  | "telegram.agent.say"
  | "telegram.agent.finish"
  | "telegram.agent.prompts";

export function telegramAgentTool(type: TelegramOutputType): OutputToolDefinition {
  switch (type) {
    case "telegram.reply":
      return REPLY_TOOL;
    case "telegram.agent.stage":
      return telegramStageTool;
    case "telegram.agent.tool":
      return telegramToolTool;
    case "telegram.agent.say":
      return telegramSayTool;
    case "telegram.agent.finish":
      return telegramFinishTool;
    case "telegram.agent.prompts":
      return telegramPromptsTool;
    default:
      throw new Error(`unknown telegram output: ${String(type)}`);
  }
}

const REPLY_TOOL: OutputToolDefinition = {
  name: "reply",
  description: "Sends a reply to the conversation that triggered this execution.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string", minLength: 1 } },
    required: ["content"],
    additionalProperties: false,
  },
};

/**
 * Creates an executor for a Telegram output.
 *
 * @param api - The bot used to send messages
 * @param type - Which output this executor runs
 * @returns The output executor
 */
export function createTelegramOutputExecutor(
  api: TelegramBotApi,
  type: TelegramOutputType,
): OutputExecutor {
  return async function executeTelegramOutput(input) {
    const context = TelegramOutputContextSchema.parse(input.outputContext);
    // Telegram typing indicator expires after ~5s; refresh it on every agent output.
    await api.sendChatAction(context.chatId, "typing").catch(() => undefined);
    if (type === "telegram.reply") {
      const args = ReplyArgsSchema.parse(input.args);
      await api.sendMessage({ chatId: context.chatId, text: args.content });
      return;
    }
    if (type === "telegram.agent.finish") {
      const args = FinishArgsSchema.parse(input.args);
      const choices: TelegramChoice[] | undefined = args.choices?.map((choice) => ({
        label: choice.label.trim(),
        value: (choice.value ?? choice.label).trim(),
      }));
      const text = args.text ?? (choices === undefined ? "Concluído." : "Escolha uma opção.");
      await api.sendMessage({
        chatId: context.chatId,
        text,
        ...(choices === undefined ? {} : { replyMarkup: telegramChoiceKeyboard(choices) }),
      });
      return;
    }
    if (type === "telegram.agent.say") {
      const args = z.object({ text: z.string().min(1) }).parse(input.args);
      await api.sendMessage({ chatId: context.chatId, text: args.text });
      return;
    }
    // stage / tool / prompts are rendered as a plain line for this lean surface.
    const line = readStatusLine(type, input.args);
    if (line !== undefined) await api.sendMessage({ chatId: context.chatId, text: line });
  };
}

function readStatusLine(type: TelegramOutputType, args: unknown): string | undefined {
  if (type === "telegram.agent.prompts") return undefined;
  if (typeof args !== "object" || args === null) return undefined;
  const fields: Record<string, unknown> = { ...args };
  const title = fields["title"];
  const status = fields["status"];
  if (typeof title !== "string") return undefined;
  return status === undefined ? title : `${title} — ${JSON.stringify(status)}`;
}

export { telegramChoiceArrival };
