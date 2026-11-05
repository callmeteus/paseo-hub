import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { replyOutputTool, OutputExecutorRegistry } from "../execution-capabilities/outputs.js";
import {
  GuardrailIdSchema,
  GuardrailRefusal,
  GuardrailSchema,
  GuardrailsSchema,
  SLACK_SAME_CHANNEL,
  SLACK_SAME_THREAD,
  enforceSlackGuardrails,
  type Guardrail,
  type SlackPostDestination,
  type SlackTriggerSource,
} from "./guardrails.js";

const sourceThread: SlackTriggerSource = {
  channelId: "C1",
  threadTs: "1.1",
  messageTs: "1.2",
};

const sameDestination: SlackPostDestination = {
  channelId: "C1",
  threadTs: "1.1",
};

const sameChannel: Guardrail = { id: SLACK_SAME_CHANNEL };
const sameChannelWithOptions: Guardrail = { id: SLACK_SAME_CHANNEL, options: {} };
const sameThread: Guardrail = { id: SLACK_SAME_THREAD };
const sameThreadWithOptions: Guardrail = { id: SLACK_SAME_THREAD, options: {} };

describe("enforceSlackGuardrails", () => {
  it("allows a Slack post in the triggering channel", () => {
    enforceSlackGuardrails({
      guardrails: [sameChannel],
      action: { kind: "slack.post", destination: { ...sameDestination, channelId: "C1" } },
      source: sourceThread,
    });
  });

  it("refuses a Slack post in a different channel", () => {
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameChannelWithOptions],
          action: { kind: "slack.post", destination: { ...sameDestination, channelId: "C2" } },
          source: sourceThread,
        }),
      (error: unknown) => refusal(error, "slack.same_channel"),
    );
  });

  it("allows a Slack post in the triggering thread", () => {
    enforceSlackGuardrails({
      guardrails: [sameThreadWithOptions],
      action: { kind: "slack.post", destination: sameDestination },
      source: sourceThread,
    });
  });

  it("allows a reply to the message that is already the thread root", () => {
    enforceSlackGuardrails({
      guardrails: [sameThread],
      action: { kind: "slack.post", destination: { channelId: "C1", threadTs: "1.1" } },
      source: { channelId: "C1", messageTs: "1.1" },
    });
  });

  it("refuses a Slack post in a different thread", () => {
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameThread],
          action: { kind: "slack.post", destination: { channelId: "C1", threadTs: "9.9" } },
          source: sourceThread,
        }),
      (error: unknown) => refusal(error, "slack.same_thread"),
    );
  });

  it("refuses a top-level channel message when the thread rail is on", () => {
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameThread],
          action: { kind: "slack.post", destination: { channelId: "C1" } },
          source: sourceThread,
        }),
      (error: unknown) => refusal(error, "slack.same_thread"),
    );
  });

  it("fails closed when the triggering event has no channel or thread", () => {
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameChannel],
          action: { kind: "slack.post", destination: sameDestination },
          source: undefined,
        }),
      (error: unknown) => refusal(error, "slack.same_channel"),
    );
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameChannel],
          action: { kind: "slack.post", destination: sameDestination },
          source: { threadTs: "1.1", messageTs: "1.2" },
        }),
      (error: unknown) => refusal(error, "slack.same_channel"),
    );
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameThread],
          action: { kind: "slack.post", destination: sameDestination },
          source: undefined,
        }),
      (error: unknown) => refusal(error, "slack.same_thread"),
    );
    assert.throws(
      () =>
        enforceSlackGuardrails({
          guardrails: [sameThread],
          action: { kind: "slack.post", destination: sameDestination },
          source: { channelId: "C1" },
        }),
      (error: unknown) => refusal(error, "slack.same_thread"),
    );
  });

  it("leaves the send alone when guardrails is omitted", () => {
    enforceSlackGuardrails({
      guardrails: undefined,
      action: { kind: "slack.post", destination: { channelId: "C2", threadTs: "9.9" } },
      source: undefined,
    });
  });

  it("ignores a Slack rail on a send that is not a Slack post", () => {
    enforceSlackGuardrails({
      guardrails: [sameChannel, sameThreadWithOptions],
      action: { kind: "other" },
      source: undefined,
    });
  });
});

describe("guardrail schema", () => {
  it("accepts an object rail and rejects a bare string, an unknown id, and an unknown option", () => {
    assert.equal(GuardrailIdSchema.safeParse(SLACK_SAME_CHANNEL).success, true);
    assert.equal(GuardrailIdSchema.safeParse(SLACK_SAME_THREAD).success, true);
    assert.equal(GuardrailIdSchema.safeParse("slack.somewhere_else").success, false);
    assert.equal(GuardrailSchema.safeParse(sameChannel).success, true);
    assert.equal(GuardrailSchema.safeParse(sameThreadWithOptions).success, true);
    assert.equal(GuardrailsSchema.safeParse([sameChannel, sameThreadWithOptions]).success, true);
    assert.equal(GuardrailsSchema.safeParse([]).success, false);
    assert.equal(GuardrailsSchema.safeParse([SLACK_SAME_CHANNEL]).success, false);
    assert.equal(GuardrailsSchema.safeParse([{ id: "slack.somewhere_else" }]).success, false);
    assert.equal(
      GuardrailsSchema.safeParse([{ id: SLACK_SAME_CHANNEL, options: { extra: true } }]).success,
      false,
    );
    assert.equal(
      GuardrailsSchema.safeParse([{ id: SLACK_SAME_THREAD, note: "no" }]).success,
      false,
    );
  });
});

describe("output execution guardrail", () => {
  it("sends a Slack reply that stays in the triggering channel and thread", async () => {
    const delivery = send({
      toolType: "slack.reply",
      outputContext: { provider: "slack", channelId: "C1", threadTs: "1.1" },
      triggerContext: slackEvent({ channelId: "C1", threadTs: "1.1", messageTs: "1.2" }),
      guardrails: [sameChannel, sameThread],
    });
    await delivery.done;
    assert.equal(delivery.sent(), true);
  });

  it("refuses the Slack reply before the message is sent", async () => {
    const delivery = send({
      toolType: "slack.reply",
      outputContext: { provider: "slack", channelId: "C2", threadTs: "9.9" },
      triggerContext: slackEvent({ channelId: "C1", threadTs: "1.1", messageTs: "1.2" }),
      guardrails: [sameChannel],
    });
    await assert.rejects(delivery.done, (error: unknown) => refusal(error, "slack.same_channel"));
    assert.equal(delivery.sent(), false);
  });

  it("refuses a Slack reaction in another channel before it is posted", async () => {
    const delivery = send({
      toolType: "slack.react",
      outputContext: { provider: "slack", channelId: "C9", threadTs: "1.1", messageTs: "1.2" },
      triggerContext: slackEvent({ channelId: "C1", threadTs: "1.1", messageTs: "1.2" }),
      guardrails: [sameChannel],
    });
    await assert.rejects(delivery.done, (error: unknown) => refusal(error, "slack.same_channel"));
    assert.equal(delivery.sent(), false);
  });

  it("fails closed for a Slack reply whose triggering event has no channel", async () => {
    const delivery = send({
      toolType: "slack.reply",
      outputContext: { provider: "slack", channelId: "C1", threadTs: "1.1" },
      triggerContext: { provider: "github" },
      guardrails: [sameChannel],
    });
    await assert.rejects(delivery.done, (error: unknown) => refusal(error, "slack.same_channel"));
    assert.equal(delivery.sent(), false);
  });

  it("still delivers a GitHub reply when the run lists Slack rails", async () => {
    const delivery = send({
      toolType: "github.reply",
      outputContext: { provider: "github" },
      triggerContext: { provider: "github" },
      guardrails: [sameChannel, sameThread],
    });
    await delivery.done;
    assert.equal(delivery.sent(), true);
  });
});

function refusal(error: unknown, rail: string): boolean {
  assert.ok(error instanceof GuardrailRefusal);
  assert.equal(error.rail, rail);
  return true;
}

function slackEvent(input: { channelId: string; threadTs?: string; messageTs: string }) {
  return {
    provider: "slack",
    event: {
      slack: {
        trigger_message: {
          ts: input.messageTs,
          channel: { id: input.channelId },
          thread: input.threadTs === undefined ? null : { ts: input.threadTs },
        },
      },
    },
  };
}

function send(input: {
  toolType: string;
  outputContext: unknown;
  triggerContext: unknown;
  guardrails: readonly Guardrail[];
}): { done: Promise<void>; sent: () => boolean } {
  let posted = false;
  const registry = new OutputExecutorRegistry();
  registry.register({
    type: input.toolType,
    tool: input.toolType === "github.reply" ? githubReplyTool : replyOutputTool,
    execute() {
      posted = true;
      return Promise.resolve();
    },
  });
  const done = registry.execute({
    agentExecutionId: "execution-1",
    toolType: input.toolType,
    args: { content: "Done" },
    outputContext: input.outputContext,
    triggerContext: input.triggerContext,
    guardrails: input.guardrails,
  });
  return { done, sent: () => posted };
}

const githubReplyTool = {
  name: "reply",
  description: "Replies on GitHub.",
  inputSchema: { type: "object" as const },
};
