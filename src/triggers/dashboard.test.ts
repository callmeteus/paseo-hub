import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";

describe("trigger dashboard read model", () => {
  it("describes the provider and latest run on the organization trigger list", async () => {
    const database = createMemoryDatabase({
      memberships: [acmeMembership],
    });
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml,
      userId: "user-1",
    });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const request = new Request("https://hub.test/o/acme/triggers");

    const before = await dashboard.snapshot(request, "acme");
    assert.equal(before.triggers[0]?.provider, "manual");
    assert.equal(before.triggers[0]?.event, "manual.run");
    assert.equal(before.triggers[0]?.lastTriggered, null);

    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    const receivedAt = new Date("2026-08-30T09:30:00.000Z");
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: "dashboard-manual-run",
      source: "manual.run",
      payload: {},
      receivedAt,
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
      stepIds: ["run"],
    });

    const after = await dashboard.snapshot(request, "acme");
    assert.deepEqual(after.triggers[0]?.lastTriggered, {
      status: "running",
      receivedAt: receivedAt.toISOString(),
    });
  });

  it("lists channel names for the selected Slack connection", async () => {
    const database = createMemoryDatabase({
      memberships: [acmeMembership],
      slackConnections: [
        {
          id: "slack-1",
          organizationId: "org-1",
          slug: "acme-slack",
          teamId: "T1",
          teamName: "Acme",
          botUserId: "UBOT",
          botAccessToken: "xoxb-test",
          scopes: ["channels:read", "groups:read"],
          providerApplicationId: null,
        },
      ],
    });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const previousFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({
        ok: true,
        channels: [{ id: "C1", name: "general", is_private: false }],
        response_metadata: { next_cursor: "" },
      });
    };

    try {
      const channels = await dashboard.slackChannels(
        new Request("https://hub.test/o/acme/triggers"),
        "acme",
        "acme-slack",
      );
      assert.equal(authorization, "Bearer xoxb-test");
      assert.deepEqual(channels, [{ id: "C1", name: "general", isPrivate: false }]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("rejects a Slack connection that is not in the organization", async () => {
    const database = createMemoryDatabase({ memberships: [acmeMembership] });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());

    await assert.rejects(
      () =>
        dashboard.slackChannels(new Request("https://hub.test/o/acme/triggers"), "acme", "missing"),
      (error: unknown) => {
        assert.ok(error instanceof ProjectCommandError);
        assert.equal(error.code, "not_found");
        return true;
      },
    );
  });
});

const acmeMembership = {
  userId: "user-1",
  organizationId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  membershipId: "membership-1",
  role: "owner" as const,
};

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;

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
