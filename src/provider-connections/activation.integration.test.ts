import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { z } from "zod";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../db/runtime/index.js";
import type { Provider, ProviderApplicationConfiguration } from "../provider-applications/index.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import { activateProviderConnectionsAtStartup } from "./activation.js";

const roots: string[] = [];
const bundles: DatabaseRuntimeBundle[] = [];

afterEach(async () => {
  await Promise.all(bundles.splice(0).map((bundle) => bundle.runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connections declared by the environment", () => {
  it("creates a Slack workspace and a Telegram chat on boot, then refreshes them in place", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();

    const first = await activateProviderConnectionsAtStartup({
      database,
      connections: [
        { provider: "slack", organization: "acme", botToken: "xoxb-first" },
        { provider: "telegram", organization: "acme", chats: ["-1001"] },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(first, []);

    const slack = await database.query<{
      slug: string;
      team_id: string;
      team_name: string;
      bot_user_id: string;
      bot_access_token: string;
      scopes: string[];
      provider_application_id: string;
    }>(
      "select slug, team_id, team_name, bot_user_id, bot_access_token, scopes, provider_application_id from slack_connections",
    );
    assert.deepEqual(slack.rows, [
      {
        // Same slug the panel connect flow saves, so a trigger authored against
        // either flow resolves to this connection.
        slug: "slack-t-acme",
        team_id: "T-ACME",
        team_name: "Acme",
        bot_user_id: "U-BOT",
        bot_access_token: "xoxb-first",
        scopes: [...SLACK_REQUIRED_BOT_SCOPES].sort(),
        provider_application_id: "A-ACME",
      },
    ]);

    const telegram = await database.query<{
      chat_id: string;
      chat_name: string;
      provider_application_id: string;
    }>("select chat_id, chat_name, provider_application_id from telegram_connections");
    assert.deepEqual(telegram.rows, [
      { chat_id: "-1001", chat_name: "Acme ops", provider_application_id: "9067" },
    ]);

    state.botToken = "xoxb-second";
    state.chatTitle = "Acme ops renamed";
    const second = await activateProviderConnectionsAtStartup({
      database,
      connections: [
        { provider: "slack", organization: "acme", botToken: "xoxb-second" },
        { provider: "telegram", organization: "acme", chats: ["-1001"] },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(second, []);
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from slack_connections",
        )
      ).rows[0]?.count,
      "1",
    );
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from telegram_connections",
        )
      ).rows[0]?.count,
      "1",
    );
    assert.equal(
      (
        await database.query<{ token: string }>(
          "select bot_access_token as token from slack_connections",
        )
      ).rows[0]?.token,
      "xoxb-second",
    );
    assert.equal(
      (await database.query<{ name: string }>("select chat_name as name from telegram_connections"))
        .rows[0]?.name,
      "Acme ops renamed",
    );
  });

  it("resolves the organization by name when the declaration does not carry the slug", async () => {
    const { database } = await freshDatabase();
    const state = new FakeProviders();
    await database.query("insert into organization (id, name, slug) values ($1, $2, $3)", [
      "10000000-0000-4000-8000-000000000001",
      "Acme Prod",
      "acme-prod-10000000",
    ]);

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [{ provider: "telegram", organization: "acme prod", chats: ["-1001"] }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.deepEqual(failures, []);
    assert.equal(
      (await database.query<{ name: string }>("select chat_name as name from telegram_connections"))
        .rows[0]?.name,
      "Acme ops",
    );
  });

  it("refuses an organization name that matches more than one organization", async () => {
    const { database } = await freshDatabase();
    const state = new FakeProviders();
    await database.query(
      `insert into organization (id, name, slug) values
         ('10000000-0000-4000-8000-000000000001', 'Twin', 'twin-10000000'),
         ('20000000-0000-4000-8000-000000000001', 'Twin', 'twin-20000000')`,
    );

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [{ provider: "telegram", organization: "Twin", chats: ["-1001"] }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.error), /does not exist|ambiguous/u);
  });

  it("reports a declaration it cannot apply and leaves the instance usable", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [
        { provider: "slack", organization: "missing", botToken: "xoxb-first" },
        { provider: "telegram", organization: "acme", chats: ["-not-a-chat"] },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 2);
    assert.equal(failures[0]?.organization, "missing");
    assert.equal(failures[1]?.resource, "-not-a-chat");
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from telegram_connections",
        )
      ).rows[0]?.count,
      "0",
    );
  });

  it("reports a missing application instead of writing an unowned connection", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [{ provider: "slack", organization: "acme", botToken: "xoxb-first" }],
      applications: {},
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from slack_connections",
        )
      ).rows[0]?.count,
      "0",
    );
  });

  it("creates a GitHub connection from a declared installation and follows its status", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();

    const first = await activateProviderConnectionsAtStartup({
      database,
      connections: [
        { provider: "github", organization: "acme", installationId: "178294978", slug: "acme-app" },
        { provider: "github", organization: "acme", installationId: "178294979" },
        { provider: "github", organization: "acme", installationId: "178294980" },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(first, []);

    const rows = await database.query<{
      installation_id: string;
      provider_application_id: string;
      slug: string;
      account_id: string;
      account_login: string;
      account_type: string;
      status: string;
    }>(
      "select installation_id::text, provider_application_id, slug, account_id, account_login, account_type, status from github_connections order by installation_id",
    );
    assert.deepEqual(rows.rows, [
      {
        installation_id: "178294978",
        provider_application_id: "5599509",
        slug: "acme-app",
        account_id: "42",
        account_login: "acme",
        account_type: "organization",
        status: "active",
      },
      {
        // No slug declared: the panel convention, and the second installation on the
        // same account takes a suffix instead of colliding.
        installation_id: "178294979",
        provider_application_id: "5599509",
        slug: "acme-github",
        account_id: "42",
        account_login: "acme",
        account_type: "organization",
        status: "active",
      },
      {
        installation_id: "178294980",
        provider_application_id: "5599509",
        slug: "acme-github-2",
        account_id: "42",
        account_login: "acme",
        account_type: "organization",
        status: "active",
      },
    ]);

    state.installationSuspended = true;
    const second = await activateProviderConnectionsAtStartup({
      database,
      connections: [
        { provider: "github", organization: "acme", installationId: "178294978", slug: "acme-app" },
      ],
      applications: state.applications,
      fetch: state.fetch,
    });
    assert.deepEqual(second, []);
    const after = await database.query<{
      status: string;
      slug: string;
      suspended_at: string | null;
    }>(
      "select status, slug, suspended_at from github_connections where installation_id = 178294978",
    );
    assert.equal(after.rows[0]?.status, "suspended");
    assert.equal(after.rows[0]?.slug, "acme-app");
    assert.notEqual(after.rows[0]?.suspended_at, null);
  });

  it("reports a GitHub installation the App cannot see", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [{ provider: "github", organization: "acme", installationId: "999" }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.provider, "github");
    assert.match(String(failures[0]?.error), /not visible/u);
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from github_connections",
        )
      ).rows[0]?.count,
      "0",
    );
  });

  it("rejects a Slack token that does not carry every dispatch scope", async () => {
    const { database } = await freshDatabase("acme");
    const state = new FakeProviders();
    state.scopes = ["chat:write"];

    const failures = await activateProviderConnectionsAtStartup({
      database,
      connections: [{ provider: "slack", organization: "acme", botToken: "xoxb-first" }],
      applications: state.applications,
      fetch: state.fetch,
    });

    assert.equal(failures.length, 1);
    assert.equal(
      (
        await database.query<{ count: string }>(
          "select count(*)::text as count from slack_connections",
        )
      ).rows[0]?.count,
      "0",
    );
  });
});

async function freshDatabase(organizationSlug?: string): Promise<{
  database: DatabaseRuntimeBundle["runtime"];
}> {
  const root = await mkdtemp(join(tmpdir(), "hub-provider-connections-"));
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

class FakeProviders {
  botToken = "xoxb-first";
  installationSuspended = false;
  chatTitle = "Acme ops";
  scopes: string[] = [...SLACK_REQUIRED_BOT_SCOPES];

  readonly applications: Partial<Record<Provider, ProviderApplicationConfiguration>> = {
    slack: {
      provider: "slack",
      transport: "socket",
      appId: "A-ACME",
      appToken: "xapp-acme",
    },
    telegram: { provider: "telegram", botToken: "telegram-token" },
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
    const url = requestUrl(input);
    if (url.pathname.endsWith("/auth.test")) {
      return Response.json(
        { ok: true, team_id: "T-ACME", team: "Acme", user_id: "U-BOT", bot_id: "B-ACME" },
        { headers: { "x-oauth-scopes": this.scopes.join(",") } },
      );
    }
    if (url.pathname.startsWith("/app/installations/")) {
      const installationId = url.pathname.split("/").at(-1);
      if (
        installationId !== "178294978" &&
        installationId !== "178294979" &&
        installationId !== "178294980"
      ) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({
        id: Number(installationId),
        account: { id: 42, login: "acme", type: "Organization" },
        suspended_at: this.installationSuspended ? "2026-11-26T00:00:00.000Z" : null,
      });
    }
    if (url.pathname.endsWith("/getMe")) {
      return Response.json({
        ok: true,
        result: { id: 9067, is_bot: true, first_name: "Bot", username: "acme_bot" },
      });
    }
    if (url.pathname.endsWith("/getChat")) {
      const body = z
        .object({ chat_id: z.union([z.string(), z.number()]) })
        .safeParse(parseBody(init?.body));
      if (!body.success || String(body.data.chat_id) !== "-1001") {
        return Response.json({ ok: false, description: "Bad Request: chat not found" });
      }
      return Response.json({
        ok: true,
        result: { id: -1001, type: "group", title: this.chatTitle },
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(input instanceof Request ? input.url : input);
}

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
