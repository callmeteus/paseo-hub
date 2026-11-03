import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DatabaseUnavailableError } from "../db/errors.js";
import { SlackChannelListError } from "../providers/slack/channels.js";
import type { PublicOperationRepository } from "./types.js";
import { listPublicSlackChannels, readPublicSlackMessages } from "./slack.js";

const channels = [
  { id: "C1", name: "tecnologia-triagem", isPrivate: false },
  { id: "C2", name: "tecnologia-triagem-teste", isPrivate: true },
];

describe("public Slack reads", () => {
  it("uses the only Slack connection and does not return the bot token", async () => {
    let seenToken = "";
    const result = await listPublicSlackChannels({
      repository: repository({ status: "ready", slug: "acme", token: "xoxb-test" }),
      organizationId: "org",
      connection: undefined,
      query: "#tecnologia-triagem-teste",
      client: {
        listChannels(token) {
          seenToken = token;
          return Promise.resolve(channels);
        },
        readHistory() {
          return Promise.resolve([]);
        },
      },
    });

    assert.equal(seenToken, "xoxb-test");
    assert.equal(JSON.stringify(result).includes("xoxb-test"), false);
    assert.deepEqual(result, {
      status: "channels",
      connection: "acme",
      truncated: false,
      channels: [channels[1]],
    });
  });

  it("asks for a connection when the organization has more than one", async () => {
    let listed = false;
    const result = await listPublicSlackChannels({
      repository: repository({
        status: "ambiguous",
        connections: [
          { slug: "acme", teamName: "Acme" },
          { slug: "other", teamName: "Other" },
        ],
      }),
      organizationId: "org",
      connection: undefined,
      query: undefined,
      client: {
        listChannels() {
          listed = true;
          return Promise.resolve(channels);
        },
        readHistory() {
          return Promise.resolve([]);
        },
      },
    });

    assert.equal(listed, false);
    assert.equal(result.status, "connection_required");
  });

  it("reports a missing Slack scope without the bot token", async () => {
    const result = await readPublicSlackMessages({
      repository: repository({ status: "ready", slug: "acme", token: "xoxb-test" }),
      organizationId: "org",
      connection: "acme",
      channel: "tecnologia-triagem",
      limit: 10,
      client: {
        listChannels() {
          return Promise.reject(new SlackChannelListError("missing_scope"));
        },
        readHistory() {
          return Promise.resolve([]);
        },
      },
    });

    assert.deepEqual(result, { status: "slack_rejected", slackError: "missing_scope" });
    assert.equal(JSON.stringify(result).includes("xoxb-test"), false);
  });

  it("reads one channel and reports an ambiguous name", async () => {
    const read = await readPublicSlackMessages({
      repository: repository({ status: "ready", slug: "acme", token: "xoxb-test" }),
      organizationId: "org",
      connection: undefined,
      channel: "tecnologia-triagem-teste",
      limit: 5,
      client: {
        listChannels() {
          return Promise.resolve(channels);
        },
        readHistory(_token, channelId) {
          assert.equal(channelId, "C2");
          return Promise.resolve([
            {
              ts: "1",
              author: "U1",
              text: "Preciso de acesso.",
              threadTs: null,
              isReply: false,
            },
          ]);
        },
      },
    });
    assert.deepEqual(read, {
      status: "messages",
      connection: "acme",
      channel: { id: "C2", name: "tecnologia-triagem-teste" },
      messages: [
        {
          ts: "1",
          author: "U1",
          text: "Preciso de acesso.",
          threadTs: null,
          isReply: false,
        },
      ],
    });

    const ambiguous = await readPublicSlackMessages({
      repository: repository({ status: "ready", slug: "acme", token: "xoxb-test" }),
      organizationId: "org",
      connection: undefined,
      channel: "triagem",
      limit: undefined,
      client: {
        listChannels() {
          return Promise.resolve(channels);
        },
        readHistory() {
          throw new Error("must not read until the channel is unique");
        },
      },
    });
    assert.equal(ambiguous.status, "channel_ambiguous");
  });

  it("returns infrastructure_unavailable when storage cannot be reached", async () => {
    const result = await listPublicSlackChannels({
      repository: {
        slackConnection() {
          return Promise.reject(new DatabaseUnavailableError());
        },
      },
      organizationId: "org",
      connection: undefined,
      query: undefined,
    });

    assert.deepEqual(result, { status: "infrastructure_unavailable" });
  });
});

/**
 * @param found - What the connection lookup returns
 * @returns A repository double with only the Slack lookup
 */
function repository(
  found: Awaited<ReturnType<PublicOperationRepository["slackConnection"]>>,
): Pick<PublicOperationRepository, "slackConnection"> {
  return {
    slackConnection() {
      return Promise.resolve(found);
    },
  };
}
