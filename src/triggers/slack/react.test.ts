import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SlackBotClient } from "./client.js";
import { appendSlackReactGrant, createSlackReactExecutor, slackReactGrant } from "./react.js";

describe("Slack react output", () => {
  it("adds the emoji the agent names on the triggering message", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReactExecutor({ client });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.react",
      args: { name: ":eyes:" },
      outputContext: slackContext(),
    });

    assert.deepEqual(client.reactions, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        messageTs: "1700000000.000001",
        name: "eyes",
      },
    ]);
  });

  it("rejects an emoji name Slack would not accept", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReactExecutor({ client });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.react",
        args: { name: "Eyes" },
        outputContext: slackContext(),
      }),
    );
    assert.deepEqual(client.reactions, []);
  });

  it("rejects a Slack context that has no triggering message", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReactExecutor({ client });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.react",
        args: { name: "eyes" },
        outputContext: {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
        },
      }),
    );
    assert.deepEqual(client.reactions, []);
  });

  it("grants slack.react for a Slack launch and leaves other providers alone", () => {
    const granted = slackReactGrant([{ type: "slack.reply", required: false }], {
      provider: "slack",
    });
    assert.deepEqual(granted, [
      { type: "slack.reply", required: false },
      { type: "slack.react", required: false },
    ]);

    const discord = slackReactGrant([{ type: "discord.reply", required: false }], {
      provider: "discord",
    });
    assert.deepEqual(discord, [{ type: "discord.reply", required: false }]);
    assert.deepEqual(appendSlackReactGrant([{ type: "slack.react", required: true }]), [
      { type: "slack.react", required: true },
    ]);
  });
});

function slackContext() {
  return {
    provider: "slack",
    organizationId: "org-1",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1700000000.000001",
    messageTs: "1700000000.000001",
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }> = [];

  sendMessage(): Promise<void> {
    return Promise.resolve();
  }

  addReaction(input: (typeof this.reactions)[number]): Promise<void> {
    this.reactions.push(input);
    return Promise.resolve();
  }

  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
}
