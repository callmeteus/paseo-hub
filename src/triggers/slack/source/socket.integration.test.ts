import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { runWithFailureTracking } from "../../../failures/index.js";
import { createLogger } from "../../../logger.js";
import { assertOneFailure, FailureLogStream } from "../../../test-utils/failure-logs.js";
import { startSlackSocketFixture } from "../../../test-utils/slack-socket-fixture.js";
import { createSlackEventSource } from "./index.js";

describe("Slack Socket Mode source", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

  it("uses the app token and acknowledges only after the durable intake resolves", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acceptedInputs: Parameters<typeof createSlackEventSource>[0]["accept"] extends (
      input: infer T,
    ) => Promise<unknown>
      ? T[]
      : never = [];
    const source = socketSource(slack, async (input) => {
      acceptedInputs.push(input);
      await blocked;
      return { status: "accepted", events: [], receiptId: "receipt-123" };
    });

    await source.start(() => Promise.resolve());
    await waitFor(() => source.status().state === "connected");
    assert.equal(slack.authorization, "Bearer xapp-fixture-secret");
    slack.send(eventEnvelope("env-123", "E123"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(slack.acks, []);

    release?.();
    await waitFor(() => slack.acks.length === 1);
    assert.deepEqual(slack.acks, [{ envelope_id: "env-123" }]);
    assert.deepEqual(
      acceptedInputs.map((input) => {
        return { deliveryId: input.deliveryId, source: input.source, teamId: input.teamId };
      }),
      [{ deliveryId: "slack-E123", source: "slack.mention", teamId: "T123" }],
    );
    await source.stop();
  });

  it("stops retrying rejected app tokens and owns one secret-safe failure", async () => {
    const token = "xapp-token-canary-42";
    const bodyCanary = "provider-body-canary-91";
    const slack = await startSlackSocketFixture([
      { kind: "slackError", code: "invalid_auth", bodyCanary },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, () => Promise.reject(new Error("not reached")), token);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "actionNeeded");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(slack.openCount, 1);
    const status = source.status();
    assert.equal(status.state === "actionNeeded" ? status.reason : undefined, "appTokenRejected");
    assertSlackFailure(stream, "slack.socket.authenticate", "authentication", token, 40);
    assert.equal(stream.text().includes(bodyCanary), false);
    await source.stop();
  });

  it("treats a wrong-app hello as terminal until an explicit retry", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "socket", appId: "A-WRONG" },
      { kind: "socket" },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "actionNeeded");
    assert.equal(slack.openCount, 1);
    const status = source.status();
    assert.equal(
      status.state === "actionNeeded" ? status.reason : undefined,
      "appIdentityMismatch",
    );
    await source.retry();
    await waitFor(() => source.status().state === "connected");
    assert.equal(slack.openCount, 2);
    assertSlackFailure(
      stream,
      "slack.socket.authenticate",
      "authentication",
      "xapp-fixture-secret",
      40,
    );
    await source.stop();
  });

  it("retries a transient outage once without logging every reconnect", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "http", status: 503 },
      { kind: "socket" },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    assert.equal(slack.openCount, 2);
    assertSlackFailure(stream, "slack.socket.connect", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("stays connected while Slack answers pings", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, accepted, "xapp-fixture-secret", {
      pingIntervalMs: 30,
      pongTimeoutMs: 80,
    });

    await source.start(ignoreTrigger);
    await waitFor(() => source.status().state === "connected");
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(slack.openCount, 1);
    assert.equal(source.status().state, "connected");
    await source.stop();
  });

  it("reconnects once when a ping goes unanswered", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted, "xapp-fixture-secret", {
      pingIntervalMs: 40,
      pongTimeoutMs: 50,
    });

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");
    slack.silencePongs();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(slack.openCount, 2);
    assertSlackFailure(stream, "slack.socket.heartbeat", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("reconnects cleanly for refresh and reports one abnormal close", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const cleanLogs = new FailureLogStream();
    const source = socketSource(slack, accepted);
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(cleanLogs));
    await waitFor(() => source.status().state === "connected");

    slack.send({ type: "disconnect", reason: "refresh_requested" });
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    assert.equal(cleanLogs.records().length, 0);

    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 3 && source.status().state === "connected");
    assertSlackFailure(cleanLogs, "slack.socket.connect", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("acknowledges a poison envelope once and never records its payload", async () => {
    const payloadCanary = "payload-canary-440";
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send({ type: "events_api", envelope_id: "poison-1", payload: payloadCanary });
    await waitFor(() => slack.acks.length === 1);

    assert.deepEqual(slack.acks, [{ envelope_id: "poison-1" }]);
    assertSlackFailure(stream, "slack.socket.envelope.parse", "validation", payloadCanary, 40);
    await source.stop();
  });

  it("aborts a stalled open response and releases every transport on stop", async () => {
    const slack = await startSlackSocketFixture([{ kind: "unfinished", status: 200 }]);
    closers.push(() => slack.close());
    const source = socketSource(slack, accepted);
    await source.start(() => Promise.resolve());
    await waitFor(() => slack.openCount === 1);

    const started = Date.now();
    await source.stop();

    assert.ok(Date.now() - started < 1_000);
    await waitFor(() => slack.outstanding === 0);
    assert.equal(source.status().state, "stopped");
  });

  it("acknowledges a plan decision and settles the card after the ack", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const acceptedInputs: Parameters<typeof createSlackEventSource>[0]["accept"] extends (
      input: infer T,
    ) => Promise<unknown>
      ? T[]
      : never = [];
    let settled = false;
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-fixture-secret",
      },
      socket: { apiUrl: slack.openUrl, random: () => 0, timeoutMs: 250 },
      accept: (input) => {
        acceptedInputs.push(input);
        return Promise.resolve({
          status: "accepted",
          receiptId: "receipt-123",
          events: [
            {
              providerEventReceiptId: "trigger-1",
              organizationId: "org-1",
              projectId: "project-1",
              configurationRevisionId: "11111111-1111-4111-8111-111111111132",
              deliveryId: input.deliveryId,
              source: input.source,
              payload: input.payload,
              receivedAt: input.receivedAt,
              connectionId: null,
              resourceId: input.teamId,
            },
          ],
        });
      },
      settlePlanDecision: () => {
        settled = true;
        return Promise.resolve();
      },
    });
    await source.start(() => Promise.resolve());
    await waitFor(() => source.status().state === "connected");
    slack.send(feedbackEnvelope("env-feedback"));
    await waitFor(() => settled && slack.acks.length === 1);
    assert.equal(acceptedInputs[0]?.deliveryId, "slack-feedback-T123-C123-1700000000.000100");
    assert.equal(acceptedInputs[0]?.source, "slack.message");
    const payload = acceptedInputs[0]?.payload;
    assert.equal(
      payload !== null && typeof payload === "object" && "planDecision" in payload
        ? payload.planDecision
        : undefined,
      "ship",
    );
    await source.stop();
  });

  it("acknowledges an unknown action without accepting it", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let accepted = false;
    const source = socketSource(slack, () => {
      accepted = true;
      return Promise.resolve({ status: "accepted", events: [], receiptId: "receipt-123" });
    });
    await source.start(() => Promise.resolve());
    await waitFor(() => source.status().state === "connected");
    slack.send(feedbackEnvelope("env-other", "not_a_plan_button"));
    await waitFor(() => slack.acks.length === 1);
    assert.equal(accepted, false);
    await source.stop();
  });
});

function socketSource(
  slack: { openUrl: string },
  accept: Parameters<typeof createSlackEventSource>[0]["accept"],
  appToken = "xapp-fixture-secret",
  heartbeat?: { pingIntervalMs: number; pongTimeoutMs: number },
) {
  return createSlackEventSource({
    configuration: { provider: "slack", transport: "socket", appId: "A123", appToken },
    socket: {
      apiUrl: slack.openUrl,
      random: () => 0,
      timeoutMs: 250,
      ...heartbeat,
    },
    accept,
  });
}

const accepted: Parameters<typeof createSlackEventSource>[0]["accept"] = () =>
  Promise.resolve({ status: "accepted", events: [], receiptId: "receipt-123" });
const ignoreTrigger = () => Promise.resolve();

function assertSlackFailure(
  stream: FailureLogStream,
  operation: string,
  failureKind: string,
  canary: string,
  level?: number,
) {
  assertOneFailure(stream, {
    operation,
    component: "triggers",
    failureKind,
    canary,
    ...(level === undefined ? {} : { level }),
  });
}

function feedbackEnvelope(envelopeId: string, actionId = "paseo_choice_0", value = "ship") {
  return {
    type: "interactive",
    envelope_id: envelopeId,
    payload: {
      type: "block_actions",
      api_app_id: "A123",
      team: { id: "T123" },
      channel: { id: "C123" },
      user: { id: "U123", username: "ada" },
      message: { ts: "1700000000.000100", thread_ts: "1699999999.000001", text: "The plan" },
      actions: [
        {
          action_id: actionId,
          action_ts: "1700000001.000200",
          value,
          text: { type: "plain_text", text: "Ship it" },
        },
      ],
    },
  };
}

function eventEnvelope(envelopeId: string, eventId: string) {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A123",
      event_id: eventId,
      event_time: 1_700_000_000,
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123",
        text: "<@UBOT> hello",
        ts: "1700000000.001",
        event_ts: "1700000000.001",
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
