import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { SlackBotClient } from "./client.js";
import { SlackOutboundTextError } from "./outbound.js";
import { createSlackReplyExecutor } from "./reply.js";

describe("Slack reply output", () => {
  it("posts repeated replies into the same originating thread", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.reply",
      args: { content: "Done" },
      outputContext: {
        provider: "slack",
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        messageTs: "1700000000.000001",
      },
    });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "slack.reply",
      args: { content: "Feito, o deploy subiu." },
      outputContext: {
        provider: "slack",
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        messageTs: "1700000000.000001",
      },
    });
    assert.deepEqual(client.messages, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content: "Done",
      },
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content: "Feito, o deploy subiu.",
      },
    ]);
  });

  it("rejects invalid arguments before calling Slack", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: "" },
        outputContext: {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1.1",
        },
      }),
    );
    assert.deepEqual(client.messages, []);
  });

  it("fails closed for legacy output context without organization authority", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });

    await assert.rejects(() =>
      execute({
        agentExecutionId: "legacy-execution",
        toolType: "slack.reply",
        args: { content: "Done" },
        outputContext: { teamId: "T1", channelId: "C1", threadTs: "1.1" },
      }),
    );
    assert.deepEqual(client.messages, []);
  });

  it("refuses a reply the model has to rewrite and posts nothing", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });

    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.reply",
          args: {
            content: "I'll start by reacting to the message and reading the thread context.",
          },
          outputContext: slackContext(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof SlackOutboundTextError);
        assert.match(error.message, /português/u);
        return true;
      },
    );
    assert.deepEqual(client.messages, []);
    assert.deepEqual(client.uploads, []);
  });

  it("refuses a reply that narrates the execution in Portuguese", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });

    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.reply",
          args: { content: "Respondi na thread: o aviso é da cobrança." },
          outputContext: slackContext(),
        }),
      SlackOutboundTextError,
    );
    assert.deepEqual(client.messages, []);
  });

  it("refuses a reply that mentions something that is not a Slack id", async () => {
    const client = new RecordingSlackClient();
    const execute = createSlackReplyExecutor({ client });

    await assert.rejects(
      () =>
        execute({
          agentExecutionId: "execution-1",
          toolType: "slack.reply",
          args: { content: "Beleza <@phone-home>, já ajustei a rotina." },
          outputContext: slackContext(),
        }),
      SlackOutboundTextError,
    );
    assert.deepEqual(client.messages, []);
  });

  it("uploads a local attachment and posts the reply without the link", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-attachments-"));
    try {
      const path = join(root, "hash.png");
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const client = new RecordingSlackClient();
      const execute = createSlackReplyExecutor({ client });

      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: {
          content: `Segue o gráfico:\n<file://${path}|Image>\n\nAbraço.`,
        },
        outputContext: slackContext(),
      });

      assert.deepEqual(client.uploads, [
        {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          path,
        },
      ]);
      assert.deepEqual(
        client.messages.map((message) => message.content),
        ["Segue o gráfico:\n\nAbraço."],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("posts nothing when the reply was only the attachment link", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-attachments-"));
    try {
      const path = join(root, "hash.png");
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const client = new RecordingSlackClient();
      const execute = createSlackReplyExecutor({ client });

      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: `<file://${path}|Image>` },
        outputContext: slackContext(),
      });

      assert.deepEqual(client.uploads, [
        {
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          path,
        },
      ]);
      assert.deepEqual(client.messages, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops the link and posts the reply when the file is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-attachments-"));
    try {
      const path = join(root, "sumiu.png");
      const client = new RecordingSlackClient();
      const execute = createSlackReplyExecutor({ client });

      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: `Gráfico: <file://${path}|Image> pronto.` },
        outputContext: slackContext(),
      });

      assert.deepEqual(client.uploads, []);
      assert.deepEqual(
        client.messages.map((message) => message.content),
        ["Gráfico: pronto."],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops the upload and keeps the reply when Slack refuses the upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-attachments-"));
    try {
      const path = join(root, "hash.png");
      await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const client = new RecordingSlackClient();
      client.failUploads = true;
      const execute = createSlackReplyExecutor({ client });

      await execute({
        agentExecutionId: "execution-1",
        toolType: "slack.reply",
        args: { content: `Gráfico: <file://${path}|Image> pronto.` },
        outputContext: slackContext(),
      });

      assert.equal(client.uploads.length, 1);
      assert.deepEqual(
        client.messages.map((message) => message.content),
        ["Gráfico: pronto."],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
  messages: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }> = [];
  uploads: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    path: string;
  }> = [];
  failUploads = false;

  sendMessage(input: (typeof this.messages)[number]): Promise<void> {
    this.messages.push(input);
    return Promise.resolve();
  }
  addReaction(): Promise<void> {
    return Promise.resolve();
  }
  removeReaction(): Promise<void> {
    return Promise.resolve();
  }
  uploadFile(input: (typeof this.uploads)[number]): Promise<void> {
    this.uploads.push(input);
    if (this.failUploads) return Promise.reject(new Error("Slack API file_uploads_disabled"));
    return Promise.resolve();
  }
}
