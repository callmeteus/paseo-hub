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

  it("does not mark a mention of another bot", () => {
    const event = normalizeMessage(
      message("@folfa_bot me lembra", [
        { type: "mention", offset: 0, length: 10, text: "@folfa_bot" },
      ]),
      "kevin_bot",
    );
    expect(event?.mentionedBot).toBe(false);
    expect(event?.type).toBe("message");
  });

  it("falls back to the message text when the entity has no text", () => {
    const event = normalizeMessage(
      message("@kevin_bot oi", [{ type: "mention", offset: 0, length: 10 }]),
      "kevin_bot",
    );
    expect(event?.mentionedBot).toBe(true);
  });
});
