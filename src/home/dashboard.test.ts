import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { buildLaunchMachineIntent } from "../dispatcher/index.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import {
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import type { SlackNameDirectory } from "../triggers/slack/client.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { HomeDashboard } from "./dashboard.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const APPS_CONFIGURED = () => true;
const request = new Request("https://hub.test/o/acme/home");

describe("home read model", () => {
  it("describes a fresh organization as nothing connected and nothing run", async () => {
    const database = memberDatabase({ slack: false });
    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, true);
    assert.deepEqual(snapshot.connections, []);
    assert.deepEqual(snapshot.daemons, []);
    assert.deepEqual(snapshot.triggers, []);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(snapshot.unrouted, []);
    assert.deepEqual(snapshot.unroutedEvents, []);
    assert.equal(snapshot.windowDays, 7);
  });

  it("reads daemons with whether they can run agents, triggers with their event, and recent runs with the agent that ran", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    await enrollConnectedOnlyDaemon(database);
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });
    await recordRun(database, trigger.runtimeProjectId, "first", "succeeded", 120_000);
    await recordRun(database, trigger.runtimeProjectId, "second", "failed", 60_000);

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.connections, [
      { provider: "slack", slug: "acme-slack", label: "Acme Slack" },
    ]);
    assert.deepEqual(snapshot.daemons, [
      { id: TEST_DAEMON_ID, slug: TEST_DAEMON_SLUG, presence: "connected", canExecute: true },
      { id: CONNECTED_ONLY_DAEMON_ID, slug: "laptop", presence: "offline", canExecute: false },
    ]);
    assert.deepEqual(snapshot.triggers, [
      { id: trigger.id, name: "manual-task", event: "manual.run", enabled: true },
    ]);
    assert.deepEqual(
      snapshot.runs.map(({ triggerName, provider, source, status, agent }) => ({
        triggerName,
        provider,
        source,
        status,
        agent,
      })),
      [
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "failed",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "succeeded",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
      ],
    );
  });

  it("names a run after its trigger, not after the event within the trigger that started it", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: scheduledTriggerYaml, userId: "user-1" });
    await recordRun(
      database,
      trigger.runtimeProjectId,
      "tick",
      "succeeded",
      60_000,
      "schedule.tick",
    );

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(
      snapshot.runs.map(({ triggerName }) => triggerName),
      ["manual-task"],
    );
  });

  it("counts provider events dropped for want of a trigger, per provider, inside the window", async () => {
    const database = memberDatabase();
    await dropSlackEvent(database, "recent-1", new Date("2026-09-20T12:00:00.000Z"));
    await dropSlackEvent(database, "recent-2", new Date("2026-09-21T09:00:00.000Z"));
    await dropSlackEvent(database, "stale", new Date("2026-09-01T12:00:00.000Z"));
    // A filter rejection is a trigger listening and declining, so it is not a missing trigger.
    await dropSlackEvent(
      database,
      "filtered",
      new Date("2026-09-21T10:00:00.000Z"),
      "trigger_filters_rejected",
    );

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.unrouted, [{ provider: "slack", count: 2 }]);
  });

  it("lists the dropped events the overview counts, and leaves out one a trigger handled", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });
    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);

    const prose = `please look at the deploy ${"x".repeat(400)}TAILMARKER`;
    await dropSlackEvent(
      database,
      "said",
      new Date("2026-09-21T09:00:00.000Z"),
      "no_trigger_for_source",
      {
        payload: {
          channelId: "C-ACME",
          content: prose,
          author: { id: "U-ADA", username: "ada" },
          token: "do-not-leak",
        },
      },
    );
    await dropSlackEvent(
      database,
      "nested",
      new Date("2026-09-21T08:30:00.000Z"),
      "no_project_route",
      {
        repo: "acme/app",
        payload: {
          payload: {
            sender: { login: "octocat" },
            comment: { body: "@paseo run tenant dispatch" },
          },
        },
      },
    );
    await dropSlackEvent(database, "quiet", new Date("2026-09-21T08:00:00.000Z"));
    await dropSlackEvent(database, "stale", new Date("2026-09-01T12:00:00.000Z"));
    await dropSlackEvent(
      database,
      "filtered",
      new Date("2026-09-21T10:00:00.000Z"),
      "trigger_filters_rejected",
      { payload: { content: "a trigger declined this" } },
    );
    const heard = await dropSlackEvent(
      database,
      "heard",
      new Date("2026-09-21T07:00:00.000Z"),
      "no_trigger_for_source",
      {
        payload: {
          channelId: "C-HEARD",
          content: "handled by a trigger",
          author: { id: "U1" },
        },
      },
    );
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: heard,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(NOW.getTime() + 3_600_000),
      stepIds: ["run"],
      createdAt: new Date("2026-09-21T07:00:00.000Z"),
    });

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
    ).snapshot(request, "acme");

    assert.deepEqual(snapshot.unrouted, [{ provider: "slack", count: 3 }]);
    assert.equal(snapshot.unroutedEvents.length, 3);
    const [said, nested, quiet] = snapshot.unroutedEvents;
    assert.ok(said);
    assert.ok(nested);
    assert.ok(quiet);
    assert.equal(said.provider, "slack");
    assert.equal(said.source, "slack.mention");
    assert.equal(said.channel, "C-ACME");
    assert.equal(said.author, "ada");
    assert.equal(said.text?.startsWith("please look at the deploy"), true);
    assert.equal(said.text?.endsWith("..."), true);
    assert.equal(said.text?.includes("TAILMARKER"), false);
    assert.equal("repository" in said, false);
    assert.equal(nested.author, "octocat");
    assert.equal(nested.text, "@paseo run tenant dispatch");
    assert.equal(nested.repository, "acme/app");
    assert.equal("channel" in nested, false);
    assert.equal(quiet.source, "slack.mention");
    assert.equal("text" in quiet, false);
    assert.equal("body" in quiet, false);
    assert.equal("channel" in quiet, false);
    assert.equal("author" in quiet, false);
    assert.equal("repository" in quiet, false);
    assert.equal(said.body?.includes("TAILMARKER"), true);
    assert.equal(said.body?.includes("do-not-leak"), false);
    assert.equal(
      snapshot.unroutedEvents.some((event) => event.text === "handled by a trigger"),
      false,
    );
    assert.equal(
      snapshot.unroutedEvents.some((event) => event.text === "a trigger declined this"),
      false,
    );
    assert.equal(JSON.stringify(snapshot.unroutedEvents).includes("do-not-leak"), false);
    assert.equal(JSON.stringify(snapshot.unroutedEvents).includes("teamId"), false);
  });

  it("resolves a slack message when lookup returns names, and keeps a failed id", async () => {
    const database = memberDatabase();
    await storeNamedSlackEvents(database);
    const lists: string[] = [];
    const directory: SlackNameDirectory = {
      lookupUserName(input) {
        if (input.userId === "U094VQF0KEZ") return Promise.resolve("gio");
        if (input.userId === "U09FFH54LM9") return Promise.resolve("ada");
        return Promise.reject(new Error("Slack API user_not_found"));
      },
      lookupChannelName(input) {
        if (input.channelId === "C096V21TE0K") return Promise.resolve("alertas");
        return Promise.reject(new Error("Slack API channel_not_found"));
      },
      listUserGroupNames(input) {
        lists.push(`${input.organizationId}:${input.teamId}`);
        return Promise.resolve(new Map([["S097UJTSNH2", "plantao"]]));
      },
    };

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
      directory,
    ).snapshot(request, "acme");

    assert.equal(snapshot.unroutedEvents.length, 2);
    const [named, missed] = snapshot.unroutedEvents;
    assert.ok(named);
    assert.ok(missed);
    assert.equal(named.body, `@plantao ✅ ⚠️ @gio\ncheck the channel ${"x".repeat(400)}TAILMARKER`);
    assert.equal(named.text?.startsWith("@plantao ✅ ⚠️ @gio check the channel"), true);
    assert.equal(named.text?.endsWith("..."), true);
    assert.equal(named.text?.includes("TAILMARKER"), false);
    assert.equal(named.text?.includes("<@"), false);
    assert.equal(named.text?.includes("<!subteam"), false);
    assert.equal(named.text?.includes(":warning:"), false);
    assert.equal(named.text?.includes(":white_check_mark:"), false);
    assert.equal(named.channel, "alertas");
    assert.equal(named.author, "ada");
    assert.equal("teamId" in named, false);
    assert.equal(missed.channel, "C0BB3ESNU9W");
    assert.equal(missed.author, "U094VQCSK53");
    assert.equal(missed.text?.includes("<@U094VQCSK53>"), true);
    assert.equal(missed.text?.includes("<!subteam^S0MISSING01>"), true);
    assert.equal(missed.text?.includes("⚠️"), true);
    assert.equal(missed.text?.includes(":warning:"), false);
    assert.equal(lists.length, 1);
    assert.deepEqual(lists, ["org-1:T-ACME"]);
    assert.equal(JSON.stringify(snapshot.unroutedEvents).includes("do-not-leak"), false);
  });

  it("keeps the stored slack text when every lookup fails", async () => {
    const database = memberDatabase();
    await storeNamedSlackEvents(database);
    const directory: SlackNameDirectory = {
      lookupUserName: () => Promise.reject(new Error("Slack API user_not_found")),
      lookupChannelName: () => Promise.reject(new Error("Slack API channel_not_found")),
      listUserGroupNames: () => Promise.reject(new Error("Slack API missing_scope")),
    };

    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      APPS_CONFIGURED,
      () => NOW,
      directory,
    ).snapshot(request, "acme");

    assert.equal(snapshot.unroutedEvents.length, 2);
    const [named, missed] = snapshot.unroutedEvents;
    assert.ok(named);
    assert.ok(missed);
    assert.equal(named.channel, "C096V21TE0K");
    assert.equal(named.author, "U09FFH54LM9");
    assert.equal(named.body?.includes("<@U094VQF0KEZ>"), true);
    assert.equal(named.body?.includes("<!subteam^S097UJTSNH2>"), true);
    assert.equal(named.body?.includes("⚠️"), true);
    assert.equal(named.body?.includes("✅"), true);
    assert.equal(named.body?.includes(":warning:"), false);
    assert.equal(named.body?.includes(":white_check_mark:"), false);
    assert.equal(named.body?.includes("TAILMARKER"), true);
    assert.equal(missed.author, "U094VQCSK53");
    assert.equal(missed.text?.includes("<@U094VQCSK53>"), true);
  });

  it("asks the provider registrations whether any app is configured, with the organization's bindings", async () => {
    const database = memberDatabase();
    const seen: unknown[] = [];
    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      (bindings) => {
        seen.push(bindings.slack.map(({ slug }) => slug));
        return false;
      },
      () => NOW,
    ).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, false);
    assert.deepEqual(seen, [["acme-slack"]]);
  });
});

const CONNECTED_ONLY_DAEMON_ID = "20000000-0000-4000-8000-000000000002";

function memberDatabase({ slack = true }: { slack?: boolean } = {}): Database {
  return createMemoryDatabase({
    now: () => NOW,
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
    ],
    slackConnections: slack
      ? [
          {
            id: "slack-1",
            organizationId: "org-1",
            slug: "acme-slack",
            teamId: "T-ACME",
            teamName: "Acme Slack",
            botUserId: "UBOT",
            botAccessToken: "token",
            scopes: ["app_mentions:read"],
            providerApplicationId: null,
          },
        ]
      : [],
  });
}

/** A daemon enrolled with the CLI's default answer of No to running Hub automations. */
async function enrollConnectedOnlyDaemon(database: Database): Promise<void> {
  await database.issueEnrollmentToken({
    id: "connected-only-token",
    verifier: "connected-only-verifier",
    organizationId: "org-1",
    expiresAt: new Date("2026-09-22T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    tokenVerifier: "connected-only-verifier",
    daemonId: CONNECTED_ONLY_DAEMON_ID,
    idempotencyKey: "connected-only",
    suggestedSlug: "laptop",
    serverId: "server-2",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: [],
    now: new Date("2026-09-21T11:00:00.000Z"),
  });
}

async function recordRun(
  database: Database,
  projectId: string,
  deliveryId: string,
  status: "succeeded" | "failed",
  ageMs: number,
  event = "manual.run",
): Promise<void> {
  const revision = await database.findActiveProjectConfiguration(projectId);
  assert.ok(revision);
  const configured = parseCompiledHubConfig(revision.normalizedConfiguration).triggers.find(
    ({ on }) => on === event,
  );
  assert.ok(configured);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId,
    deliveryId,
    source: "manual.run",
    payload: {},
    receivedAt: new Date(NOW.getTime() - ageMs),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") return;
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: "org-1",
    projectId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: configured.name,
    prompt: "run it",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(NOW.getTime() + 3_600_000),
    stepIds: ["run"],
    createdAt: new Date(NOW.getTime() - ageMs),
  });
  const executionId = `execution-${deliveryId}`;
  await database.createWorkflowStepExecution({
    triggerRunId: run.id,
    stepId: "run",
    ordinal: 0,
    executionId,
    execution: {
      id: executionId,
      organizationId: "org-1",
      projectId,
      machineId: null,
      daemonId: TEST_DAEMON_ID,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: revision.id,
      deadlineAt: new Date(NOW.getTime() + 3_600_000),
      idleDeadlineAt: new Date(NOW.getTime() + 600_000),
      startedAt: new Date(NOW.getTime() - 30_000),
      launchIntent: buildLaunchMachineIntent({
        organizationId: "org-1",
        projectId,
        triggerRunId: run.id,
        configurationRevisionId: revision.id,
        triggerName: "manual-task",
        environmentName: "target",
        environment: {
          kind: "daemon",
          daemonId: TEST_DAEMON_ID,
          authoredSlug: TEST_DAEMON_SLUG,
          cwd: "/workspace",
        },
        prompt: "run it",
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        allowOutputs: [],
        autoArchive: true,
        background: false,
        triggerContext: {},
        outputContext: {},
        hubConfig: {},
      }),
    },
  });
  if (status === "succeeded") await database.succeedTriggerRun(run.id);
  else await database.failWorkflowRun(run.id, "failed", "agent_interrupted", "run");
}

async function storeNamedSlackEvents(database: Database): Promise<void> {
  await dropSlackEvent(
    database,
    "named",
    new Date("2026-09-21T09:00:00.000Z"),
    "no_trigger_for_source",
    {
      payload: {
        teamId: "T-ACME",
        channelId: "C096V21TE0K",
        content: `<!subteam^S097UJTSNH2> :white_check_mark: :warning: <@U094VQF0KEZ>\ncheck the channel ${"x".repeat(400)}TAILMARKER`,
        author: { id: "U09FFH54LM9" },
        token: "do-not-leak",
      },
    },
  );
  await dropSlackEvent(
    database,
    "missed",
    new Date("2026-09-21T08:00:00.000Z"),
    "no_trigger_for_source",
    {
      payload: {
        teamId: "T-ACME",
        channelId: "C0BB3ESNU9W",
        content: "<!subteam^S0MISSING01> :warning: <@U094VQCSK53> still here",
        author: { id: "U094VQCSK53" },
      },
    },
  );
}

async function dropSlackEvent(
  database: Database,
  deliveryId: string,
  receivedAt: Date,
  reason = "no_project_route",
  details: { payload?: unknown; repo?: string | null } = {},
): Promise<string> {
  const accepted = await database.acceptSlackEvent({
    teamId: "T-ACME",
    deliveryId,
    source: "slack.mention",
    payload: details.payload ?? {},
    receivedAt,
    dropReason: reason,
    ...(details.repo === undefined ? {} : { repo: details.repo }),
  });
  assert.equal(accepted.status, "dropped");
  if (accepted.status !== "dropped") throw new Error("slack event was not dropped");
  return accepted.receiptId;
}

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Handle it
`;

/** A schedule declared before the manual event, so the schedule compiles under an internal name. */
const scheduledTriggerYaml = triggerYaml.replace(
  "on:\n",
  `on:
  schedule.tick:
    recurrence: { start: "2026-01-01T09:00:00", rule: "FREQ=DAILY", timezone: UTC }
`,
);

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
