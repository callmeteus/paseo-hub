import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { intakeSlackEvent } from "./source/internal/intake.js";

const cardTs = "1795611989.216289";
const teamId = "T1";

const appThreadReply = {
  type: "event_callback",
  team_id: teamId,
  api_app_id: "A1",
  event_id: "Ev-reply",
  event_time: 1_795_612_980,
  event: {
    type: "message",
    user: "U1",
    bot_id: "B1",
    subtype: "bot_message",
    channel: "C1",
    channel_type: "channel",
    text: "A customer confirmed and closed the case",
    ts: "1795612980.000001",
    event_ts: "1795612980.000002",
    thread_ts: cardTs,
  },
};

const cardEdit = {
  type: "event_callback",
  team_id: teamId,
  api_app_id: "A1",
  event_id: "Ev-edit",
  event_time: 1_795_612_200,
  event: {
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    ts: "1795612200.000001",
    event_ts: "1795612200.000002",
    message: {
      type: "message",
      user: "U1",
      bot_id: "B1",
      text: "An agent changed the stage to Resolved and gave another answer",
      ts: cardTs,
      thread_ts: cardTs,
    },
  },
};

interface Accepted {
  source: string;
  payload: Record<string, unknown>;
}

async function capture(callback: unknown): Promise<Accepted[]> {
  const accepted: Accepted[] = [];
  await intakeSlackEvent(callback, "signature", new Set(), {
    appId: "A1",
    accept: (input) => {
      const payload = z.record(z.string(), z.unknown()).safeParse(input.payload);
      accepted.push({ source: input.source, payload: payload.success ? payload.data : {} });
      return Promise.resolve({ status: "accepted", receiptId: "r1", events: [] });
    },
  });
  return accepted;
}

describe("Slack thread signals", () => {
  it("keeps an app reply in a thread as an interruption signal", async () => {
    const accepted = await capture(appThreadReply);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.source, "slack.thread_signal");
    assert.equal(accepted[0]?.payload["threadTs"], cardTs);
    assert.match(String(accepted[0]?.payload["text"]), /closed the case/u);
  });

  it("keeps an edited card as an interruption signal", async () => {
    const accepted = await capture(cardEdit);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.source, "slack.thread_signal");
    assert.equal(accepted[0]?.payload["threadTs"], cardTs);
    assert.match(String(accepted[0]?.payload["text"]), /another answer/u);
  });
});
