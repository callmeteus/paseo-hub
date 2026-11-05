import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createAttachmentCapabilityRegistry } from "../../attachments/capabilities.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import {
  createSlackBotClient,
  type SlackBotClient,
  type SlackThreadMessage,
  type SlackThreadReadResult,
} from "./client.js";
import { normalizeSlackEvent } from "./events.js";
import { createSlackTriggerProvider } from "./provider.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";

describe("Slack Phase 1 trigger provider", () => {
  it("explains a monthly execution denial in the originating thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T23:00:00Z"));
    try {
      const database = createMemoryDatabase();
      const { project, revision, store } = await createActiveProjectConfiguration(
        database,
        configuration(),
        { organizationId: "org-1" },
      );
      const client = new RecordingSlackClient();
      const provider = createSlackTriggerProvider({
        configurationStoreForProject: () => store,
        botUserIdForWorkspace: () => Promise.resolve("UBOT"),
        client,
        billingUrlForOrganization: async () => "https://hub.paseo.sh/o/acme/settings/billing",
      });
      const match = (await provider.match(external(project.id, revision.id)))[0];
      if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
      await provider.onAgentExecutionFailed?.(
        match.triggerContext,
        match.outputContext,
        JSON.stringify({
          error: "entitlement_denied",
          entitlement: "executions.monthly",
          kind: "meter",
          limit: 50,
          current: 236,
        }),
      );
      assert.equal(
        client.messages[0]?.content,
        "This org has used its 50 free runs for September. Runs reset on October 1, or upgrade to Pro under Billing: https://hub.paseo.sh/o/acme/settings/billing",
      );
      assert.equal(client.messages[0]?.threadTs, "1700000000.000001");
    } finally {
      vi.useRealTimers();
    }
  });
  it("accepts the explicit wildcard without a pointless username lookup", async () => {
    const database = createMemoryDatabase();
    const wildcard = configuration();
    wildcard.triggers[0]!.filters.from_users = ["*"];
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      wildcard,
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });

    const matched = await provider.match(
      external(project.id, revision.id, { authorId: "U-ANYONE" }),
    );

    assert.notEqual(typeof matched, "string");
    assert.deepEqual(client.userLookups, []);
  });

  it("resolves the authored Slack username once before matching", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      usernameConfiguration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient({ username: "operator" });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });

    const matched = await provider.match(external(project.id, revision.id));
    assert.notEqual(typeof matched, "string");
    assert.deepEqual(client.userLookups, ["U1"]);

    const rejected = await createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient({ username: "someone-else" }),
    }).match(external(project.id, revision.id));
    assert.equal(rejected, "trigger_filters_rejected");
  });

  it("normalizes typed inputs identically at the provider boundary", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const match = (
      await provider.match(
        external(project.id, revision.id, { content: "<@UBOT> repo=hub agent=opus investigate" }),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: "<@UBOT> repo=hub agent=opus investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("parses typed inputs after a matched command marker", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputMarkerConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const match = (
      await provider.match(
        external(project.id, revision.id, { content: "<@UBOT> run repo=hub investigate" }),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.invocation.prompt, "<@UBOT> run repo=hub investigate");
    assert.equal(match.invocation.inputs["repo"], "hub");
  });

  it("preserves the complete message when the mention is last", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const prompt = "Do the whole thing first <@UBOT>";

    const match = (await provider.match(external(project.id, revision.id, { content: prompt })))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.invocation.prompt, prompt);
  });

  it("uses exact input filters to select one configured trigger", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputFilterFanoutConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, { content: "<@UBOT> repo=hub investigate" }),
    );
    if (typeof matches === "string") throw new Error("expected matches");

    assert.deepEqual(
      matches.map((match) => match.triggerName),
      ["hub-only"],
    );
  });

  it("matches the literal step and preserves the message reply target", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.configurationRevisionId, revision.id);
    assert.equal(match.outputContext.threadTs, "1700000000.000001");
    assert.equal(match.outputContext.messageTs, "1700000000.000001");
  });

  it("does not add a Slack reaction while the agent runs", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(client.reactions, []);
    assert.deepEqual(client.statuses, []);
  });

  it("shows a short status while an assistant thread runs and clears it when the run finishes", async () => {
    const database = createMemoryDatabase();
    const base = configuration();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        ...base,
        triggers: [
          {
            ...base.triggers[0]!,
            on: "slack.message",
            filters: { workspace: "T1", from_users: ["U1"] },
          },
        ],
      },
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const payload = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: "Ev-assistant",
      event_time: 1_729_999_328,
      event: {
        type: "message",
        user: "U1",
        channel: "D1",
        channel_type: "im",
        text: "qual o estado?",
        ts: "1729999328.000100",
        thread_ts: "1729999327.187299",
        event_ts: "1729999328.000100",
      },
    });
    if (payload === undefined) throw new Error("expected an assistant message");
    const match = (
      await provider.match({
        ...external(project.id, revision.id),
        source: "slack.message",
        payload,
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.equal(match.outputContext.channelId, "D1");
    assert.equal(match.outputContext.threadTs, "1729999327.187299");
    assert.equal(match.triggerContext.event.slack.assistant_thread, true);
    assert.deepEqual(match.triggerContext.event.slack.trigger_message.thread, {
      ts: "1729999327.187299",
    });

    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");

    assert.deepEqual(client.statuses, [
      { channelId: "D1", threadTs: "1729999327.187299", status: "is thinking..." },
      { channelId: "D1", threadTs: "1729999327.187299", status: "" },
      { channelId: "D1", threadTs: "1729999327.187299", status: "" },
    ]);
    assert.equal(client.messages[0]?.threadTs, "1729999327.187299");
    assert.equal(client.messages[0]?.channelId, "D1");
    assert.match(client.messages[0]?.content ?? "", /boom/u);
  });

  it("keeps a root Slack mention as the reply thread root", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const match = (await provider.match(external(project.id, revision.id, { threadTs: null })))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.triggerContext.event.slack.trigger_message.thread, null);
    assert.equal(match.triggerContext.event.slack.bot.id, "UBOT");
    assert.equal(match.outputContext.threadTs, match.outputContext.messageTs);
    const reply = (
      await provider.match(external(project.id, revision.id, { messageTs: "1700000000.000002" }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(reply)) throw new Error("expected accepted reply");
    assert.ok(match.conversation);
    assert.equal(reply.conversation?.key, match.conversation.key);

    assert.equal(
      match.triggerContext.event.slack.trigger_message.created_at,
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("targets Slack failure output at the originating message thread", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");
    assert.deepEqual(client.reactions, []);
    assert.deepEqual(client.messages, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content: "Paseo agent failed: boom",
      },
    ]);
  });

  it("propagates a Slack failure notice without adding a reaction", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const noticeFailure = new RecordingSlackClient({ failMessages: true });
    const noticeProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: noticeFailure,
    });
    await assert.rejects(async () => {
      await noticeProvider.onAgentExecutionFailed!(
        match.triggerContext,
        match.outputContext,
        "boom",
      );
    }, /slack message failed/u);
    assert.deepEqual(noticeFailure.reactions, []);
  });

  it("defers routed thread hydration until context materialization", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient({
      threadMessages: Array.from({ length: 55 }, (_, index) => ({
        ts: `1700000000.${String(index + 1).padStart(6, "0")}`,
        createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        content: `reply-${index + 1}`,
        author: { id: index === 54 ? "B1" : `U${index + 1}` },
        attachments: [],
      })).slice(5),
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });

    const threadMatch = (
      await provider.match(external(project.id, revision.id, { messageTs: "1700000000.000056" }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(threadMatch)) throw new Error("expected accepted match");
    assert.deepEqual(client.threadReads, []);
    assert.deepEqual(threadMatch.triggerContext.event.slack.trigger_thread_context, {
      status: "deferred",
      channel: { id: "C1" },
      thread: { ts: "1700000000.000001" },
      before: { ts: "1700000000.000056" },
    });
    const context = await provider.materializeContext!({
      executionId: "execution-slack-history",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: threadMatch.triggerContext,
    });
    assert.equal(client.threadReads.length, 1);
    assert.equal(context?.slack.thread.status, "available");
    assert.equal(context?.slack.thread.messages.length, 50);
    assert.equal(context?.slack.thread.messages[0]?.content, "reply-6");
    assert.equal(context?.slack.thread.messages.at(-1)?.author.id, "B1");

    const rootMatch = (
      await provider.match(external(project.id, revision.id, { threadTs: null }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(rootMatch)) throw new Error("expected accepted match");
    const rootContext = await provider.materializeContext!({
      executionId: "execution-slack-root",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: rootMatch.triggerContext,
    });
    assert.equal(rootContext?.slack.thread.status, "available");
    assert.equal(rootContext?.slack.thread.messages[0]?.content, "<@UBOT> deploy now");
    assert.equal(
      rootContext?.slack.thread.messages.some((message) => message.content === "reply-6"),
      true,
    );
    assert.deepEqual(client.threadReads, [
      "1700000000.000001",
      "1700000000.000001:after:1700000000.000001",
    ]);
  });

  it("follows a forward into a channel the bot can read and keeps the private copy", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const attachments = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      resolvers: {},
    });
    const client = new RecordingSlackClient({
      sharedMessages: {
        "1700000000.000020": {
          text: "Pessoal, boa tarde.",
          attachments: [
            {
              is_share: true,
              author_name: "André",
              channel_id: "C09QAPR0VT7",
              ts: "1700000000.000010",
              text: "os títulos não foram liberados",
              files: [{ id: "F1", name: "planilha.png", mimetype: "image/png", size: 10 }],
            },
          ],
        },
      },
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
      attachments,
    });
    const received = external(project.id, revision.id, {
      threadTs: null,
      content: "<@UBOT> resumo",
    });
    const match = (
      await provider.match({
        ...received,
        connectionId: "22222222-2222-4222-8222-222222222222",
        payload: {
          ...received.payload,
          lead: "<@UBOT>",
          forwards: [{ channelId: "C0BA6DKUQJJ", messageTs: "1700000000.000020" }],
        },
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    assert.equal(
      match.triggerContext.event.slack.trigger_message.content,
      "<@UBOT>\n\nPessoal, boa tarde.\n\nEncaminhada de André:\nos títulos não foram liberados",
    );
    assert.deepEqual(client.sharedReads, ["C0BA6DKUQJJ", "C09QAPR0VT7"]);
    const context = await provider.materializeContext!({
      executionId: "execution-slack-forward",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });
    assert.equal(context?.slack.thread.messages[0]?.attachments[0]?.filename, "planilha.png");
    assert.match(
      context?.slack.thread.messages[0]?.attachments[0]?.url ?? "",
      /execution-slack-forward/u,
    );
  });

  it("exposes thread messages and execution-scoped attachments only through context", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const attachments = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      resolvers: {},
    });
    const client = new RecordingSlackClient({
      threadMessages: [
        {
          ts: "1700000000.000000",
          createdAt: "2023-11-14T22:13:19.000Z",
          content: "earlier screenshot",
          author: { id: "U2" },
          attachments: [
            {
              id: "F1",
              filename: "screen.png",
              contentType: "image/png",
              size: 42,
            },
          ],
        },
      ],
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
      attachments,
    });
    const match = (
      await provider.match({
        ...external(project.id, revision.id),
        connectionId: "22222222-2222-4222-8222-222222222222",
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(
      await database.findAttachmentBySource("11111111-1111-4111-8111-111111111119", "slack", "F1"),
      undefined,
    );
    assert.deepEqual(match.triggerContext.event.slack.trigger_message.attachments, []);
    assert.equal(JSON.stringify(match.triggerContext).includes("agent-executions"), false);
    const context = await provider.materializeContext!({
      executionId: "execution-slack-context",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });
    const attachment = await database.findAttachmentBySource(
      "11111111-1111-4111-8111-111111111119",
      "slack",
      "F1",
    );
    assert.ok(attachment);

    assert.deepEqual(context, {
      slack: {
        thread: {
          status: "available",
          messages: [
            {
              ts: "1700000000.000000",
              content: "earlier screenshot",
              author: { id: "U2" },
              channel: { id: "C1" },
              created_at: "2023-11-14T22:13:19.000Z",
              attachments: [
                {
                  id: attachment.id,
                  filename: "screen.png",
                  content_type: "image/png",
                  size: 42,
                  url: attachments.urlFor(attachment.id, "execution-slack-context"),
                },
              ],
            },
          ],
        },
      },
    });
    const secondContext = await provider.materializeContext!({
      executionId: "execution-slack-context-2",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });
    const firstUrl = context?.slack.thread.messages[0]?.attachments[0]?.url;
    const secondUrl = secondContext?.slack.thread.messages[0]?.attachments[0]?.url;
    assert.ok(firstUrl);
    assert.ok(secondUrl);
    assert.notEqual(firstUrl, secondUrl);
    assert.match(secondUrl, /execution-slack-context-2/u);
  });

  it("distinguishes an unavailable Slack thread from an empty hydrated thread", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient({ failThreadRead: true }),
    });
    const emptyProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const emptyMatch = (await emptyProvider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(emptyMatch)) throw new Error("expected accepted match");
    const emptyContext = await emptyProvider.materializeContext!({
      executionId: "execution-slack-empty",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: emptyMatch.triggerContext,
    });
    assert.deepEqual(emptyContext, {
      slack: { thread: { status: "available", messages: [] } },
    });

    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.triggerContext.event.slack.trigger_thread_context, {
      status: "deferred",
      channel: { id: "C1" },
      thread: { ts: "1700000000.000001" },
      before: { ts: "1700000000.000001" },
    });
    const context = await provider.materializeContext!({
      executionId: "execution-slack-unavailable",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });
    assert.deepEqual(context, {
      slack: { thread: { status: "unavailable", messages: [] } },
    });
  });

  it("marks partially traversed Slack history incomplete", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient({
      threadMessages: [
        {
          ts: "1700000000.000000",
          createdAt: "2023-11-14T22:13:19.000Z",
          content: "partial history",
          author: { id: "U2" },
          attachments: [],
        },
      ],
      threadComplete: false,
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const context = await provider.materializeContext!({
      executionId: "execution-slack-partial",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });
    assert.equal(context.slack.thread.status, "incomplete");
    assert.equal(context.slack.thread.messages.length, 1);
  });

  it("caps Slack history traversal while retaining the root and newest 49 messages", async () => {
    const maximumPageCount = 10;
    const messagesPerPage = 100;
    let requests = 0;
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = createSlackBotClient({
      tokenForWorkspace: () => Promise.resolve("xoxb-secret"),
      fetch: () => {
        requests += 1;
        if (requests > maximumPageCount) {
          throw new Error("Slack history traversal exceeded its request ceiling");
        }
        const firstSequence = (requests - 1) * messagesPerPage + 1;
        return Promise.resolve(
          Response.json({
            ok: true,
            messages: Array.from({ length: messagesPerPage }, (_, index) => {
              const sequence = firstSequence + index;
              return {
                ts: `1700000000.${String(sequence).padStart(6, "0")}`,
                text: `reply-${sequence}`,
                user: `U${sequence}`,
              };
            }),
            response_metadata: { next_cursor: `page-${requests + 1}` },
          }),
        );
      },
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (
      await provider.match(external(project.id, revision.id, { messageTs: "1700000000.999999" }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const context = await provider.materializeContext!({
      executionId: "execution-slack-page-cap",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });

    assert.equal(requests, maximumPageCount);
    assert.equal(context.slack.thread.status, "incomplete");
    assert.deepEqual(
      context.slack.thread.messages.map((message) => message.content),
      ["reply-1", ...Array.from({ length: 49 }, (_, index) => `reply-${952 + index}`)],
    );
  });

  it("does not require attachment capability during Slack ingestion", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const match = (
      await provider.match({
        ...external(project.id, revision.id),
        connectionId: null,
        payload: {
          ...external(project.id, revision.id).payload,
          attachments: [
            {
              id: "F1",
              filename: "screen.png",
              contentType: "image/png",
              size: 42,
            },
          ],
        },
      })
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.triggerContext.event.slack.trigger_message.attachments, [
      { id: "F1", filename: "screen.png", content_type: "image/png", size: 42 },
    ]);
  });

  it("does not hydrate an unrouted Slack thread", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const matches = await provider.match(external(project.id, revision.id, { authorId: "U2" }));
    assert.equal(matches, "trigger_filters_rejected");
    assert.deepEqual(client.threadReads, []);
  });
});

function configuration() {
  return {
    environments: [{ name: "slack-runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"] },
        steps: [
          {
            id: "slack-step",
            environment: "slack-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "test", mode: "full-access" },
            prompt: [{ text: "Handle the Slack mention." }],
            allow_outputs: [{ type: "slack.reply" }],
          },
        ],
      },
    ],
  };
}

function usernameConfiguration() {
  const base = configuration();
  return {
    ...base,
    triggers: [
      {
        ...base.triggers[0]!,
        filters: { ...base.triggers[0]!.filters, from_users: ["operator"] },
      },
    ],
  };
}

function inputConfiguration() {
  const base = configuration();
  const trigger = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      {
        ...trigger,
        inputs: {
          repo: { type: "string", choices: ["paseo", "hub"] },
          agent: { type: "string", default: "codex", choices: ["codex", "opus"] },
        },
        filters: { ...trigger.filters, inputs: { repo: "hub" } },
        steps: [
          {
            ...trigger.steps[0]!,
            agent: { provider: "codex", mode: "full-access" },
            prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
          },
        ],
      },
    ],
  };
}

function inputFilterFanoutConfiguration() {
  const base = inputConfiguration();
  const first = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      { ...first, name: "hub-only" },
      { ...first, name: "paseo-only", filters: { ...first.filters, inputs: { repo: "paseo" } } },
    ],
  };
}

function inputMarkerConfiguration() {
  const base = inputConfiguration();
  const trigger = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      {
        ...trigger,
        filters: { ...trigger.filters, pattern: "run", regex: ["<@UBOT> run(?!\\S)"] },
      },
    ],
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  overrides: {
    threadTs?: string | null;
    messageTs?: string;
    content?: string;
    authorId?: string;
  } = {},
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org-1",
    projectId,
    configurationRevisionId,
    source: "slack.mention",
    deliveryId: "slack-delivery-1",
    receivedAt: new Date(),
    payload: {
      type: "mention",
      id: "Ev1",
      teamId: "T1",
      appId: "A1",
      channelId: "C1",
      messageTs: overrides.messageTs ?? "1700000000.000001",
      threadTs: overrides.threadTs === undefined ? "1700000000.000001" : overrides.threadTs,
      eventTs: "1700000000.000001",
      eventTime: 1_700_000_001,
      content: overrides.content ?? "<@UBOT> deploy now",
      author: { id: overrides.authorId ?? "U1" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
      attachments: [],
    },
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: string[] = [];
  statuses: Array<{ channelId: string; threadTs: string; status: string }> = [];
  messages: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }> = [];
  threadReads: string[] = [];
  sharedReads: string[] = [];
  userLookups: string[] = [];
  private readonly threadMessages: SlackThreadMessage[];

  constructor(
    private readonly options: {
      threadMessages?: SlackThreadMessage[];
      failAddReaction?: string;
      failMessages?: boolean;
      failThreadRead?: boolean;
      threadComplete?: boolean;
      username?: string;
      sharedMessages?: Record<string, unknown>;
    } = {},
  ) {
    this.threadMessages = options.threadMessages ?? [];
  }

  setAssistantStatus(input: {
    channelId: string;
    threadTs: string;
    status: string;
  }): Promise<void> {
    this.statuses.push({
      channelId: input.channelId,
      threadTs: input.threadTs,
      status: input.status,
    });
    return Promise.resolve();
  }

  sendMessage(input: (typeof this.messages)[number]): Promise<void> {
    this.messages.push(input);
    if (this.options.failMessages === true)
      return Promise.reject(new Error("slack message failed"));
    return Promise.resolve();
  }

  addReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:add:${input.name}`);
    if (this.options.failAddReaction === input.name)
      return Promise.reject(new Error("slack add reaction failed"));
    return Promise.resolve();
  }

  removeReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:remove:${input.name}`);
    return Promise.resolve();
  }
  lookupUserName(input: { userId: string }): Promise<string | undefined> {
    this.userLookups.push(input.userId);
    return Promise.resolve(this.options.username);
  }
  readSharedMessage(input: { messageTs: string; channelId: string }): Promise<unknown> {
    this.sharedReads.push(input.channelId);
    return Promise.resolve(this.options.sharedMessages?.[input.messageTs]);
  }
  readThreadMessages(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
    afterTs?: string;
  }): Promise<SlackThreadReadResult> {
    this.threadReads.push(
      input.afterTs === undefined ? input.threadTs : `${input.threadTs}:after:${input.afterTs}`,
    );
    if (this.options.failThreadRead === true) {
      return Promise.reject(new Error("thread history unavailable"));
    }
    const afterTs = input.afterTs;
    const messages =
      afterTs === undefined
        ? this.threadMessages
        : this.threadMessages.filter((message) => Number(message.ts) > Number(afterTs));
    return Promise.resolve({
      complete: this.options.threadComplete ?? true,
      messages,
    });
  }
}
