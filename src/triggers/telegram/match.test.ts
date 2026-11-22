import { describe, expect, it } from "vitest";
import type { NormalizedTelegramMessageEvent } from "./events.js";
import { matchTelegramTriggers, readTelegramPromptBody } from "./match.js";
import { createTelegramTriggerProvider } from "./provider.js";

function event(
  overrides: Partial<NormalizedTelegramMessageEvent> = {},
): NormalizedTelegramMessageEvent {
  return {
    type: "mention",
    id: "chat:1",
    chatId: "-1001",
    chatType: "group",
    messageId: 1,
    content: "@kevin_bot oi",
    author: { id: "99", username: "gio", firstName: "Gio", isBot: false },
    mentionedBot: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

const triggers = [
  { name: "mention", on: "telegram.mention", filters: { from_users: ["*"] } },
  { name: "messages", on: "telegram.message", filters: { from_users: ["*"] } },
] as const;

describe("telegram materialized context", () => {
  it("exposes the trigger message author so the agent can resolve the SRE identity", async () => {
    const provider = createTelegramTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("not used");
      },
      botUsername: "kevin_bot",
    });
    const context = await provider.materializeContext!({
      executionId: "execution",
      organizationId: "org",
      projectId: "project",
      providerEventReceiptId: "receipt",
      triggerContext: {
        provider: "telegram",
        organizationId: "org",
        target: { provider: "telegram", chatId: "-1001", messageId: 1 },
        event: {
          telegram: {
            event_type: "mention",
            connection_id: null,
            chat: { id: "-1001", type: "group" },
            trigger_message: {
              id: "chat:1",
              text: "@kevin_bot oi",
              body: "oi",
              author: { id: "99", username: "gio", first_name: "Gio", is_bot: false },
              created_at: "2026-01-01T00:00:00.000Z",
              chat: { id: "-1001" },
            },
            trigger_thread_context: { status: "not_applicable" },
          },
        },
      },
    });
    expect(context.telegram.trigger_message.author.id).toBe("99");
  });
});

describe("matchTelegramTriggers", () => {
  it("matches a group mention for telegram.mention", () => {
    const result = matchTelegramTriggers({ triggers: [...triggers] }, event(), "kevin_bot");
    expect(result.map((match) => match.trigger.name)).toEqual(["mention"]);
  });

  it("treats groups: ['*'] as any group", () => {
    const anyGroup = [
      { name: "mention", on: "telegram.mention", filters: { from_users: ["*"], groups: ["*"] } },
    ];
    expect(
      matchTelegramTriggers({ triggers: anyGroup }, event({ chatId: "-5160361212" }), "kevin_bot"),
    ).toHaveLength(1);
  });
  it("does not match a plain group message to telegram.mention", () => {
    const plain = event({ type: "message", mentionedBot: false, content: "só um recado" });
    const result = matchTelegramTriggers({ triggers: [...triggers] }, plain, "kevin_bot");
    expect(result.map((match) => match.trigger.name)).toEqual(["messages"]);
  });

  it("matches a private message only when direct_messages is on", () => {
    const dm = event({ chatType: "private", chatId: "55", type: "message", mentionedBot: false });
    const withDm = [
      { name: "dm", on: "telegram.message", filters: { from_users: ["*"], direct_messages: true } },
    ];
    expect(matchTelegramTriggers({ triggers: withDm }, dm, "kevin_bot")).toHaveLength(1);
    expect(matchTelegramTriggers({ triggers: [...triggers] }, dm, "kevin_bot")).toHaveLength(0);
  });

  it("honours the groups allowlist", () => {
    const filtered = [
      { name: "g", on: "telegram.mention", filters: { from_users: ["*"], groups: ["-1001"] } },
    ];
    expect(matchTelegramTriggers({ triggers: filtered }, event(), "kevin_bot")).toHaveLength(1);
    const other = event({ chatId: "-9999" });
    expect(matchTelegramTriggers({ triggers: filtered }, other, "kevin_bot")).toHaveLength(0);
  });

  it("ignores messages from other bots unless include_bots is set", () => {
    const fromBot = event({ author: { id: "7", firstName: "Other", isBot: true } });
    expect(matchTelegramTriggers({ triggers: [...triggers] }, fromBot, "kevin_bot")).toHaveLength(
      0,
    );
    const allowed = [
      { name: "m", on: "telegram.mention", filters: { from_users: ["*"], include_bots: true } },
    ];
    expect(matchTelegramTriggers({ triggers: allowed }, fromBot, "kevin_bot")).toHaveLength(1);
  });

  it("ignores its own messages", () => {
    const own = event({ author: { id: "kevin_bot", firstName: "Kevin", isBot: true } });
    expect(matchTelegramTriggers({ triggers: [...triggers] }, own, "kevin_bot")).toHaveLength(0);
  });

  it("reads the prompt body without the mention token", () => {
    expect(readTelegramPromptBody(event(), "kevin_bot")).toBe("oi");
  });
});
