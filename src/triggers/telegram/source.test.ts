import { describe, expect, it } from "vitest";
import { normalizeMessage } from "./source.js";
import type { TelegramMessage } from "./events.js";

function message(text: string, entities: TelegramMessage["entities"]): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -1001, type: "group" },
    date: 1_700_000_000,
    text,
    entities,
  };
}

describe("Telegram mention normalization", () => {
  it("marks a mention of this bot", () => {
    const event = normalizeMessage(
      message("@kevin_bot oi", [{ type: "mention", offset: 0, length: 10, text: "@kevin_bot" }]),
      "kevin_bot",
    );
    expect(event?.mentionedBot).toBe(true);
    expect(event?.type).toBe("mention");
  });

  it("reports any @mention by default; the strict filter is opt-in per trigger", () => {
    const event = normalizeMessage(
      message("@folfa_bot me lembra", [
        { type: "mention", offset: 0, length: 10, text: "@folfa_bot" },
      ]),
      "kevin_bot",
    );
    expect(event?.mentionedBot).toBe(true);
    expect(event?.type).toBe("mention");
  });

  it("marks a text_mention", () => {
    const event = normalizeMessage(
      message("oi", [{ type: "text_mention", offset: 0, length: 2 }]),
      "kevin_bot",
    );
    expect(event?.mentionedBot).toBe(true);
  });

  it("keeps the replied-to message link when the reply text is only @e7kevinbot", () => {
    const link = "https://x.com/tldrcve/status/2125131518389657720";
    const update = {
      message_id: 347,
      chat: { id: -5160361212, type: "supergroup" as const },
      date: 1_764_077_030,
      text: "@e7kevinbot",
      entities: [{ type: "mention", offset: 0, length: 12 }],
      reply_to_message: {
        message_id: 346,
        chat: { id: -5160361212, type: "supergroup" as const },
        date: 1_764_077_000,
        from: { id: 123, is_bot: true, first_name: "tl;dr CVE" },
        text: link,
        entities: [{ type: "url", offset: 0, length: link.length }],
      },
    };
    const event = normalizeMessage(update, "e7kevinbot");
    expect(event?.content).toBe("@e7kevinbot");
    expect(event?.replyTo?.content).toContain(link);
  });
});
