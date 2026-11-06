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
    assert.equal(event?.fromBot, undefined);
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

    const { user: _ignoredUser, ...withoutUser } = base;
    assert.equal(
      normalizeSlackEvent({ ...envelope, event: { ...withoutUser, bot_id: "B1" } }),
      undefined,
    );
    assert.equal(describeDroppedSlackEvent({ ...withoutUser, bot_id: "B1" })?.reason, "bot");
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

  it("keeps a channel file share as the post", () => {
    const raw = {
      type: "message",
      user: "U1",
      channel: "C0BA6DKUQJJ",
      text: "Bug não permite adicionar uma imagem",
      subtype: "file_share",
      ts: "1700000000.000009",
      event_ts: "1700000000.000009",
      channel_type: "channel",
      files: [{ id: "F1", name: "image.png", mimetype: "image/png", size: 12 }],
    };
    const event = normalizeSlackEvent({ ...envelope, event: raw });

    assert.equal(event?.type, "message");
    assert.equal(event?.content, "Bug não permite adicionar uma imagem");
    assert.equal(event?.threadTs, null);
    assert.deepEqual(event?.attachments, [
      { id: "F1", filename: "image.png", contentType: "image/png", size: 12 },
    ]);
    assert.equal(describeDroppedSlackEvent(raw), undefined);
    assert.equal(
      normalizeSlackEvent({
        ...envelope,
        event: { ...raw, thread_ts: "1700000000.000001" },
      }),
      undefined,
    );
  });

  it("keeps a channel message posted by another Slack app", () => {
    const raw = {
      type: "message",
      user: "U09FFH54LM9",
      bot_id: "B1",
      subtype: "bot_message",
      channel: "C1",
      text: "Deploy Request #846",
      ts: "1700000000.000004",
      event_ts: "1700000000.000004",
      channel_type: "group",
    };
    const event = normalizeSlackEvent({ ...envelope, event: raw });

    assert.equal(event?.type, "message");
    assert.equal(event?.author.id, "U09FFH54LM9");
    assert.equal(event?.content, "Deploy Request #846");
    assert.equal(event?.fromBot, true);
    assert.equal(describeDroppedSlackEvent(raw), undefined);

    const { subtype: _subtype, ...withoutSubtype } = raw;
    const untyped = normalizeSlackEvent({ ...envelope, event: withoutSubtype });
    assert.equal(untyped?.type, "message");
    assert.equal(untyped?.author.id, "U09FFH54LM9");
  });

  it("keeps an app-agent thread and a message that continues it", () => {
    const started = normalizeSlackEvent({
      ...envelope,
      event: {
        type: "assistant_thread_started",
        assistant_thread: {
          user_id: "U1",
          channel_id: "D1",
          thread_ts: "1729999327.187299",
          context: { channel_id: "C9", team_id: "T1" },
        },
        event_ts: "1729999327.187299",
      },
    });
    assert.equal(started?.type, "message");
    assert.equal(started?.assistantThread, true);
    assert.equal(started?.channelId, "D1");
    assert.equal(started?.threadTs, "1729999327.187299");
    assert.equal(started?.messageTs, "1729999327.187299");
    assert.equal(started?.content, "");
    assert.equal(started?.author.id, "U1");

    const continued = {
      type: "message",
      user: "U1",
      channel: "D1",
      channel_type: "im",
      text: "qual o estado?",
      ts: "1729999328.000100",
      thread_ts: "1729999327.187299",
      event_ts: "1729999328.000100",
    };
    const message = normalizeSlackEvent({ ...envelope, event: continued });
    assert.equal(message?.assistantThread, true);
    assert.equal(message?.channelId, "D1");
    assert.equal(message?.threadTs, "1729999327.187299");
    assert.equal(message?.messageTs, "1729999328.000100");
    assert.equal(message?.content, "qual o estado?");
    assert.equal(describeDroppedSlackEvent(continued), undefined);

    const marked = normalizeSlackEvent({
      ...envelope,
      event: {
        ...continued,
        channel: "C1",
        channel_type: "channel",
        assistant_thread: { channel_id: "D1", thread_ts: "1729999327.187299" },
      },
    });
    assert.equal(marked?.assistantThread, true);
    assert.equal(marked?.channelId, "D1");
    assert.equal(marked?.threadTs, "1729999327.187299");
  });

  it("still drops a plain direct message and the bot reply inside an assistant thread", () => {
    const direct = {
      type: "message",
      user: "U1",
      channel: "D1",
      channel_type: "im",
      text: "oi",
      ts: "1729999328.000100",
      event_ts: "1729999328.000100",
    };
    assert.equal(normalizeSlackEvent({ ...envelope, event: direct }), undefined);
    assert.equal(describeDroppedSlackEvent(direct)?.reason, "direct_message");

    const botReply = {
      type: "message",
      user: "UBOT",
      bot_id: "B1",
      channel: "D1",
      channel_type: "im",
      text: "resposta",
      ts: "1729999329.000100",
      thread_ts: "1729999327.187299",
      event_ts: "1729999329.000100",
    };
    assert.equal(normalizeSlackEvent({ ...envelope, event: botReply }), undefined);
    assert.equal(describeDroppedSlackEvent(botReply)?.reason, "bot");
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
