import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SlackChannelListError, listSlackMemberChannels } from "./channels.js";

describe("Slack channel list", () => {
  it("follows the cursor and returns named channels sorted by name", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const pages = [
      {
        ok: true,
        channels: [
          { id: "C2", name: "random", is_private: false },
          { id: "C1", name: "general", is_private: true },
          { id: "C3" },
        ],
        response_metadata: { next_cursor: "page-2" },
      },
      {
        ok: true,
        channels: [{ id: "C4", name: "alerts", is_private: false }],
        response_metadata: { next_cursor: "" },
      },
    ];

    const channels = await listSlackMemberChannels("xoxb-test", async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url: url.href,
        authorization: headers.get("authorization"),
      });
      const page = pages.shift();
      return Response.json(page);
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.authorization, "Bearer xoxb-test");
    assert.equal(new URL(requests[0]?.url ?? "").searchParams.get("cursor"), null);
    assert.equal(new URL(requests[1]?.url ?? "").searchParams.get("cursor"), "page-2");
    assert.equal(
      new URL(requests[0]?.url ?? "").searchParams.get("types"),
      "public_channel,private_channel",
    );
    assert.deepEqual(channels, [
      { id: "C4", name: "alerts", isPrivate: false },
      { id: "C1", name: "general", isPrivate: true },
      { id: "C2", name: "random", isPrivate: false },
    ]);
  });

  it("throws Slack's error code when the token cannot list channels", async () => {
    await assert.rejects(
      () => listSlackMemberChannels("xoxb-test", missingScopeResponse),
      (error: unknown) => {
        assert.equal(SlackChannelListError.read(error), "missing_scope");
        return true;
      },
    );
  });

  it("throws when Slack does not return a conversations payload", async () => {
    await assert.rejects(
      () => listSlackMemberChannels("xoxb-test", invalidConversationsResponse),
      (error: unknown) => {
        assert.equal(SlackChannelListError.read(error), "invalid_response");
        return true;
      },
    );
  });
});

/**
 * Reads the URL the channel list requested.
 *
 * @param input - Fetch target passed by the list
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

/**
 * Slack answers that the token cannot list channels.
 *
 * @returns A conversations payload with `missing_scope`
 */
function missingScopeResponse(): Promise<Response> {
  return Promise.resolve(Response.json({ ok: false, error: "missing_scope" }));
}

/**
 * Slack answers with a body that is not a conversations payload.
 *
 * @returns An HTTP 500 with plain text
 */
function invalidConversationsResponse(): Promise<Response> {
  return Promise.resolve(new Response("nope", { status: 500 }));
}
