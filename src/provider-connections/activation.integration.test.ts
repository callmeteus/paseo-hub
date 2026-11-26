import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
      team_id: string;
      team_name: string;
      bot_user_id: string;
      bot_access_token: string;
      scopes: string[];
      provider_application_id: string;
    }>(
      "select team_id, team_name, bot_user_id, bot_access_token, scopes, provider_application_id from slack_connections",
    );
    assert.deepEqual(slack.rows, [
      {
        team_id: "T-ACME",
        team_name: "Acme",
        bot_user_id: "U-BOT",
        bot_access_token: "xoxb-first",
        scopes: [...SLACK_REQUIRED_BOT_SCOPES].sort(),
        provider_application_id: "A-ACME",
      },
    ]);

    const telegram = await database.query<{ chat_id: string; chat_name: string }>(
      "select chat_id, chat_name from telegram_connections",
    );
    assert.deepEqual(telegram.rows, [{ chat_id: "-1001", chat_name: "Acme ops" }]);

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
  };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith("/auth.test")) {
      return Response.json(
        { ok: true, team_id: "T-ACME", team: "Acme", user_id: "U-BOT", bot_id: "B-ACME" },
        { headers: { "x-oauth-scopes": this.scopes.join(",") } },
      );
    }
    if (url.endsWith("/getChat")) {
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
    throw new Error(`unexpected request ${url}`);
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
