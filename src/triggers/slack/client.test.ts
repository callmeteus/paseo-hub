import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { createSlackBotClient } from "./client.js";

describe("Slack Web API client", () => {
  it("looks up an authored username with the workspace bot token", async () => {
    let request:
      | {
          url: string;
          method: string | undefined;
          contentType: string | null;
          body: string | undefined;
        }
      | undefined;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        request = {
          url: requestUrl(input),
          method: init?.method,
          contentType: new Headers(init?.headers).get("content-type"),
          body: requestBody(init?.body),
        };
        return Response.json({ ok: true, user: { name: "operator" } });
      },
    });

    assert.equal(
      await client.lookupUserName?.({ organizationId: "org-1", teamId: "T1", userId: "U1" }),
      "operator",
    );
    assert.deepEqual(request, {
      url: "https://slack.com/api/users.info",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: "user=U1",
    });
  });

  it("looks up a channel name with the same workspace bot token", async () => {
    const token = "xoxb-secret";
    let request:
      | {
          url: string;
          method: string | undefined;
          authorization: string | null;
          body: unknown;
        }
      | undefined;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve(token),
      fetch: async (input, init) => {
        request = {
          url: requestUrl(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get("authorization"),
          body: requestBody(init?.body),
        };
        return Response.json({ ok: true, channel: { name: "alertas" } });
      },
    });

    assert.equal(
      await client.lookupChannelName?.({
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C096V21TE0K",
      }),
      "alertas",
    );
    assert.deepEqual(request, {
      url: "https://slack.com/api/conversations.info",
      method: "POST",
      authorization: `Bearer ${token}`,
      body: "channel=C096V21TE0K",
    });
  });

  it("leaves a channel unresolved when Slack refuses the lookup", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () => Promise.resolve(Response.json({ ok: false, error: "channel_not_found" })),
    });
    await assert.rejects(
      () =>
        client.lookupChannelName?.({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C0BB3ESNU9W",
        }) ?? Promise.reject(new Error("channel lookup is missing")),
      /channel_not_found/u,
    );
  });

  it("lists user group names with the workspace bot token", async () => {
    const token = "xoxb-secret";
    let request: { url: string; authorization: string | null } | undefined;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve(token),
      fetch: async (input, init) => {
        request = {
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get("authorization"),
        };
        return Response.json({
          ok: true,
          usergroups: [{ id: "S097UJTSNH2", name: "plantao" }, { id: "S0000000000" }],
        });
      },
    });

    const names = await client.listUserGroupNames?.({ organizationId: "org-1", teamId: "T1" });

    assert.equal(names?.get("S097UJTSNH2"), "plantao");
    assert.equal(names?.has("S0000000000"), false);
    assert.deepEqual(request, {
      url: "https://slack.com/api/usergroups.list",
      authorization: `Bearer ${token}`,
    });
  });

  it("resolves the workspace token internally and checks Slack's ok field", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const authorities: Array<[string, string]> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: (organizationId, teamId) => {
        authorities.push([organizationId, teamId]);
        return Promise.resolve(
          organizationId === "org-1" && teamId === "T1" ? "xoxb-secret" : undefined,
        );
      },
      fetch: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Response.json({ ok: true });
      },
    });
    await client.sendMessage({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      content: "Hi",
    });
    assert.deepEqual(authorities, [["org-1", "T1"]]);
    assert.deepEqual(requests, [
      {
        url: "https://slack.com/api/chat.postMessage",
        authorization: "Bearer xoxb-secret",
        body: { channel: "C1", thread_ts: "1.1", text: "Hi" },
      },
    ]);

    const rejected = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () => Promise.resolve(Response.json({ ok: false, error: "ratelimited" })),
    });
    await assert.rejects(
      () =>
        rejected.addReaction({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "eyes",
        }),
      /Slack API ratelimited/u,
    );
  });

  it("fails closed without making a request when workspace ownership does not match", async () => {
    let fetches = 0;
    const client = createSlackBotClient({
      tokenForWorkspace: (organizationId, teamId) =>
        Promise.resolve(organizationId === "org-b" && teamId === "T1" ? "token-b" : undefined),
      fetch: () => {
        fetches += 1;
        return Promise.resolve(Response.json({ ok: true }));
      },
    });

    await assert.rejects(
      () =>
        client.removeReaction({
          organizationId: "org-a",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "eyes",
        }),
      /not connected/u,
    );
    assert.equal(fetches, 0);
  });

  it("aborts a Slack API call that does not respond before its deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      requestTimeoutMs: 5,
      fetch: (_input, init) => {
        const signal = init?.signal;
        assert(signal instanceof AbortSignal);
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await assert.rejects(
      () =>
        client.addReaction({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          messageTs: "1.1",
          name: "hourglass_flowing_sand",
        }),
      { name: "TimeoutError" },
    );
    assert.equal(requestSignal?.aborted, true);
  });

  it("keeps the root with the latest 49 preceding Slack replies, oldest first", async () => {
    const requests: Array<{ method: string; url: string; body: BodyInit | null | undefined }> = [];
    const messages = [
      { ts: "1700000000.000000", text: "root request", user: "UROOT" },
      ...Array.from({ length: 455 }, (_, index) => {
        const sequence = index + 1;
        return {
          ts: `1700000000.${String(sequence).padStart(6, "0")}`,
          text: `reply-${sequence}`,
          ...(sequence === 455 ? { bot_id: "B455" } : { user: `U${sequence}` }),
        };
      }),
    ];
    const pageSize = 100;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          url: requestUrl(input),
          body: init?.body,
        });
        const cursor = new URL(requestUrl(input)).searchParams.get("cursor");
        const page = cursor === null ? 0 : Number(cursor.replace("page-", ""));
        const current = messages.slice(page * pageSize, (page + 1) * pageSize);
        return Response.json({
          ok: true,
          messages: current,
          response_metadata:
            (page + 1) * pageSize < messages.length
              ? { next_cursor: `page-${page + 1}` }
              : { next_cursor: "" },
        });
      },
    });

    const hydrated = await client.readThreadMessages?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1700000000.000000",
      beforeTs: "1700000000.000456",
    });

    assert.equal(hydrated?.messages.length, 50);
    assert.equal(hydrated?.messages[0]?.content, "root request");
    assert.equal(hydrated?.messages[1]?.content, "reply-407");
    assert.equal(hydrated?.messages.at(-1)?.content, "reply-455");
    assert.deepEqual(hydrated?.messages.at(-1)?.author, { id: "B455" });
    assert.equal(hydrated?.complete, true);
    assert.equal(requests.length, 5);
    assert.deepEqual(
      requests.map(({ method, body }) => ({ method, body })),
      Array.from({ length: 5 }, () => ({ method: "GET", body: undefined })),
    );
    const firstRequest = new URL(requests[0]!.url);
    assert.equal(firstRequest.searchParams.get("channel"), "C1");
    assert.equal(firstRequest.searchParams.get("ts"), "1700000000.000000");
    assert.equal(firstRequest.searchParams.get("latest"), "1700000000.000456");
    assert.equal(firstRequest.searchParams.get("inclusive"), "false");
    assert.equal(firstRequest.searchParams.get("limit"), "100");
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).searchParams.get("cursor")),
      [null, "page-1", "page-2", "page-3", "page-4"],
    );
  });

  it("keeps earlier Slack replies when a later page is rate-limited", async () => {
    let requests = 0;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({
              ok: true,
              messages: [
                { ts: "1700000000.000000", text: "root request", user: "UROOT" },
                { ts: "1700000000.000001", text: "reply-1", user: "U1" },
                { ts: "1700000000.000002", text: "reply-2", user: "U2" },
              ],
              response_metadata: { next_cursor: "next-page" },
            })
          : Response.json({ ok: false, error: "ratelimited" });
      },
    });

    const hydrated = await client.readThreadMessages?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1700000000.000000",
      beforeTs: "1700000000.000003",
    });

    assert.deepEqual(
      hydrated?.messages.map((message) => message.content),
      ["root request", "reply-1", "reply-2"],
    );
    assert.equal(hydrated?.complete, false);
    assert.equal(requests, 2);
  });

  it("returns nothing when the forwarded conversation is closed", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async () => Response.json({ ok: false, error: "channel_not_found" }),
    });
    const message = await client.readSharedMessage?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C09QAPR0VT7",
      messageTs: "1700000000.000010",
    });

    assert.equal(message, undefined);
  });

  it("returns the source message when the bot is in that channel", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async () =>
        Response.json({
          ok: true,
          messages: [{ ts: "1700000000.000020", text: "Pessoal, boa tarde." }],
        }),
    });
    const message = await client.readSharedMessage?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C0BA6DKUQJJ",
      messageTs: "1700000000.000020",
    });

    assert.equal(
      typeof message === "object" && message !== null && "text" in message ? message.text : "",
      "Pessoal, boa tarde.",
    );
  });

  it("reads forwarded layers inside a thread reply", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            messages: [
              { ts: "1700000000.000000", text: "root", user: "UROOT" },
              {
                ts: "1700000000.000001",
                text: "",
                user: "U1",
                attachments: [
                  {
                    is_share: true,
                    author_name: "João",
                    text: "repassa",
                    attachments: [{ is_share: true, author_name: "Maria", text: "o problema" }],
                  },
                ],
              },
            ],
          }),
        ),
    });

    const hydrated = await client.readThreadMessages?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1700000000.000000",
      beforeTs: "1700000000.000002",
    });

    assert.equal(
      hydrated?.messages[1]?.content,
      "Encaminhada de João:\nrepassa\nEncaminhada de Maria:\no problema",
    );
  });

  it("rejects Slack thread context when the API omits its root", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            messages: [{ ts: "1700000000.000001", text: "reply-1", user: "U1" }],
          }),
        ),
    });
    await assert.rejects(
      () =>
        client.readThreadMessages!({
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000000",
          beforeTs: "1700000000.000002",
        }),
      /thread root unavailable/u,
    );
  });

  it("keeps Slack file credentials and private URLs inside the client", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      contentType: string | null;
      body: string | undefined;
    }> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        const url = requestUrl(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          body: requestBody(init?.body),
        });
        if (url.endsWith("files.info")) {
          return Response.json({
            ok: true,
            file: {
              id: "F1",
              url_private_download: "https://files.slack.com/files-pri/T1-F1/download/image.png",
            },
          });
        }
        return new Response("slack-image-bytes", {
          headers: { "content-type": "image/png", etag: '"file-1"' },
        });
      },
    });

    const response = await client.downloadAttachment?.({
      organizationId: "org-1",
      teamId: "T1",
      fileId: "F1",
    });

    assert.equal(await response?.text(), "slack-image-bytes");
    assert.deepEqual(requests, [
      {
        url: "https://slack.com/api/files.info",
        authorization: "Bearer xoxb-secret",
        contentType: "application/x-www-form-urlencoded",
        body: "file=F1",
      },
      {
        url: "https://files.slack.com/files-pri/T1-F1/download/image.png",
        authorization: "Bearer xoxb-secret",
        contentType: null,
        body: undefined,
      },
    ]);
  });

  it("sets and clears the status on an assistant thread", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Response.json({ ok: true });
      },
    });

    await client.setAssistantStatus?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      threadTs: "1729999327.187299",
      status: "is thinking...",
    });
    await client.setAssistantStatus?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      threadTs: "1729999327.187299",
      status: "",
    });

    assert.deepEqual(requests, [
      {
        url: "https://slack.com/api/assistant.threads.setStatus",
        body: {
          channel_id: "D1",
          thread_ts: "1729999327.187299",
          status: "is thinking...",
        },
      },
      {
        url: "https://slack.com/api/assistant.threads.setStatus",
        body: { channel_id: "D1", thread_ts: "1729999327.187299", status: "" },
      },
    ]);
  });

  it("posts with chat.postMessage when the token does not have assistant:write", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        const url = requestUrl(input);
        requests.push({
          url,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        if (url.endsWith("/assistant.threads.setStatus")) {
          return Response.json({ ok: false, error: "missing_scope", needed: "assistant:write" });
        }
        return Response.json({ ok: true });
      },
    });

    await client.setAssistantStatus?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      threadTs: "1729999327.187299",
      status: "is thinking...",
    });
    await client.sendMessage({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      threadTs: "1729999327.187299",
      content: "Pronto",
    });

    assert.equal(
      warn.mock.calls.some((call) => call[1] === "Slack token does not have assistant:write"),
      true,
    );
    assert.equal(JSON.stringify(warn.mock.calls).includes("xoxb-secret"), false);
    assert.deepEqual(requests[1], {
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "D1", thread_ts: "1729999327.187299", text: "Pronto" },
    });
    warn.mockRestore();
  });

  it("posts agent stream chunks as JSON and treats a warning as success", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (input, init) => {
        requests.push({
          url: requestUrl(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Response.json({
          ok: true,
          ts: "1729999328.000200",
          warning: "missing_agent_session_stopped_event_subscription",
        });
      },
    });

    const started = await client.startAgentStream?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1729999327.187299",
      taskDisplayMode: "plan",
      recipientUserId: "U1",
      recipientTeamId: "T1",
      chunks: [
        { type: "plan_update", title: "A tratar" },
        {
          type: "task_update",
          id: "read",
          title: "Reading the thread",
          status: "in_progress",
        },
      ],
    });
    const direct = await client.startAgentStream?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      threadTs: "1729999327.187299",
      taskDisplayMode: "timeline",
    });

    assert.equal(started?.ok, true);
    assert.equal(started?.warning, "missing_agent_session_stopped_event_subscription");
    assert.equal(direct?.ok, true);
    assert.deepEqual(requests[0], {
      url: "https://slack.com/api/chat.startStream",
      body: {
        channel: "C1",
        thread_ts: "1729999327.187299",
        task_display_mode: "plan",
        recipient_user_id: "U1",
        recipient_team_id: "T1",
        chunks: [
          { type: "plan_update", title: "A tratar" },
          { type: "task_update", id: "read", title: "Reading the thread", status: "in_progress" },
        ],
      },
    });
    assert.deepEqual(requests[1]?.body, {
      channel: "D1",
      thread_ts: "1729999327.187299",
      task_display_mode: "timeline",
    });
  });

  it("returns ok false from an agent session call instead of throwing", async () => {
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () => Promise.resolve(Response.json({ ok: false, error: "missing_scope" })),
    });
    const result = await client.setAgentSessionStatus?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1729999327.187299",
      status: "processing",
      title: "Pedido",
    });
    assert.deepEqual(result, { ok: false, error: "missing_scope" });
  });

  it("sets suggested prompts without a thread timestamp", async () => {
    let body: unknown;
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: async (_input, init) => {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Response.json({ ok: true });
      },
    });
    await client.setSuggestedPrompts?.({
      organizationId: "org-1",
      teamId: "T1",
      channelId: "D1",
      title: "Next",
      prompts: [{ title: "Status", message: "What is the status?" }],
    });
    assert.deepEqual(body, {
      channel_id: "D1",
      title: "Next",
      prompts: [{ title: "Status", message: "What is the status?" }],
    });
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function requestBody(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}
