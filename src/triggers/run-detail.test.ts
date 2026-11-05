import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { encodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import { EntitlementDenied } from "../entitlements/catalog.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { TriggerDashboard } from "./dashboard.js";
import { formatRunDuration } from "./run-detail.js";
import { OrganizationTriggerStore } from "./store.js";

const STARTED = new Date("2026-08-30T09:30:00.000Z");
const FINISHED = new Date("2026-08-30T09:32:05.000Z");
const request = new Request("https://hub.test/o/acme/activity");

describe("organization run detail", () => {
  it("prints how long a success took and the output the step stored", async () => {
    const { dashboard, projectId, revisionId } = await readyDashboard();
    const runId = await acceptRun(projectId, revisionId, "success-delivery", ["deploy", "notice"]);
    const database = dashboardDatabase;
    await database.succeedWorkflowStep(runId, "deploy", { deployed: true }, FINISHED);
    await database.markWorkflowStepSkipped(runId, "notice", "not reached");
    await database.succeedTriggerRun(runId);

    const detail = await dashboard.activityRun(request, "acme", runId);

    assert.equal(detail.triggerName, "manual-task");
    assert.equal(detail.provider, "manual");
    assert.equal(detail.source, "manual.run");
    assert.equal(detail.status, "succeeded");
    assert.equal(detail.receivedAt, STARTED.toISOString());
    assert.equal(detail.finishedAt, FINISHED.toISOString());
    assert.equal(detail.duration, "2m 5s");
    assert.equal(detail.failureReason, null);
    assert.deepEqual(detail.results, [{ stepId: "deploy", value: { deployed: true } }]);
    assert.equal(detail.steps.length, 2);
    assert.equal(detail.steps[0]?.status, "succeeded");
    assert.deepEqual(detail.steps[0]?.output, { deployed: true });
    assert.equal(detail.steps[1]?.status, "skipped");
    assert.equal(detail.steps[1]?.failureReason, "not reached");
    assert.equal(detail.steps[1]?.output, null);
  });

  it("keeps the failure message that was stored, and does not invent a duration", async () => {
    const { dashboard, projectId, revisionId } = await readyDashboard();
    const runId = await acceptRun(projectId, revisionId, "failed-delivery", ["deploy"]);
    await dashboardDatabase.failWorkflowRun(runId, "failed", "agent_interrupted", "deploy");

    const detail = await dashboard.activityRun(request, "acme", runId);

    assert.equal(detail.status, "failed");
    assert.equal(detail.failureReason, "agent_interrupted");
    assert.equal(detail.duration, null);
    assert.equal(detail.finishedAt, FINISHED.toISOString());
    assert.equal(detail.results.length, 0);
    assert.equal(detail.steps[0]?.status, "failed");
    assert.equal(detail.steps[0]?.failureReason, "agent_interrupted");
  });

  it("turns a stored entitlement denial into the denial sentence", async () => {
    const { dashboard, projectId, revisionId } = await readyDashboard();
    const runId = await acceptRun(projectId, revisionId, "denied-delivery", ["deploy"]);
    const reason = encodeEntitlementDenialFailureReason(
      new EntitlementDenied("executions.monthly", "meter", 1, 1).payload(),
    );
    await dashboardDatabase.failWorkflowRun(runId, "failed", reason, "deploy");

    const detail = await dashboard.activityRun(request, "acme", runId);

    assert.equal(detail.failureReason, "Entitlement limit reached: executions.monthly (1 of 1)");
    assert.equal(detail.failureReason?.includes("{"), false);
  });

  it("does not invent steps or a result when the run stored neither", async () => {
    const { dashboard, projectId, revisionId } = await readyDashboard();
    const runId = await acceptRun(projectId, revisionId, "empty-delivery", []);
    await dashboardDatabase.succeedTriggerRun(runId);

    const detail = await dashboard.activityRun(request, "acme", runId);

    assert.equal(detail.status, "succeeded");
    assert.equal(detail.duration, "2m 5s");
    assert.deepEqual(detail.steps, []);
    assert.deepEqual(detail.results, []);
    assert.equal(detail.outputContext, null);
  });

  it("refuses a run that belongs to another organization", async () => {
    const { dashboard, projectId, revisionId } = await readyDashboard();
    const runId = await acceptRun(projectId, revisionId, "foreign-delivery", ["deploy"]);

    assert.equal(await dashboardDatabase.findOrganizationActivityRun("org-2", runId), undefined);
    await assert.rejects(
      () => dashboard.activityRun(request, "acme", "00000000-0000-4000-8000-000000000000"),
      (error: unknown) => error instanceof ProjectCommandError && error.code === "not_found",
    );
  });
});

describe("run duration", () => {
  it("reads in hours, minutes, seconds, and milliseconds", () => {
    assert.equal(formatRunDuration(400), "400ms");
    assert.equal(formatRunDuration(45_000), "45s");
    assert.equal(formatRunDuration(120_000), "2m");
    assert.equal(formatRunDuration(125_000), "2m 5s");
    assert.equal(formatRunDuration(3_600_000), "1h");
    assert.equal(formatRunDuration(3_720_000), "1h 2m");
  });
});

let dashboardDatabase = createMemoryDatabase();

async function readyDashboard() {
  dashboardDatabase = createMemoryDatabase({
    memberships: [acmeMembership],
    now: () => FINISHED,
  });
  await enrollTestDaemon(dashboardDatabase, "org-1");
  const trigger = await new OrganizationTriggerStore(
    dashboardDatabase,
    "org-1",
    acceptingAgentValidator(),
  ).save({ yaml: triggerYaml, userId: "user-1" });
  const revision = await dashboardDatabase.findActiveProjectConfiguration(trigger.runtimeProjectId);
  assert.ok(revision);
  return {
    dashboard: new TriggerDashboard(dashboardDatabase, accountAuth(), acceptingAgentValidator()),
    projectId: trigger.runtimeProjectId,
    revisionId: revision.id,
  };
}

async function acceptRun(
  projectId: string,
  revisionId: string,
  deliveryId: string,
  stepIds: readonly string[],
): Promise<string> {
  const receipt = await dashboardDatabase.persistManualEvent({
    organizationId: "org-1",
    projectId,
    deliveryId,
    source: "manual.run",
    payload: {},
    receivedAt: STARTED,
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
  const created = await dashboardDatabase.createAcceptedTriggerRun({
    organizationId: "org-1",
    projectId,
    configurationRevisionId: revisionId,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "compiled-name",
    prompt: "Handle it",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
    stepIds,
    createdAt: STARTED,
  });
  return created.run.id;
}

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
