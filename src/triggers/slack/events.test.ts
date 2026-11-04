import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { describeDroppedSlackEvent, normalizeSlackEvent } from "./events.js";

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
    assert.equal(describeDroppedSlackEvent({ ...base, bot_id: "B1" })?.reason, "bot");
    assert.equal(
      normalizeSlackEvent({ ...envelope, event: { ...base, subtype: "message_changed" } }),
      undefined,
    );
    assert.deepEqual(describeDroppedSlackEvent({ ...base, subtype: "message_changed" }), {
      reason: "subtype",
      eventType: "message",
      subtype: "message_changed",
      channelType: "channel",
      channelId: "C1",
    });
    assert.equal(
      normalizeSlackEvent({
        ...envelope,
        event: { ...base, thread_ts: "1700000000.000001" },
      }),
      undefined,
    );
    assert.equal(
      describeDroppedSlackEvent({ ...base, thread_ts: "1700000000.000001" })?.reason,
      "thread_reply",
    );
    assert.equal(describeDroppedSlackEvent({ type: "reaction_added" }), undefined);
    assert.equal(describeDroppedSlackEvent({ ...base, text: "hello" }), undefined);
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

  it("reads every forwarded layer and a file that arrived inside the forward", () => {
    const event = normalizeSlackEvent({
      ...envelope,
      event: {
        type: "message",
        user: "U1",
        channel: "C1",
        text: "",
        ts: "1700000000.000003",
        event_ts: "1700000000.000003",
        channel_type: "channel",
        attachments: [
          {
            is_share: true,
            is_msg_unfurl: true,
            author_name: "João",
            channel_id: "C0BA6DKUQJJ",
            ts: "1700000000.000010",
            text: "repassa",
            attachments: [
              {
                is_share: true,
                author_name: "Maria",
                channel_id: "C09QAPR0VT7",
                ts: "1700000000.000011",
                text: "o problema",
                files: [{ id: "F1", name: "nota.png", mimetype: "image/png", size: 10 }],
              },
            ],
          },
        ],
      },
    });

    assert.equal(
      event?.content,
      "Encaminhada de João:\nrepassa\nEncaminhada de Maria:\no problema",
    );
    assert.deepEqual(event?.attachments, [
      { id: "F1", filename: "nota.png", contentType: "image/png", size: 10 },
    ]);
    assert.equal(event?.lead, "");
    assert.deepEqual(event?.forwards, [
      { channelId: "C0BA6DKUQJJ", messageTs: "1700000000.000010" },
    ]);
  });

  it("ignores a link preview that is not a forwarded message", () => {
    const event = normalizeSlackEvent({
      ...envelope,
      event: {
        type: "message",
        user: "U1",
        channel: "C1",
        text: "",
        ts: "1700000000.000004",
        event_ts: "1700000000.000004",
        channel_type: "channel",
        attachments: [{ text: "preview de um site", fallback: "preview" }],
      },
    });

    assert.equal(event?.content, "");
    assert.deepEqual(event?.attachments, []);
  });
});
