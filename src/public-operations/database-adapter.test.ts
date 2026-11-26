import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";

describe("public manual-run project resolution", () => {
  it("prefers an organization trigger runtime and retains the legacy project fallback", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    await enrollTestDaemon(database, "org");
    const legacy = await database.createProject({
      organizationId: "org",
      name: "Default",
      slug: "default",
      createdByUserId: null,
    });
    const trigger = await new OrganizationTriggerStore(
      database,
      "org",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml(true),
      userId: null,
    });
    const repository = createDatabasePublicOperationRepository(database);

    assert.deepEqual(await repository.resolveManualRunProject("org", "deploy", "default"), {
      status: "resolved",
      id: trigger.runtimeProjectId,
    });
    assert.deepEqual(await repository.resolveManualRunProject("org", "legacy", "default"), {
      status: "resolved",
      id: legacy.id,
    });
  });

  it("does not fall through to a legacy project when the organization trigger is disabled", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    await enrollTestDaemon(database, "org");
    await database.createProject({
      organizationId: "org",
      name: "Default",
      slug: "default",
      createdByUserId: null,
    });
    await new OrganizationTriggerStore(database, "org", acceptingAgentValidator()).save({
      yaml: triggerYaml(false),
      userId: null,
    });

    assert.deepEqual(
      await createDatabasePublicOperationRepository(database).resolveManualRunProject(
        "org",
        "deploy",
        "default",
      ),
      { status: "disabled" },
    );
  });
});

function triggerYaml(enabled: boolean): string {
  return `name: deploy
enabled: ${String(enabled)}
on:
  manual.run: {}
run:
  target: { daemon: daemon-10000000, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;
}

describe("public daemon revocation", () => {
  it("revokes a daemon that has no socket, even when the stored presence says connected", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    await enrollTestDaemon(database, "org");
    // A daemon killed while the Hub was down keeps the column at connected with no socket behind.
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const repository = createDatabasePublicOperationRepository(database);

    const enrolled = await database.findDaemonForOrganization("org", TEST_DAEMON_ID);
    assert.deepEqual(await repository.revokeDaemon("org", TEST_DAEMON_ID), {
      status: "revoked",
      slug: enrolled?.slug,
    });
    assert.equal(
      (await database.findDaemonForOrganization("org", TEST_DAEMON_ID))?.status,
      "revoked",
    );
  });

  it("refuses a connected daemon and a daemon from another organization", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org", "other"] });
    await enrollTestDaemon(database, "org");
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const repository = createDatabasePublicOperationRepository(
      database,
      (daemonId) => daemonId === TEST_DAEMON_ID,
    );

    assert.deepEqual(await repository.revokeDaemon("org", TEST_DAEMON_ID), {
      status: "daemon_online",
    });
    assert.equal(
      (await database.findDaemonForOrganization("org", TEST_DAEMON_ID))?.status,
      "active",
    );

    assert.deepEqual(await repository.revokeDaemon("other", TEST_DAEMON_ID), {
      status: "not_found",
    });
    assert.deepEqual(await repository.revokeDaemon("org", "20000000-0000-4000-8000-000000000002"), {
      status: "not_found",
    });
  });
});
