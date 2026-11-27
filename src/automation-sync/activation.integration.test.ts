import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../db/runtime/index.js";
import type { ProviderApplicationConfiguration } from "../provider-applications/index.js";
import { activateAutomationGitSyncsAtStartup } from "./activation.js";

const roots: string[] = [];
const bundles: DatabaseRuntimeBundle[] = [];

afterEach(async () => {
  await Promise.all(bundles.splice(0).map((bundle) => bundle.runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automation git sync declared by the environment", () => {
  it("creates the row with the repository id and follows a recreated connection", async () => {
    const { database } = await freshDatabase("acme");
    const connectionId = await insertGitHubConnection(database, "acme-app", 178294978);
    const state = new FakeGitHub();

    const first = await activateAutomationGitSyncsAtStartup({
      database,
      syncs: [
        {
          organization: "acme",
          connection: "acme-app",
          repository: "acme/app",
          commitMessage: "chore(agent): atualiza automações",
        },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(first, []);

    const rows = await database.query<{
      enabled: boolean;
      github_connection_id: string;
      repository_id: string;
      repository_full_name: string;
      branch: string;
      commit_message: string;
      automations_directory: string;
      interval_minutes: number;
    }>(
      "select enabled, github_connection_id, repository_id::text, repository_full_name, branch, commit_message, automations_directory, interval_minutes from automation_git_sync",
    );
    assert.deepEqual(rows.rows, [
      {
        enabled: true,
        github_connection_id: connectionId,
        repository_id: "1385848460",
        repository_full_name: "acme/app",
        // The declaration omits the branch, so the repository default decides.
        branch: "master",
        commit_message: "chore(agent): atualiza automações",
        automations_directory: ".paseo/automations",
        interval_minutes: 15,
      },
    ]);

    // A boot that recreates the connection (new row id) must repoint the sync at it.
    await database.query("delete from github_connections where id = $1", [connectionId]);
    const recreatedId = await insertGitHubConnection(database, "acme-app", 178294979);
    const second = await activateAutomationGitSyncsAtStartup({
      database,
      syncs: [
        {
          organization: "acme",
          connection: "acme-app",
          repository: "acme/app",
          directory: "packages/agent/.paseo/automations",
          intervalMinutes: 60,
          enabled: false,
        },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(second, []);

    const after = await database.query<{
      github_connection_id: string;
      repository_id: string;
      branch: string;
      automations_directory: string;
      interval_minutes: number;
      enabled: boolean;
    }>(
      "select github_connection_id, repository_id::text, branch, automations_directory, interval_minutes, enabled from automation_git_sync",
    );
    assert.deepEqual(after.rows, [
      {
        github_connection_id: recreatedId,
        // The second installation resolves to its own repository id.
        repository_id: "1385848461",
        branch: "master",
        automations_directory: "packages/agent/.paseo/automations",
        interval_minutes: 60,
        enabled: false,
      },
    ]);
  });

  it("reports an unknown connection and leaves no row", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeGitHub();

    const failures = await activateAutomationGitSyncsAtStartup({
      database,
      syncs: [{ organization: "acme", connection: "missing", repository: "acme/app" }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.error), /does not exist/u);
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from automation_git_sync",
        )
      ).rows[0]?.count,
      "0",
    );
  });

  it("reports a repository the installation cannot see", async () => {
    const { database } = await freshDatabase("acme");
    await insertGitHubConnection(database, "acme-app", 178294978);
    const state = new FakeGitHub();

    const failures = await activateAutomationGitSyncsAtStartup({
      database,
      syncs: [{ organization: "acme", connection: "acme-app", repository: "acme/private" }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.error), /404/u);
  });
});

async function freshDatabase(organizationSlug?: string): Promise<{
  database: DatabaseRuntimeBundle["runtime"];
}> {
  const root = await mkdtemp(join(tmpdir(), "hub-automation-sync-"));
  roots.push(root);
  const bundle = await embeddedDatabaseRuntime(root);
  bundles.push(bundle);
  await bundle.runtime.migrate();
  if (organizationSlug !== undefined) {
    await bundle.runtime.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
      randomUUID(),
      organizationSlug,
      organizationSlug,
    ]);
  }
  return { database: bundle.runtime };
}

async function insertGitHubConnection(
  database: DatabaseRuntimeBundle["runtime"],
  slug: string,
  installationId: number,
): Promise<string> {
  const organization = await database.query<{ id: string }>(
    "select id from organization where slug = $1",
    ["acme"],
  );
  const id = randomUUID();
  await database.query(
    `insert into github_connections
       (id, organization_id, installation_id, provider_application_id, slug, account_id,
        account_login, account_type, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active')`,
    [id, organization.rows[0]?.id, installationId, "5599509", slug, "42", "acme", "organization"],
  );
  return id;
}

class FakeGitHub {
  readonly applications: Partial<Record<"github", ProviderApplicationConfiguration>> = {
    github: {
      provider: "github",
      appId: "5599509",
      appSlug: "acme-app",
      clientId: "Iv1.acme",
      clientSecret: "acme-secret",
      privateKey: testPrivateKey(),
      webhookSecret: "acme-webhook",
    },
  };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const token = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/u);
    if (token !== null) {
      return Response.json(
        { token: `ghs_${token[1]}`, expires_at: "2026-11-27T00:00:00Z" },
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/acme/app") {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const authorization = headers.get("authorization") ?? "";
      const installation = authorization.endsWith("178294979") ? "178294979" : "178294978";
      return Response.json({
        id: installation === "178294979" ? 1385848461 : 1385848460,
        full_name: "acme/app",
        default_branch: "master",
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
