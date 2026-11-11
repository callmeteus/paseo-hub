import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import { slackChoiceArrival } from "./feedback.js";
import {
  createSlackInteractivitySource,
  settleSlackPlanDecision,
  type SettleSlackPlanDecisionInput,
} from "./interactivity.js";

const SECRET = "slack-signing-secret";
const APP_ID = "A123";
const NOW = 1_700_000_000_000;
const CARD_TS = "1700000000.000100";

describe("Slack interactivity", () => {
  it("answers a signed URL verification without accepting a click", async () => {
    let accepted = false;
    const endpoint = source(() => {
      accepted = true;
      return Promise.reject(new Error("unused"));
    });
    const response = await endpoint.handle(
      jsonRequest({ type: "url_verification", api_app_id: APP_ID, challenge: "challenge-token" }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: "challenge-token" });
    assert.equal(accepted, false);
  });

  it("accepts one Continue click from the form body", async () => {
    const accepted: Array<{ deliveryId: string; source: string; payload: unknown }> = [];
    const endpoint = source((input) => {
      accepted.push({
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
      });
      return Promise.resolve(acceptance(input));
    });
    const response = await endpoint.handle(
      formRequest(blockActions("paseo_choice_0", "ship", "Ship it")),
    );

    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.deliveryId, `slack-feedback-T123-C123-${CARD_TS}`);
    assert.equal(accepted[0]?.source, "slack.message");
    const payload = accepted[0]?.payload;
    assert.equal(
      payload !== null && typeof payload === "object" && "planDecision" in payload
        ? payload.planDecision
        : undefined,
      "ship",
    );
    assert.equal(
      payload !== null && typeof payload === "object" && "content" in payload
        ? payload.content
        : undefined,
      slackChoiceArrival({ label: "Ship it", value: "ship" }),
    );
    assert.equal(
      payload !== null && typeof payload === "object" && "threadTs" in payload
        ? payload.threadTs
        : undefined,
      "1699999999.000001",
    );
  });

  it("ignores a button this app did not post", async () => {
    let accepted = false;
    const endpoint = source(() => {
      accepted = true;
      return Promise.reject(new Error("unused"));
    });
    const response = await endpoint.handle(formRequest(blockActions("not_a_plan_button")));
    assert.equal(response.status, 200);
    assert.equal(accepted, false);
  });

  it("stores a thumb and does not start a run", async () => {
    let accepted = false;
    const recorded: Array<{ rating: string; messageTs: string }> = [];
    const endpoint = createSlackInteractivitySource({
      appId: APP_ID,
      signingSecret: SECRET,
      now: () => NOW,
      accept: () => {
        accepted = true;
        return Promise.reject(new Error("unused"));
      },
      recordFeedback: (input) => {
        recorded.push({ rating: input.rating, messageTs: input.messageTs });
        return Promise.resolve();
      },
    });
    const response = await endpoint.handle(
      formRequest(blockActions("paseo_feedback", "negative", "Ruim")),
    );
    assert.equal(response.status, 200);
    assert.equal(accepted, false);
    assert.deepEqual(recorded, [{ rating: "negative", messageTs: CARD_TS }]);
  });

  it("rejects a bad signature and a click for another app", async () => {
    const endpoint = source(() => Promise.resolve(acceptance(storedInput())));
    const unsigned = new Request("https://hub.test/api/integrations/slack/interactivity", {
      method: "POST",
      body: "payload=%7B%7D",
    });
    assert.equal((await endpoint.handle(unsigned)).status, 401);
    const wrongApp = blockActions("paseo_choice_0", "ship", "Ship it");
    wrongApp.api_app_id = "A_WRONG";
    assert.equal((await endpoint.handle(formRequest(wrongApp))).status, 400);
  });

  it("returns before the card update and does not relabel a stored decision", async () => {
    const stored = storedEvent("ship");
    let calls = 0;
    let settled: string | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint = source(
      (input) => {
        calls += 1;
        return Promise.resolve({
          status: "accepted",
          receiptId: "receipt-1",
          events: [calls === 1 ? { ...stored, payload: input.payload } : stored],
        });
      },
      async (input) => {
        settled = input.decision;
        await gate;
      },
    );

    const pending = endpoint.handle(formRequest(blockActions("paseo_choice_0", "ship", "Ship it")));
    const first = await Promise.race([
      pending.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    assert.equal(first, "done");
    assert.equal((await pending).status, 200);
    release?.();
    await waitFor(() => settled === "ship");

    settled = undefined;
    const second = await endpoint.handle(
      formRequest(blockActions("paseo_choice_1", "wait", "Wait")),
    );
    assert.equal(second.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, undefined);
  });

  it("replaces the buttons, and posts the choice when the card cannot be updated", async () => {
    const updated: unknown[] = [];
    const posted: string[] = [];
    await settleSlackPlanDecision(
      {
        updateMessage: (input) => {
          updated.push(input.blocks);
          return Promise.resolve({ ok: true });
        },
        sendMessage: () => Promise.reject(new Error("unused")),
      },
      decisionInput(),
    );
    assert.deepEqual(blockTypes(updated[0]), ["section", "context"]);

    await settleSlackPlanDecision(
      {
        updateMessage: () => Promise.resolve({ ok: false, error: "cant_update_message" }),
        sendMessage: (input) => {
          posted.push(input.content);
          return Promise.resolve();
        },
      },
      decisionInput(),
    );
    assert.deepEqual(posted, ["Ship it"]);
  });
});

function source(
  accept: (
    input: Parameters<Parameters<typeof createSlackInteractivitySource>[0]["accept"]>[0],
  ) => Promise<ProviderEventAcceptance>,
  settle?: (input: SettleSlackPlanDecisionInput) => Promise<void>,
) {
  return createSlackInteractivitySource({
    appId: APP_ID,
    signingSecret: SECRET,
    now: () => NOW,
    accept,
    ...(settle === undefined ? {} : { settlePlanDecision: settle }),
  });
}

function acceptance(
  input: Parameters<Parameters<typeof createSlackInteractivitySource>[0]["accept"]>[0],
): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: "receipt-1",
    events: [{ ...storedEvent("ship"), payload: input.payload, deliveryId: input.deliveryId }],
  };
}

function storedEvent(decision: string): DurableProviderEvent {
  return {
    providerEventReceiptId: "trigger-1",
    organizationId: "org-1",
    projectId: "project-1",
    configurationRevisionId: "11111111-1111-4111-8111-111111111132",
    deliveryId: `slack-feedback-T123-C123-${CARD_TS}`,
    source: "slack.message",
    payload: {
      type: "message",
      id: `feedback-C123-${CARD_TS}`,
      teamId: "T123",
      appId: APP_ID,
      channelId: "C123",
      messageTs: "1700000001.000200",
      threadTs: "1699999999.000001",
      eventTs: "1700000001.000200",
      eventTime: 1_700_000_001,
      content: slackChoiceArrival({ label: decision, value: decision }),
      author: { id: "U123" },
      planDecision: decision,
      createdAt: new Date(1_700_000_001_000).toISOString(),
    },
    receivedAt: new Date(NOW),
    connectionId: null,
    resourceId: "T123",
  };
}

function storedInput() {
  return {
    teamId: "T123",
    deliveryId: `slack-feedback-T123-C123-${CARD_TS}`,
    signatureHash: "hash",
    source: "slack.message",
    payload: storedEvent("ship").payload,
    receivedAt: new Date(NOW),
  };
}

function decisionInput(): SettleSlackPlanDecisionInput {
  return {
    organizationId: "org-1",
    teamId: "T123",
    channelId: "C123",
    messageTs: CARD_TS,
    threadTs: "1699999999.000001",
    text: "The plan",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "The plan" } },
      {
        type: "actions",
        elements: [{ type: "button", action_id: "paseo_choice_0" }],
      },
    ],
    decision: "ship",
    label: "Ship it",
  };
}

function blockActions(
  actionId: string,
  value = "ship",
  label = "Ship it",
): {
  type: string;
  api_app_id: string;
  team: { id: string };
  channel: { id: string };
  user: { id: string };
  message: { ts: string; thread_ts: string; text: string; blocks: unknown[] };
  actions: Array<{
    action_id: string;
    action_ts: string;
    value: string;
    text: { type: string; text: string };
  }>;
} {
  return {
    type: "block_actions",
    api_app_id: APP_ID,
    team: { id: "T123" },
    channel: { id: "C123" },
    user: { id: "U123" },
    message: {
      ts: CARD_TS,
      thread_ts: "1699999999.000001",
      text: "The plan",
      blocks: [],
    },
    actions: [
      {
        action_id: actionId,
        action_ts: "1700000001.000200",
        value,
        text: { type: "plain_text", text: label },
      },
    ],
  };
}

function jsonRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  return signedRequest(body, "application/json");
}

function formRequest(payload: unknown): Request {
  return signedRequest(
    `payload=${encodeURIComponent(JSON.stringify(payload))}`,
    "application/x-www-form-urlencoded",
  );
}

function signedRequest(body: string, contentType: string): Request {
  const timestamp = String(NOW / 1_000);
  return new Request("https://hub.test/api/integrations/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sign(timestamp, body),
    },
    body,
  });
}

function blockTypes(value: unknown): string[] {
  if (!isList(value)) return [];
  const types: string[] = [];
  for (const block of value) {
    if (!isRecord(block)) continue;
    const type = block["type"];
    if (typeof type === "string") types.push(type);
  }
  return types;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function sign(timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", SECRET).update("v0:").update(timestamp).update(":").update(body).digest("hex")}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
