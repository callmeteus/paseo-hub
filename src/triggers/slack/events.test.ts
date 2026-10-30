import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { normalizeSlackEvent } from "./events.js";

const envelope = {
  type: "event_callback" as const,
  team_id: "T1",
  api_app_id: "A1",
  event_id: "Ev1",
  event_time: 1_700_000_001,
};

describe("normalizeSlackEvent", () => {
  it("keeps a channel message that does not mention the bot", () => {
    const event = normalizeSlackEvent({
      ...envelope,
      event: {
        type: "message",
        user: "U1",
        channel: "C1",
        text: "hello channel",
        ts: "1700000000.000001",
        event_ts: "1700000000.000001",
        channel_type: "channel",
      },
    });

    assert.equal(event?.type, "message");
    assert.equal(event?.content, "hello channel");
    assert.equal(event?.channelId, "C1");
  });

  it("drops bot messages, subtypes, and thread replies", () => {
    const base = {
      type: "message",
      user: "U1",
      channel: "C1",
      text: "hello",
      ts: "1700000000.000002",
      event_ts: "1700000000.000002",
      channel_type: "channel",
    };

    assert.equal(normalizeSlackEvent({ ...envelope, event: { ...base, bot_id: "B1" } }), undefined);
    assert.equal(
      normalizeSlackEvent({ ...envelope, event: { ...base, subtype: "message_changed" } }),
      undefined,
    );
    assert.equal(
      normalizeSlackEvent({
        ...envelope,
        event: { ...base, thread_ts: "1700000000.000001" },
      }),
      undefined,
    );
  });

  it("keeps an app mention", () => {
    const event = normalizeSlackEvent({
      ...envelope,
      event: {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        text: "<@UBOT> hello",
        ts: "1700000000.000001",
        event_ts: "1700000000.000001",
      },
    });

    assert.equal(event?.type, "mention");
  });
});
