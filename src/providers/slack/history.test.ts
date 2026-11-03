import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SlackChannelListError } from "./channels.js";
import { readSlackChannelHistory } from "./history.js";

describe("Slack channel history", () => {
  it("returns readable messages and keeps the bot token out of the URL", async () => {
    let requested = "";
    let authorization = "";
    const messages = await readSlackChannelHistory(
      "xoxb-test",
      "C01234567",
      80,
      async (input, init) => {
        requested = requestUrl(input).href;
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          ok: true,
          messages: [
            { ts: "2", text: "  parent  ", user: "U1", thread_ts: "2" },
            { ts: "1", text: "reply", user: "U2", thread_ts: "2" },
            { ts: "3", text: "   " },
            { ts: "4", text: "x".repeat(1600), bot_id: "B1" },
          ],
        });
      },
    );

    assert.equal(authorization, "Bearer xoxb-test");
    assert.equal(new URL(requested).searchParams.get("channel"), "C01234567");
    assert.equal(new URL(requested).searchParams.get("limit"), "50");
    assert.equal(requested.includes("xoxb-test"), false);
    assert.equal(messages[0]?.isReply, false);
    assert.equal(messages[0]?.threadTs, "2");
    assert.equal(messages[1]?.isReply, true);
    assert.equal(messages[1]?.author, "U2");
    assert.equal(messages.length, 3);
    assert.equal(messages[2]?.author, "B1");
    assert.equal(messages[2]?.text.endsWith("..."), true);
    assert.equal(messages[2]?.text.length, 1503);
  });

  it("keeps a forwarded message whose own text is empty", async () => {
    const messages = await readSlackChannelHistory("xoxb-test", "C1", 10, async () =>
      Response.json({
        ok: true,
        messages: [
          {
            ts: "1",
            text: "",
            user: "U1",
            attachments: [
              {
                is_share: true,
                author_name: "João",
                text: "Pessoal, boa tarde.",
                attachments: [{ is_share: true, author_name: "Maria", text: "o problema" }],
              },
            ],
          },
        ],
      }),
    );

    assert.equal(
      messages[0]?.text,
      "Encaminhada de João:\nPessoal, boa tarde.\nEncaminhada de Maria:\no problema",
    );
  });

  it("throws Slack's error code when the token cannot read history", async () => {
    await assert.rejects(
      () => readSlackChannelHistory("xoxb-test", "C1", 10, missingScopeResponse),
      (error: unknown) => {
        assert.equal(SlackChannelListError.read(error), "missing_scope");
        return true;
      },
    );
  });

  it("throws when Slack does not return a history payload", async () => {
    await assert.rejects(
      () => readSlackChannelHistory("xoxb-test", "C1", 10, invalidHistoryResponse),
      (error: unknown) => {
        assert.equal(SlackChannelListError.read(error), "invalid_response");
        return true;
      },
    );
  });
});

/**
 * @returns A Slack missing_scope payload
 */
function missingScopeResponse(): Promise<Response> {
  return Promise.resolve(Response.json({ ok: false, error: "missing_scope" }));
}

/**
 * @returns A body that is not conversations.history
 */
function invalidHistoryResponse(): Promise<Response> {
  return Promise.resolve(Response.json({ ok: true, messages: [{ text: 1 }] }));
}

/**
 * Reads the URL the history call requested.
 *
 * @param input - Fetch target passed by the reader
 * @returns Absolute URL of that request
 */
function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input.url);
}
