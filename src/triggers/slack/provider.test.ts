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
import { resetSlackAgentSurfaceForTests } from "./agent-surface.js";
import { normalizeSlackEvent } from "./events.js";
import { slackChoiceArrival } from "./feedback.js";
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

  it("sends a plan decision to the same thread without the message filters", async () => {
    const database = createMemoryDatabase();
    const base = inputConfiguration();
    const trigger = base.triggers[0]!;
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        ...base,
        triggers: [
          {
            ...trigger,
            filters: { ...trigger.filters, pattern: "ALERTA" },
            steps: [
              {
                ...trigger.steps[0]!,
                slack_agent: { display: "plan", feedback: true },
              },
            ],
          },
        ],
      },
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const sentence = slackChoiceArrival({ label: "Ship it", value: "ship" });
    const match = (
      await provider.match(
        external(project.id, revision.id, { content: sentence, planDecision: "ship" }),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.invocation.prompt, sentence);
    assert.deepEqual(match.invocation.inputs, { agent: "codex" });
    assert.equal(
      match.conversation?.key,
      JSON.stringify(["slack", "T1", "C1", "1700000000.000001"]),
    );
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
            filters: { workspace: "T1", from_users: ["U1"], direct_messages: true },
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
    assert.equal(
      client.messages[0]?.content,
      "I hit a problem and stopped before finishing. Mention me again to retry.",
    );
  });

  it("opens an agent session when the step opts in and leaves the legacy status alone", async () => {
    resetSlackAgentSurfaceForTests();
    const database = createMemoryDatabase();
    const base = configuration();
    const trigger = base.triggers[0]!;
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        ...base,
        triggers: [
          {
            ...trigger,
            steps: [
              {
                ...trigger.steps[0]!,
                slack_agent: { display: "plan", session_title: "Pedido" },
              },
            ],
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
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.outputContext.slackAgent?.session_title, "Pedido");

    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });

    assert.deepEqual(client.statuses, []);
    assert.deepEqual(
      client.agentSessions.map((call) => ({ status: call.status, title: call.title })),
      [
        { status: "processing", title: "Pedido" },
        { status: "active", title: undefined },
      ],
    );
  });

  it("does not open the Slack session at acceptance when the agent step is behind a condition", async () => {
    resetSlackAgentSurfaceForTests();
    const database = createMemoryDatabase();
    const base = configuration();
    const trigger = base.triggers[0]!;
    const step = trigger.steps[0]!;
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        ...base,
        triggers: [
          {
            ...trigger,
            steps: [
              {
                ...step,
                output: {
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind"],
                    properties: { kind: { type: "string" } },
                  },
                },
              },
              {
                ...step,
                id: "compile",
                if: "${{ steps.slack-step.outputs.kind == 'deploy' }}",
                slack_agent: { display: "timeline", session_title: "Deploy" },
              },
            ],
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
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.outputContext.slackAgent, undefined);

    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);

    assert.deepEqual(client.agentSessions, []);
    assert.deepEqual(client.statuses, []);
  });

  it("keeps the legacy status when the agent session API refuses the token", async () => {
    resetSlackAgentSurfaceForTests();
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
            filters: { workspace: "T1", from_users: ["U1"], direct_messages: true },
            steps: [
              {
                ...base.triggers[0]!.steps[0]!,
                slack_agent: { display: "timeline" },
              },
            ],
          },
        ],
      },
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient({ agentStatusError: "missing_scope" });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const payload = normalizeSlackEvent({
      type: "event_callback",
      team_id: "T1",
      api_app_id: "A1",
      event_id: "Ev-agent-fallback",
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

    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });

    assert.deepEqual(client.statuses, [
      { channelId: "D1", threadTs: "1729999327.187299", status: "is thinking..." },
      { channelId: "D1", threadTs: "1729999327.187299", status: "" },
    ]);
    assert.equal(client.agentSessions[0]?.status, "processing");
    assert.equal(client.agentSessions.length, 1);
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
        content: "I hit a problem and stopped before finishing. Mention me again to retry.",
      },
    ]);

    const stopped = new RecordingSlackClient();
    const stoppedProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: stopped,
    });
    await stoppedProvider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "stopped_by_user",
    );
    assert.deepEqual(stopped.messages, []);

    const interrupted = new RecordingSlackClient();
    const interruptedProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: interrupted,
    });
    await interruptedProvider.onAgentExecutionFailed?.(
      match.triggerContext,
      match.outputContext,
      "agent_interrupted",
    );
    assert.deepEqual(interrupted.messages, []);
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

    assert.deepEqual(context.slack.thread, {
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
    });
    assert.deepEqual(context.slack.trigger_message, {
      ts: "1700000000.000001",
      thread: { ts: "1700000000.000001" },
      text: "<@UBOT> deploy now",
      author: { id: "U1" },
    });
    assert.equal(context.slack.event_type, "app_mention");
    assert.equal(context.slack.direct_message, undefined);
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
    assert.deepEqual(emptyContext.slack.thread, { status: "available", messages: [] });
    assert.deepEqual(emptyContext.slack.trigger_message, {
      ts: "1700000000.000001",
      thread: { ts: "1700000000.000001" },
      text: "<@UBOT> deploy now",
      author: { id: "U1" },
    });
    assert.equal(emptyContext.slack.event_type, "app_mention");

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
    assert.deepEqual(context.slack.thread, { status: "unavailable", messages: [] });
    assert.deepEqual(context.slack.trigger_message, {
      ts: "1700000000.000001",
      thread: { ts: "1700000000.000001" },
      text: "<@UBOT> deploy now",
      author: { id: "U1" },
    });
    assert.equal(context.slack.event_type, "app_mention");
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

  it("names the person who triggered the run in the materialized context", async () => {
    const database = createMemoryDatabase();
    const base = configuration();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        ...base,
        triggers: [
          {
            ...base.triggers[0]!,
            filters: { ...base.triggers[0]!.filters, from_users: ["U0BK255SFKL"] },
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
    const match = (
      await provider.match(external(project.id, revision.id, { authorId: "U0BK255SFKL" }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const context = await provider.materializeContext!({
      executionId: "execution-slack-author",
      organizationId: "org-1",
      projectId: project.id,
      providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
      triggerContext: match.triggerContext,
    });

    assert.equal(context.slack.trigger_message.author.id, "U0BK255SFKL");
    assert.equal(context.slack.trigger_message.ts, "1700000000.000001");
    assert.deepEqual(context.slack.trigger_message.thread, { ts: "1700000000.000001" });
    assert.equal(context.slack.trigger_message.text, "<@UBOT> deploy now");
    assert.equal(context.slack.event_type, "app_mention");
    assert.equal(context.slack.direct_message, undefined);
  });

  it("posts the machine termination notice without the raw reason", async () => {
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

    const terminated = await provider.onMachineTerminated?.(
      match.triggerContext,
      "launch_failed",
      undefined,
    );
    assert.equal(terminated, null);
    assert.deepEqual(client.messages, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content: "I could not start because the machine that runs me is offline.",
      },
    ]);

    const disconnectedProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    await disconnectedProvider.onMachineTerminated?.(
      match.triggerContext,
      "daemon_disconnected",
      undefined,
    );
    const completedProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const completed = await completedProvider.onMachineTerminated?.(
      match.triggerContext,
      "completed",
      undefined,
    );
    assert.equal(completed, undefined);
  });

  it("posts the notice in the trigger locale", async () => {
    const database = createMemoryDatabase();
    const base = configuration();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      { ...base, triggers: [{ ...base.triggers[0]!, locale: "pt-BR" }] },
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
    assert.equal(match.outputContext.locale, "pt-BR");

    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");
    assert.deepEqual(client.messages, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content:
          "Tive um problema e parei antes de terminar. Me marque de novo para tentar outra vez.",
      },
    ]);
  });

  it("evaluates only interruption filters for a thread signal", async () => {
    const base = configuration();
    const signalTrigger = {
      ...base.triggers[0]!,
      name: "thread-signal",
      on: "slack.thread_signal",
      filters: {
        workspace: "T1",
        channels: ["C1"],
        from_users: ["*"],
        include_bots: true,
        interrupt_active_thread_execution: true,
        text: ["another answer"],
      },
    };
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      { ...base, triggers: [base.triggers[0]!, signalTrigger] },
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const event = {
      providerEventReceiptId: "11111111-1111-4111-8111-111111111120",
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      resourceId: "T1",
      source: "slack.thread_signal",
      deliveryId: "slack-signal-Ev9",
      receivedAt: new Date("2026-11-25T13:23:00Z"),
      payload: {
        type: "message",
        channelId: "C1",
        channelType: "channel",
        threadTs: "1795611989.216289",
        messageTs: "1795612980.000001",
        text: "An agent gave another answer",
        authorId: "UBOT2",
        fromBot: true,
      },
    };
    const result = await provider.match(event);
    if (typeof result === "string") throw new Error(`signal was dropped: ${result}`);
    assert.deepEqual(
      result.map((match) => match.triggerName),
      ["thread-signal"],
    );
    const match = result[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("signal must be accepted");
    assert.equal(match.triggerName, "thread-signal");
    assert.equal(match.interruptOnly, true);
    assert.equal(match.conversation?.key, '["slack","T1","C1","1795611989.216289"]');
  });

  it("applies configured lifecycle reactions on start and completion", async () => {
    const base = configuration();
    const step: Record<string, unknown> = base.triggers[0]!.steps[0]!;
    step["slack_agent"] = {
      display: "timeline",
      lifecycle_reactions: { on_start: "eyes", on_finish: "white_check_mark" },
    };
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, base, {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const result = await provider.match(external(project.id, revision.id));
    const match = result[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });

    assert.deepEqual(client.reactions, ["org-1:T1:add:eyes", "org-1:T1:add:white_check_mark"]);
  });

  it("does not apply on_finish when the execution fails", async () => {
    const base = configuration();
    const step: Record<string, unknown> = base.triggers[0]!.steps[0]!;
    step["slack_agent"] = {
      display: "timeline",
      lifecycle_reactions: { on_finish: "white_check_mark" },
    };
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, base, {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
      billingUrlForOrganization: async () => "https://hub.test/billing",
    });
    const result = await provider.match(external(project.id, revision.id));
    const match = result[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");

    assert.deepEqual(client.reactions, []);
  });

  it("applies on_failure only when the execution fails", async () => {
    const base = configuration();
    const step: Record<string, unknown> = base.triggers[0]!.steps[0]!;
    step["slack_agent"] = {
      display: "timeline",
      lifecycle_reactions: { on_finish: "eyes", on_failure: "warning" },
    };
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, base, {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
      billingUrlForOrganization: async () => "https://hub.test/billing",
    });
    const result = await provider.match(external(project.id, revision.id));
    const match = result[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(client.reactions, ["org-1:T1:add:eyes"]);

    client.reactions.length = 0;
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");
    assert.deepEqual(client.reactions, ["org-1:T1:add:warning"]);
  });

  it("matches a newer thread message against the configured reply guard", async () => {
    const client = new RecordingSlackClient({
      threadMessages: [
        {
          ts: "1700000010.000001",
          author: { id: "U2" },
          content: "The customer confirmed and closed the case",
          createdAt: "2026-01-01T00:00:10Z",
          attachments: [],
        },
      ],
      threadComplete: true,
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("not used");
      },
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const database = createMemoryDatabase();
    const id = "00000000-0000-4000-8000-0000000000f5";
    await database.insertAgentExecution({
      id,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      daemonId: "d",
      triggerContext: {
        provider: "slack",
        target: {
          provider: "slack",
          organizationId: "org-1",
          teamId: "T1",
          channelId: "C1",
          threadTs: "1700000000.000001",
          messageTs: "1700000000.000001",
        },
        event: {
          slack: {
            trigger_message: {
              ts: "1700000000.000001",
              channel: { id: "C1" },
              thread: { ts: "1700000000.000001" },
              author: { id: "U1" },
            },
            team: { id: "T1" },
          },
        },
      },
      outputContext: { provider: "slack", organizationId: "org-1", teamId: "T1" },
      configurationRevisionId: "r",
    });
    const execution = (await database.findAgentExecutionById(id))!;
    execution.launchIntent = {
      kind: "launch_machine",
      organizationId: "org-1",
      projectId: "project-1",
      triggerRunId: "run",
      triggerName: "slack-run",
      environmentName: "env",
      environment: { kind: "daemon", daemonId: "d", authoredSlug: "env", cwd: "/repo" },
      prompt: "reply",
      agent: { provider: "codex", mode: "full-access" },
      allowOutputs: [],
      autoArchive: false,
      background: false,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      configurationRevisionId: "r",
      hubConfig: { environments: [], triggers: [] },
      replyGuard: { matchesRegex: "confirmed and closed" },
    };

    assert.deepEqual(await provider.checkReplyGuard?.({ execution }), { matched: true });
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
    planDecision?: string;
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
      type: overrides.planDecision === undefined ? "mention" : "message",
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
      ...(overrides.planDecision === undefined ? {} : { planDecision: overrides.planDecision }),
      createdAt: new Date(1_700_000_000_000).toISOString(),
      attachments: [],
    },
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: string[] = [];
  statuses: Array<{ channelId: string; threadTs: string; status: string }> = [];
  agentSessions: Array<{ status: string; title?: string | undefined }> = [];
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
      agentStatusError?: string;
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

  setAgentSessionStatus(input: { status: string; title?: string | undefined }): Promise<{
    ok: boolean;
    error?: string;
  }> {
    this.agentSessions.push({ status: input.status, title: input.title });
    if (this.options.agentStatusError !== undefined) {
      return Promise.resolve({ ok: false, error: this.options.agentStatusError });
    }
    return Promise.resolve({ ok: true });
  }

  renameAgentSession(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  startAgentStream(): Promise<{ ok: boolean; ts: string }> {
    return Promise.resolve({ ok: true, ts: "1.2" });
  }

  appendAgentStream(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  stopAgentStream(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  setSuggestedPrompts(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
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
