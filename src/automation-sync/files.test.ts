import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { GitHubConnectionRecord } from "../db/types.js";
import { AutomationFilesError, gitBlobSha, readAutomationDirectory } from "./files.js";
import type { GitTreeClient } from "./publish.js";
import { AutomationGitSync } from "./service.js";
import { collectAutomationSnapshot } from "./snapshot.js";

describe("automation files", () => {
  it("reads the directory and refuses a symlink that leaves it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-automations-"));
    const outside = await mkdtemp(path.join(tmpdir(), "paseo-outside-"));
    await mkdir(path.join(root, "partials"), { recursive: true });
    await mkdir(path.join(root, "logs"), { recursive: true });
    await writeFile(path.join(root, "partials", "falar.md"), "oi\n");
    await writeFile(path.join(root, "logs", "banco.jsonl"), "secret\n");
    await writeFile(path.join(outside, "segredo.md"), "nope\n");
    const escaped = await mkdtemp(path.join(tmpdir(), "paseo-escaped-"));
    await symlink(path.join(outside, "segredo.md"), path.join(escaped, "segredo.md"));

    const files = await readAutomationDirectory(root);
    assert.deepEqual(
      files.map((file) => file.path),
      ["partials/falar.md"],
    );
    await assert.rejects(readAutomationDirectory(escaped), AutomationFilesError);
    await assert.rejects(readAutomationDirectory(path.join(root, "missing")), /does not exist/u);
  });

  it("commits the automations directory and the trigger files through the GitHub installation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-sync-"));
    await mkdir(path.join(directory, "partials"), { recursive: true });
    await writeFile(path.join(directory, "partials", "falar.md"), "oi\n");
    const commits: { message: string; changes: { path: string }[] }[] = [];
    let remote = [{ path: ".paseo/triggers/aposentado.yml", sha: "old" }];
    const client: GitTreeClient = {
      async readHead() {
        return { commitSha: "a".repeat(40), treeSha: "b".repeat(40) };
      },
      async readTree() {
        return remote;
      },
      async commit(input) {
        commits.push({
          message: input.message,
          changes: input.changes.map((change) => ({ path: change.path })),
        });
        const next = new Map(remote.map((blob) => [blob.path, blob.sha]));
        for (const change of input.changes) {
          if ("sha" in change) next.delete(change.path);
          else next.set(change.path, gitBlobSha(Buffer.from(change.content, "utf8")));
        }
        remote = [...next].map(([blobPath, sha]) => ({ path: blobPath, sha }));
        return "c".repeat(40);
      },
    };
    const database = createMemoryDatabase({
      githubConnections: [githubConnection()],
    });
    await database.saveAutomationGitSync({
      organizationId: "org",
      enabled: true,
      githubConnectionId: "connection",
      repositoryId: 42,
      repositoryFullName: "acme/widgets",
      branch: "main",
      commitMessage: "Ship the automations",
      automationsDirectory: "prompts",
      intervalMinutes: 15,
    });
    seedAutomationInclude(database, directory);
    const sync = new AutomationGitSync({
      database,
      auth: null,
      trees: async () => client,
    });
    const result = await sync.syncOrganization("org");
    assert.deepEqual(result, { status: "committed", commitSha: "c".repeat(40) });
    assert.equal(commits[0]?.message, "Ship the automations");
    assert.deepEqual(commits[0]?.changes.map((change) => change.path).sort(), [
      ".paseo/triggers/aposentado.yml",
      ".paseo/triggers/triagem.yml",
      "prompts/partials/falar.md",
    ]);
    const saved = await database.getAutomationGitSync("org");
    assert.equal(saved?.lastStatus, "committed");
    assert.equal(saved?.lastCommitSha, "c".repeat(40));
    assert.equal(saved?.lastError, null);

    const again = await sync.syncOrganization("org");
    assert.equal(again.status, "unchanged");
    assert.equal(commits.length, 1);
  });

  it("copies the outer directory when a catalog lives inside it", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-sync-"));
    const directory = path.join(parent, "automations");
    const alias = path.join(parent, "link");
    await mkdir(path.join(directory, "partials"), { recursive: true });
    await mkdir(path.join(directory, "regras"), { recursive: true });
    await writeFile(path.join(directory, "partials", "falar.md"), "oi\n");
    await writeFile(path.join(directory, "regras", "ajuste.md"), "regra\n");
    await symlink(directory, alias);
    const database = createMemoryDatabase();
    seedAutomationInclude(
      database,
      directory,
      `prompt:\n  - include:\n      path: partials/falar.md\n      root: ${JSON.stringify(directory)}\n  - load:\n      root: ${JSON.stringify(path.join(alias, "regras"))}\n`,
    );
    const files = await collectAutomationSnapshot(database, "org", ".paseo/automations");
    assert.deepEqual(files.map((file) => file.path).sort(), [
      ".paseo/automations/partials/falar.md",
      ".paseo/automations/regras/ajuste.md",
      ".paseo/triggers/triagem.yml",
    ]);
  });

  it("refuses prompt files that live in separate directories", async () => {
    const left = await mkdtemp(path.join(tmpdir(), "paseo-sync-left-"));
    const right = await mkdtemp(path.join(tmpdir(), "paseo-sync-right-"));
    const database = createMemoryDatabase();
    seedAutomationInclude(
      database,
      left,
      `prompt:\n  - include:\n      path: falar.md\n      root: ${JSON.stringify(left)}\n  - include:\n      path: regra.md\n      root: ${JSON.stringify(right)}\n`,
    );
    await assert.rejects(
      collectAutomationSnapshot(database, "org", ".paseo/automations"),
      /more than one directory/u,
    );
  });
});

function seedAutomationInclude(
  database: ReturnType<typeof createMemoryDatabase>,
  root: string,
  yaml = `prompt:\n  - include:\n      path: partials/falar.md\n      root: ${JSON.stringify(root)}\n`,
): void {
  const triggers: unknown = Reflect.get(database, "organizationTriggers");
  const revisions: unknown = Reflect.get(database, "organizationTriggerRevisions");
  if (!(triggers instanceof Map) || !(revisions instanceof Map)) {
    throw new Error("memory trigger store unavailable");
  }
  const now = new Date();
  triggers.set("trigger", {
    id: "trigger",
    organizationId: "org",
    name: "triagem",
    enabled: true,
    format: "single_run",
    runtimeProjectId: "project",
    activeRevisionId: "revision",
    createdAt: now,
    updatedAt: now,
  });
  revisions.set("revision", {
    id: "revision",
    triggerId: "trigger",
    organizationId: "org",
    version: 1,
    yaml,
    normalizedConfiguration: {},
    contentHash: "hash",
    sourceKind: "manual",
    sourceEvidence: {},
    createdByUserId: null,
    createdAt: now,
  });
}

function githubConnection(): GitHubConnectionRecord {
  return {
    id: "connection",
    organizationId: "org",
    slug: "acme",
    installationId: 7,
    accountId: "1",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active",
    providerApplicationId: null,
  };
}
