import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { hashAgentExecutionCompletionToken } from "../../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  OutputExecutorRegistry,
  outputContextProvider,
} from "../../execution-capabilities/outputs.js";
import { createExecutionCapabilityServer } from "../../execution-capabilities/server.js";
import type { SlackChannelChoice } from "../../providers/slack/channels.js";
import type { SlackChannelMessage } from "../../providers/slack/history.js";
import {
  createSlackReadMessagesExecutor,
  readSlackMessagesTool,
  SlackReadMessagesError,
  type SlackMessageReader,
} from "./read-messages.js";

const RpcResponseSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.object({ code: z.number() }).passthrough().optional(),
  })
  .passthrough();
const ToolResultSchema = z
  .object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    isError: z.boolean().optional(),
  })
  .passthrough();

const channels: readonly SlackChannelChoice[] = [
  { id: "C1", name: "tecnologia-triagem", isPrivate: false },
  { id: "C2", name: "tecnologia-triagem-teste", isPrivate: true },
];

describe("Slack read_slack_messages output", () => {
  it("returns one line per message, oldest first, with the channel header", async () => {
    const reader = new ReaderFake([
      {
        ts: "1700000000.000002",
        author: "U2",
        text: "Segunda mensagem.",
        threadTs: null,
        isReply: false,
      },
      {
        ts: "1700000000.000001",
        author: "U1",
        text: "Primeira mensagem.",
        threadTs: null,
        isReply: false,
      },
    ]);
    const execute = createSlackReadMessagesExecutor({ reader });

    const text = await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "tecnologia-triagem", limit: 20 },
      outputContext: slackContext(),
    });

    assert.equal(
      text,
      [
        "#tecnologia-triagem: 2 mensagens.",
        "[1700000000.000001] U1: Primeira mensagem.",
        "[1700000000.000002] U2: Segunda mensagem.",
      ].join("\n"),
    );
    assert.deepEqual(reader.historyCalls, [
      { organizationId: "org-1", teamId: "T1", channelId: "C1", limit: 20 },
    ]);
  });

  it("accepts a #name, a channel id, and defaults the limit to 20", async () => {
    const reader = new ReaderFake([
      { ts: "1.1", author: "U1", text: "Oi.", threadTs: null, isReply: false },
    ]);
    const execute = createSlackReadMessagesExecutor({ reader });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "#tecnologia-triagem" },
      outputContext: slackContext(),
    });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "C1" },
      outputContext: slackContext(),
    });

    assert.deepEqual(
      reader.historyCalls.map((call) => call.limit),
      [20, 20],
    );
    assert.deepEqual(
      reader.historyCalls.map((call) => call.channelId),
      ["C1", "C1"],
    );
  });

  it("caps the read at 50 messages: 50 passes through, 51 is refused", async () => {
    const reader = new ReaderFake([]);
    const execute = createSlackReadMessagesExecutor({ reader });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "C1", limit: 50 },
      outputContext: slackContext(),
    });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.read_messages",
        args: { channel: "C1", limit: 51 },
        outputContext: slackContext(),
      }),
    );

    assert.deepEqual(
      reader.historyCalls.map((call) => call.limit),
      [50],
    );
    const limit = readSlackMessagesTool.inputSchema.properties?.["limit"];
    assert.equal(limit?.["maximum"], 50);
  });

  it("truncates one long message instead of dropping the rest", async () => {
    const reader = new ReaderFake([
      { ts: "1.1", author: "U1", text: "a".repeat(600), threadTs: null, isReply: false },
    ]);
    const execute = createSlackReadMessagesExecutor({ reader });

    const text = await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "C1" },
      outputContext: slackContext(),
    });

    assert.equal(text?.split("\n")[1], `[1.1] U1: ${"a".repeat(500)}...`);
  });

  it("names the channel when Slack returned nothing to read", async () => {
    const reader = new ReaderFake([]);
    const execute = createSlackReadMessagesExecutor({ reader });

    const text = await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.read_messages",
      args: { channel: "C1" },
      outputContext: slackContext(),
    });

    assert.equal(text, "#tecnologia-triagem: sem mensagens.");
  });

  it("fails with a Portuguese sentence when the channel is unknown", async () => {
    const reader = new ReaderFake([]);
    const execute = createSlackReadMessagesExecutor({ reader });

    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.read_messages",
          args: { channel: "nao-existe" },
          outputContext: slackContext(),
        }),
      SlackReadMessagesError,
    );
    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.read_messages",
          args: { channel: "nao-existe" },
          outputContext: slackContext(),
        }),
      /Não encontrei o canal nao-existe/u,
    );
    assert.deepEqual(reader.historyCalls, []);
  });

  it("fails with a Portuguese sentence when more than one channel matches", async () => {
    const reader = new ReaderFake([]);
    const execute = createSlackReadMessagesExecutor({ reader });

    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.read_messages",
          args: { channel: "triagem" },
          outputContext: slackContext(),
        }),
      /Mais de um canal combina com triagem/u,
    );
    assert.deepEqual(reader.historyCalls, []);
  });

  it("refuses arguments outside the documented input", async () => {
    const reader = new ReaderFake([]);
    const execute = createSlackReadMessagesExecutor({ reader });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.read_messages",
        args: { channel: "C1", limit: 99 },
        outputContext: slackContext(),
      }),
    );
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.read_messages",
        args: { channel: "" },
        outputContext: slackContext(),
      }),
    );
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.read_messages",
        args: { channel: "C1" },
        outputContext: { provider: "discord", organizationId: "org-1", teamId: "T1" },
      }),
    );
    assert.deepEqual(reader.historyCalls, []);
  });

  it("is listed for a Slack output context and not for a non-Slack one", () => {
    const registry = new OutputExecutorRegistry();
    registry.register({
      type: "slack.read_messages",
      tool: readSlackMessagesTool,
      available: (context) =>
        typeof context === "object" &&
        context !== null &&
        Reflect.get(context, "provider") === "slack",
      execute: createSlackReadMessagesExecutor({ reader: new ReaderFake([]) }),
    });

    const slack = registry.materialize([{ type: "slack.read_messages" }], {
      provider: "slack",
      organizationId: "org-1",
      teamId: "T1",
    });
    const discord = registry.materialize([{ type: "slack.read_messages" }], {
      provider: "discord",
      organizationId: "org-1",
      teamId: "T1",
    });

    assert.deepEqual(
      slack.map((output) => output.capability.tool.name),
      ["read_slack_messages"],
    );
    assert.deepEqual(discord, []);
  });

  it("answers the model through the capability server, and fails visibly on an unknown channel", async () => {
    const server = await readerServer([
      { ts: "1.1", author: "U1", text: "Primeira mensagem.", threadTs: null, isReply: false },
    ]);

    const listed = await server.call("tools/list");
    assert.deepEqual(
      ToolsListSchema.parse(listed.result).tools.map((tool) => tool.name),
      [
        "finish_execution",
        "clear_hard_deadline",
        "memory_save",
        "memory_search",
        "feedback_search",
        "read_slack_messages",
      ],
    );

    const read = await server.call("tools/call", {
      name: "read_slack_messages",
      arguments: { channel: "tecnologia-triagem", limit: 20 },
    });
    const readResult = ToolResultSchema.parse(read.result);
    assert.equal(readResult.isError, undefined);
    assert.equal(
      readResult.content[0]?.text,
      "#tecnologia-triagem: 1 mensagens.\n[1.1] U1: Primeira mensagem.",
    );

    const unknown = await server.call("tools/call", {
      name: "read_slack_messages",
      arguments: { channel: "nao-existe" },
    });
    const unknownResult = ToolResultSchema.parse(unknown.result);
    assert.equal(unknownResult.isError, true);
    assert.match(unknownResult.content[0]?.text ?? "", /Não encontrei o canal nao-existe/u);
  });
});

const ToolsListSchema = z
  .object({ tools: z.array(z.object({ name: z.string() }).passthrough()) })
  .passthrough();

/**
 * A capability server serving the real Slack read tool to one live execution.
 *
 * @param messages - What the fake reader answers
 * @returns A caller for that execution's MCP endpoint
 */
async function readerServer(messages: readonly SlackChannelMessage[]) {
  const database = createMemoryDatabase();
  const executionId = randomUUID();
  const token = "token";
  await database.insertAgentExecution({
    id: executionId,
    organizationId: "org-1",
    projectId: "project-1",
    machineId: null,
    triggerContext: { provider: "slack" },
    outputContext: slackContext(),
    configurationRevisionId: randomUUID(),
    completionTokenHash: hashAgentExecutionCompletionToken(token),
    launchIntent: {
      kind: "launch_machine",
      organizationId: "org-1",
      projectId: "project-1",
      triggerRunId: randomUUID(),
      triggerName: "slack-mention",
      environmentName: "daemon",
      environment: { kind: "daemon", daemonId: "daemon-1", authoredSlug: "daemon", cwd: "/w" },
      prompt: "read",
      agent: { provider: "codex", mode: "full-access" },
      allowOutputs: [{ type: "slack.read_messages" }],
      autoArchive: false,
      background: false,
      triggerContext: { provider: "slack" },
      outputContext: slackContext(),
      configurationRevisionId: randomUUID(),
      hubConfig: {},
    },
  });
  const outputs = new OutputExecutorRegistry();
  outputs.register({
    type: "slack.read_messages",
    tool: readSlackMessagesTool,
    available: outputContextProvider("slack"),
    execute: createSlackReadMessagesExecutor({ reader: new ReaderFake(messages) }),
  });
  const server = createExecutionCapabilityServer({
    database,
    outputs,
    completeExecution: () => {
      throw new Error("not used");
    },
  });
  let id = 0;
  return {
    async call(method: string, params?: unknown) {
      id += 1;
      const response = await server.handle(
        new Request(`https://hub.test/agent-executions/${executionId}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        }),
        executionId,
      );
      return RpcResponseSchema.parse(await response.json());
    },
  };
}

function slackContext() {
  return {
    provider: "slack" as const,
    organizationId: "org-1",
    teamId: "T1",
    channelId: "C1",
    threadTs: "1700000000.000001",
    messageTs: "1700000000.000001",
  };
}

class ReaderFake implements SlackMessageReader {
  historyCalls: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    limit: number;
  }> = [];

  constructor(private readonly messages: readonly SlackChannelMessage[]) {}

  listChannels(): Promise<readonly SlackChannelChoice[]> {
    return Promise.resolve(channels);
  }

  readHistory(input: (typeof this.historyCalls)[number]): Promise<readonly SlackChannelMessage[]> {
    this.historyCalls.push(input);
    return Promise.resolve(this.messages);
  }
}
