import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  AutomationGitSyncConfigurationError,
  parseConfiguredAutomationGitSyncs,
  readConfiguredAutomationGitSyncs,
} from "./environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automation git sync declared by the environment", () => {
  it("is off when neither variable is set", async () => {
    assert.deepEqual(await readConfiguredAutomationGitSyncs({}), []);
  });

  it("accepts one declaration and a list of them", async () => {
    const single = {
      organization: "acme",
      connection: "acme-app",
      repository: "acme/app",
      branch: "master",
      directory: "packages/agent/.paseo/automations",
    };
    assert.deepEqual(
      await readConfiguredAutomationGitSyncs({
        PASEO_HUB_AUTOMATION_GIT_SYNC: JSON.stringify(single),
      }),
      [single],
    );
    assert.deepEqual(
      await readConfiguredAutomationGitSyncs({
        PASEO_HUB_AUTOMATION_GIT_SYNC: JSON.stringify([single, { ...single, branch: "main" }]),
      }),
      [single, { ...single, branch: "main" }],
    );
  });

  it("reads the same document from a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-automation-sync-"));
    roots.push(root);
    const file = join(root, "sync.json");
    const declaration = {
      organization: "acme",
      connection: "acme-app",
      repository: "acme/app",
      intervalMinutes: 5,
    };
    await writeFile(file, JSON.stringify(declaration));
    assert.deepEqual(
      await readConfiguredAutomationGitSyncs({ PASEO_HUB_AUTOMATION_GIT_SYNC_FILE: file }),
      [declaration],
    );
  });

  it("refuses an inline value and a file at the same time", async () => {
    await assert.rejects(
      readConfiguredAutomationGitSyncs({
        PASEO_HUB_AUTOMATION_GIT_SYNC: "{}",
        PASEO_HUB_AUTOMATION_GIT_SYNC_FILE: "/tmp/sync.json",
      }),
      AutomationGitSyncConfigurationError,
    );
  });

  it("refuses a declaration it cannot apply instead of skipping it", () => {
    for (const entry of [
      { organization: "acme", connection: "acme-app" },
      { organization: "acme", connection: "acme-app", repository: "acme" },
      { organization: "acme", connection: "acme-app", repository: "acme/app", intervalMinutes: 7 },
      {
        organization: "acme",
        connection: "acme-app",
        repository: "acme/app",
        directory: "../outside",
      },
      {
        organization: "acme",
        connection: "acme-app",
        repository: "acme/app",
        directory: "/absolute",
      },
    ]) {
      assert.throws(
        () => parseConfiguredAutomationGitSyncs(entry),
        AutomationGitSyncConfigurationError,
        JSON.stringify(entry),
      );
    }
  });
});
